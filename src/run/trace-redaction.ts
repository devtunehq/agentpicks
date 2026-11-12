/**
 * ABOUTME: Scrubs a run's trace text on the server before it is broadcast or stored: first the
 * run's own secrets exactly (and their encoded forms), then credential-bearing structures,
 * then the pinned gitleaks signatures and the model proxy's token shape. Artifacts a reader
 * still parses (a diff, a transcript's token counts) take the value-based rules only.
 */
import { RE2JS } from 're2js';

import { redactModelProxyTokens } from './model-proxy-token';
import {
  fieldPattern,
  mask,
  redactCredentialValues,
  sensitive,
  validator,
} from './trace-credentials';
import { GITLEAKS_RULES } from './trace-rules.generated';
import { traceJson, traceString } from './trace-text';

type Signature = (typeof GITLEAKS_RULES)[number] & { pattern: RE2JS };
let compiledSignatures: Signature[] | undefined;

/**
 * The gitleaks rules, compiled on first use: compiling all of them takes tens of
 * milliseconds, which every importer of this package would otherwise pay at load.
 */
const signatures = () =>
  (compiledSignatures ??= GITLEAKS_RULES.map((rule) => ({
    ...rule,
    pattern: RE2JS.compile(rule.regex),
  })));

/**
 * The run's secret values: provider keys, the proxy token and any other value the runner
 * dispatched to the sandbox. Values under eight characters are ignored, as main's redactor does.
 */
export type TraceSecrets = Record<string, string | null | undefined>;

/**
 * The MySQL and MariaDB clients and tools: in these `-p` takes a password. Not psql, where
 * `-p` is the port. A command ends at an unquoted shell separator or a line break that
 * a trailing backslash does not continue. An attached `-p` value is consumed first, up to
 * whitespace, so a separator inside a password cannot expose its suffix.
 */
const databaseTool = String.raw`(?:mysql\w*|mariadb[\w-]*)`;
const databaseCommandText = new RegExp(
  String.raw`\b${databaseTool}\b(?:(?<=\s|\\n)-p(?:"(?:\\.|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\s;"'\\]|\\[^\r\n])+|\\\r?\n|\\[^\r\n]|"(?:\\.|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\r\n;|&"'\\])*`,
  'g',
);
const databaseBinary = new RegExp(String.raw`(?:^|\/)${databaseTool}$`);

const base64Run = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
const proxyTokenShape = /apm1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

/**
 * Masks a base64 or base64url run that decodes to text holding a model proxy token, for a
 * caller that cannot supply the exact token (a release reading a run's sandbox).
 */
function redactEncodedProxyTokens(text: string) {
  return text.replace(base64Run, (run) =>
    proxyTokenShape.test(Buffer.from(run, 'base64').toString('latin1'))
      ? mask(run)
      : run,
  );
}

/**
 * The characters of a value's base64 and base64url encodings that do not depend on what
 * surrounds it, at each of the three byte alignments it can sit at inside a longer encoded
 * text. A secret printed base64-encoded, alone or within other bytes, holds one of these.
 */
function alignedBase64(value: string): string[] {
  const bytes = Buffer.from(value);
  return [0, 1, 2].flatMap((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]);
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    return [
      encoded.toString('base64').slice(start, end),
      encoded.toString('base64url').slice(start, end),
    ];
  });
}

const base64Char = /[A-Za-z0-9+/_=-]/;
/** A run of base64 characters, possibly broken by whitespace (wrapped at 76 columns, say). */
const wrappedBase64Run =
  /[A-Za-z0-9+/_-](?:[A-Za-z0-9+/_=-]|\s)*[A-Za-z0-9+/_=-]/g;

/**
 * Masks every span of `text` that holds one of `cores` once the whitespace inside a base64
 * run is removed, mapping each match back to the original characters it covers.
 */
function redactWrappedBase64(text: string, cores: readonly string[]) {
  if (!cores.length) return text;
  const shortest = cores.at(-1)!.length;
  return text.replace(wrappedBase64Run, (run) => {
    if (run.length < shortest) return run;
    const at: number[] = [];
    const kept: string[] = [];
    for (let i = 0; i < run.length; i++) {
      const code = run.charCodeAt(i);
      // Whitespace is the only thing in a run besides base64 characters.
      if (code > 32) {
        at.push(i);
        kept.push(run[i]!);
      }
    }
    const compact = kept.join('');
    const spans: [number, number][] = [];
    for (const core of cores)
      for (
        let found = compact.indexOf(core);
        found >= 0;
        found = compact.indexOf(core, found + core.length)
      ) {
        // Out to the encoded word's ends, so no part of the blob stays decodable.
        let start = at[found]!;
        let stop = at[found + core.length - 1]! + 1;
        while (start > 0 && base64Char.test(run[start - 1]!)) start--;
        while (stop < run.length && base64Char.test(run[stop]!)) stop++;
        spans.push([start, stop]);
      }
    if (!spans.length) return run;
    spans.sort((a, b) => a[0] - b[0]);
    let out = '';
    let end = 0;
    for (const [start, stop] of spans) {
      if (stop <= end) continue;
      const from = Math.max(start, end);
      out += run.slice(end, from) + mask(run.slice(from, stop));
      end = stop;
    }
    return out + run.slice(end);
  });
}

/** Masks every PEM private key block, to its end or the end of the text. */
function maskPrivateKeys(text: string) {
  return text.replace(
    /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
    (match) => mask(match),
  );
}

/**
 * Masks every PEM private key block in one bounded text (a JSON string's content, or the lines
 * between JSON lines): to its END marker, of any label (documentation elides `BEGIN RSA … END
 * DSA`), or, for a key cut short (`head -n 20 key.pem`), to the first blank line or the end of
 * that text, never further.
 */
function maskBoundedPrivateKeys(text: string) {
  return text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?=\n[ \t]*\n)|$)/g,
    (match) => mask(match),
  );
}

/** A JSON value's shape: its keys and kinds of value, without the values. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shape(item)]),
    );
  return typeof value;
}

function parsed(line: string): { value: unknown } | null {
  const start = line.trimStart()[0];
  if (start !== '{' && start !== '[') return null;
  try {
    return { value: JSON.parse(line) };
  } catch {
    return null;
  }
}

/**
 * Applies `rule` to one JSON line so that it still parses: to the whole line when that keeps its
 * shape (a signature may need a member's name beside its value), otherwise to each string, key or
 * value, alone, masking a string whole when its masked text would not parse.
 */
function maskJsonLine(
  line: string,
  before: unknown,
  rule: (text: string) => string,
): string {
  const whole = rule(line);
  if (whole === line) return line;
  const after = parsed(whole);
  if (
    after &&
    JSON.stringify(shape(after.value)) === JSON.stringify(shape(before))
  )
    return whole;
  return line.replace(
    /"((?:[^"\\]|\\.)*)"(\s*:)?/g,
    (token, content: string, colon = '') => {
      const masked = rule(content);
      if (masked === content) return token;
      return (parsed(`["${masked}"]`) ? `"${masked}"` : '"[redacted]"') + colon;
    },
  );
}

/** Masks the credentials in a URL's userinfo (`https://user:pass@host`), keeping the user name. */
function maskUrlCredentials(text: string) {
  return text.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@]*?)@/g,
    (_whole, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(':');
      return `${scheme}${colon >= 0 ? userinfo.slice(0, colon + 1) : ''}[redacted]@`;
    },
  );
}

/**
 * Values are supplied by the runner, never inferred from the spelling of a secret. With
 * `names: false`, for an artifact a reader still parses, it applies only the rules that read a
 * value itself: the run's secrets and their encodings, private keys within their text, URL
 * credentials, the pinned signatures and the proxy-token shape, and keeps every JSON line
 * parsing with its keys. It then leaves alone what follows a credential-like name (`input_tokens`, a
 * `process.env.SENTRY_AUTH_TOKEN` reference, the `eslint-visitor-keys` package, the line after
 * an empty `TOKEN=`), which the name-based rules mask in a trace and an artifact's reader needs.
 */
export function createTraceRedactor(
  secrets: TraceSecrets,
  { names = true }: { names?: boolean } = {},
) {
  const values = Object.values(secrets).filter(
    (value): value is string => typeof value === 'string' && value.length >= 8,
  );
  const base64Cores = [
    ...new Set(
      values.flatMap(alignedBase64).filter((core) => core.length >= 16),
    ),
  ].sort((a, b) => b.length - a.length);
  const variants = [
    ...new Set(
      values.flatMap((value) => [
        value,
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1),
        Buffer.from(value).toString('base64'),
        Buffer.from(value).toString('base64url'),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  const exact = (text: string) =>
    redactWrappedBase64(
      variants.reduce((out, value) => out.split(value).join(mask(value)), text),
      base64Cores,
    );

  const structure = (text: string) => {
    text = maskPrivateKeys(text);
    // Consume values only after a sensitive name. Unrelated labels cannot hide nested fields.
    const fields = fieldPattern();
    // A backtick literal (a template string) may span lines; the others end with theirs.
    const literal =
      /"(?:\\.|[^"\\\r\n])*(?:"|(?=[\r\n]|$))|'[^'\r\n]*(?:'|(?=[\r\n]|$))|`(?:\\[\s\S]|[^`\\])*(?:`|$)|[^\s\])}]+/y;
    const optionValue =
      /(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\\[\s\S]|[^\s;"'\\&|<>])+/y;
    const header = /[^\r\n]+/y;
    let end = 0;
    const parts: string[] = [];
    for (let field = fields.exec(text); field; field = fields.exec(text)) {
      if (
        !sensitive.test(field[2]!) ||
        (!field[3]!.trim() && !field[2]!.startsWith('--'))
      )
        continue;
      const start = fields.lastIndex;
      if (
        !field[2]!.startsWith('--') &&
        (validator.test(text.slice(start, start + 100)) ||
          (field[2]!.toLowerCase() === 'key' &&
            /^id\b/.test(text.slice(start, start + 3))))
      )
        continue;
      if (
        text.startsWith('[redacted]', start) ||
        text.startsWith('"[redacted]"', start)
      )
        continue;
      // An unquoted env-file assignment (`API_KEY=two words`) holds the rest of its line.
      const envLine =
        !field[1] &&
        /^[A-Z][A-Z0-9_]*$/.test(field[2]!) &&
        /^[ \t]*=[ \t]*$/.test(field[3]!) &&
        !/^["'`]/.test(text.slice(start)) &&
        /^[ \t]*(?:export[ \t]+)?$/.test(
          text.slice(text.lastIndexOf('\n', field.index - 1) + 1, field.index),
        );
      const reader = field[2]!.startsWith('--')
        ? optionValue
        : (field[3]!.includes(':') && !field[1]) || envLine
          ? header
          : literal;
      reader.lastIndex = start;
      if (!reader.exec(text)) continue;
      parts.push(
        text.slice(end, start),
        mask(text.slice(start, reader.lastIndex)),
      );
      end = reader.lastIndex;
      fields.lastIndex = end;
    }
    let safe = parts.length ? parts.join('') + text.slice(end) : text;
    // The short password option is meaningful only inside a MySQL command. It may follow a
    // continued line, raw or JSON-escaped (`\n`).
    safe = safe.replace(databaseCommandText, (command) =>
      command.replace(
        /(^|\s|\\n)(-p)((?:[ \t]|\\\r?\n)*)((?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;])+)/g,
        (
          whole,
          space: string,
          flag: string,
          separator: string,
          value: string,
        ) =>
          value === '[redacted]'
            ? whole
            : `${space}${flag}${separator}[redacted]`,
      ),
    );
    safe = safe.replace(/\bcurl\b[^\r\n;]*/g, (command) => {
      const options =
        /(^|\s)(--(?:proxy-)?user(?:=|[ \t]+)|-[uU](?:=|[ \t]+)?)/g;
      const parts: string[] = [];
      let end = 0;
      for (
        let option = options.exec(command);
        option;
        option = options.exec(command)
      ) {
        const start = options.lastIndex;
        optionValue.lastIndex = start;
        if (!optionValue.exec(command)) continue;
        parts.push(command.slice(end, start), '[redacted]');
        end = optionValue.lastIndex;
        options.lastIndex = end;
      }
      return parts.length ? parts.join('') + command.slice(end) : command;
    });
    return maskUrlCredentials(safe);
  };
  /**
   * The pinned signatures and the proxy-token shape over a whole text. Run over serialized
   * JSON too, so a rule that needs a field's name beside its value still matches.
   */
  const sign = (text: string) => {
    let safe = redactEncodedProxyTokens(redactModelProxyTokens(text));
    const lower = safe.toLowerCase();
    for (const rule of signatures()) {
      if (
        rule.keywords.length &&
        !rule.keywords.some((word) => lower.includes(word))
      )
        continue;
      const matcher = rule.pattern.matcher(safe);
      const spans: [number, number][] = [];
      while (matcher.find()) {
        // Gitleaks names the group holding the secret (its secretGroup, else the first);
        // masking only that keeps a field name and any JSON around it intact.
        const configured =
          'secretGroup' in rule ? (rule.secretGroup as number) : 1;
        const group =
          matcher.groupCount() >= configured &&
          matcher.group(configured) !== null
            ? configured
            : 0;
        const match = matcher.group(group)!;
        const leading = match.match(/^[\s'"`]+/)?.[0].length ?? 0;
        const trailing = match.match(/[\s'"`;]+$/)?.[0].length ?? 0;
        if (match.length > leading + trailing)
          spans.push([
            matcher.start(group) + leading,
            matcher.end(group) - trailing,
          ]);
      }
      for (let i = spans.length - 1; i >= 0; i--) {
        const [start, end] = spans[i]!;
        safe =
          safe.slice(0, start) + mask(safe.slice(start, end)) + safe.slice(end);
      }
    }
    return safe;
  };
  if (!names) {
    const valueRules = (text: string) =>
      sign(maskUrlCredentials(maskBoundedPrivateKeys(exact(text))));
    // A JSON line is masked so it still parses with its keys; the lines between JSON lines are
    // masked together, so a private key spanning them is found.
    return (input: string) => {
      const out: string[] = [];
      let plain: string[] = [];
      const flush = () => {
        if (plain.length) out.push(valueRules(plain.join('\n')));
        plain = [];
      };
      for (const line of traceString(input).split('\n')) {
        const json = parsed(line);
        if (!json) {
          plain.push(line);
          continue;
        }
        flush();
        out.push(maskJsonLine(line, json.value, valueRules));
      }
      flush();
      return out.join('\n');
    };
  }
  // Inputs are already sanitised (see the returned function): removing a character after a
  // pass could rejoin a secret that pass saw split.
  const scrub = (text: string) =>
    sign(structure(exact(redactCredentialValues(text).text)));
  const visit = (value: unknown, depth = 0): unknown => {
    if (depth > 128) throw new Error('Trace redaction nesting limit');
    if (typeof value === 'string') {
      if (variants.includes(value)) return mask(value);
      let decoded: unknown;
      try {
        decoded = JSON.parse(value);
      } catch {
        return scrub(value);
      }
      if (decoded && typeof decoded === 'object') {
        const redacted = visit(traceJson(decoded), depth + 1);
        if (JSON.stringify(decoded) !== JSON.stringify(redacted))
          return sign(JSON.stringify(redacted));
        const known = exact(value);
        return known === value ? sign(value) : scrub(known);
      }
      return scrub(value);
    }
    if (Array.isArray(value)) {
      let databaseCommand = false,
        curlCommand = false;
      return value.map((item, index) => {
        const previous = value[index - 1];
        const credentialOption =
          typeof previous === 'string' &&
          ((/^--[\w.-]+$/.test(previous) && sensitive.test(previous)) ||
            (databaseCommand && previous === '-p') ||
            (curlCommand && /^(?:--(?:proxy-)?user|-[uU])$/.test(previous)));
        if (typeof item === 'string' && databaseBinary.test(item))
          databaseCommand = true;
        if (typeof item === 'string' && /(?:^|\/)curl$/.test(item))
          curlCommand = true;
        if (databaseCommand && typeof item === 'string' && /^-p.+/.test(item))
          return '-p[redacted]';
        if (
          curlCommand &&
          typeof item === 'string' &&
          /^(?:--(?:proxy-)?user=|-[uU]=?).+/.test(item)
        )
          return item.replace(
            /^(--(?:proxy-)?user=|-[uU]=?).+/,
            '$1[redacted]',
          );
        return credentialOption ? '[redacted]' : visit(item, depth + 1);
      });
    }
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          scrub(key),
          sensitive.test(key) ? '[redacted]' : visit(item, depth + 1),
        ]),
      );
    return value;
  };
  /**
   * Sanitises first, then redacts: NULs and unpaired surrogates, which Postgres cannot
   * store, are removed from the text and from every decoded JSON string and key before any
   * redaction pass sees them.
   */
  return (input: string) => {
    const text = traceString(input);
    const safe: string[] = [],
      plain: string[] = [];
    const flush = () => {
      if (plain.length) {
        safe.push(scrub(plain.join('\n')));
        plain.length = 0;
      }
    };
    for (const line of redactCredentialValues(text, null, true).text.split(
      '\n',
    )) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        plain.push(line);
        continue;
      }
      flush();
      try {
        const redacted = visit(traceJson(decoded));
        const walked =
          JSON.stringify(decoded) === JSON.stringify(redacted)
            ? line
            : JSON.stringify(redacted);
        const signed = sign(walked);
        // A mask that split the record's JSON omits the record rather than keep its text.
        if (signed !== walked) JSON.parse(signed);
        safe.push(signed);
      } catch {
        safe.push(
          JSON.stringify({
            type: 'error',
            message: 'Trace record omitted: redaction failed',
          }),
        );
      }
    }
    flush();
    return safe.join('\n');
  };
}

export function redactTrace(text: string, secrets: TraceSecrets): string {
  return createTraceRedactor(secrets)(text);
}
