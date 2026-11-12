/**
 * ABOUTME: Finds the secret values a run wrote itself (an `AUTH_SECRET` it generated into
 * `.env.local`, a key in a config file), which no credential list knows and no provider shape
 * matches, so redaction can mask them by value in every artifact. Reads each line by its grammar:
 * a dotenv or shell assignment, whose value is literal; and in YAML or source, a `name: value` at
 * a line's start or a quoted string assigned to a name anywhere, whose value must also read as a
 * secret rather than code or prose. A value counts when its name is secret-like, it is at least
 * 12 characters, and it is not a number, a placeholder or a reference to somewhere else.
 */

/** Words that make any name secret. */
const SECRET_WORD = /secret|token|password|passwd|private|credential|dsn/i;

/** In a lower- or camel-case name, a key that is a credential (`apiKey`, `signing_key`). */
const CREDENTIAL_KEY =
  /(?:api|secret|private|access|signing|encryption|client|master|service|license|webhook|hmac|auth)_?key/i;

/**
 * Whether a name's value is a secret: one with a secret word, or with KEY in an upper-case
 * environment-style name (`STRIPE_KEY`); a lower- or camel-case `key` counts only as a
 * credential key, so `idempotencyKey` and `cacheKey` do not.
 */
function isSecretName(name: string): boolean {
  if (SECRET_WORD.test(name)) return true;
  return /^[A-Z0-9_]+$/.test(name)
    ? name.includes('KEY')
    : CREDENTIAL_KEY.test(name);
}

/** A name: an identifier, never a path or a package (`src/lib/token.ts`, `@auth/core`). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MIN_LENGTH = 12;

/**
 * `[export ]NAME=value`, dotenv or shell, after any diff marker: unindented, or indented only
 * after `export`, since an indented `name=value` is a keyword argument in source. The value
 * starts right after `=`; whitespace there makes it an empty assignment
 * (`SENTRY_DSN= .venv/bin/python` runs a command with SENTRY_DSN empty).
 */
const SHELL_LINE =
  /^[+\- ]?(?:[ \t]*export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * A dotenv line, in content known to be a dotenv file: dotenv allows whitespace around `=`
 * (`KEY = value`) and before the line, and takes the value to the line's end less any comment.
 */
const DOTENV_LINE =
  /^[+\- ]?[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

/**
 * An upper-case `NAME=value` inside a command line (`echo "AUTH_SECRET=…" >> .env.local`,
 * `docker run -e DB_PASSWORD=…`), the value again starting right after `=`.
 */
const SHELL_WORD =
  /(?<=[\s"'`;&|(])([A-Z][A-Z0-9_]*)=(?:"((?:\\.|[^"\\\r\n])*)"|'([^'\r\n]*)'|([^\s"'`;&|()<>]+))/g;

/** `NAME: value` at a line's start, after any diff marker or list dash: YAML, or a property in source. */
const KEY_LINE =
  /^[+\- ]?[ \t]*(?:-[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]+(.+)$/;

/**
 * A name, quoted or not, assigned a quoted string anywhere in a line: JSON, source, keyword
 * arguments. The name may not continue a path, package or member (`eslint-visitor-keys:`,
 * `x.apiKey`); `==` and `=>` are not assignments.
 */
const QUOTED =
  /(?<![\w./@$\\]|[\w.]-)(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*(?:=(?![=>])|:)[ \t]*(["'`])((?:\\.|(?!\3)[^\\\r\n])*)\3/g;

/** A value that stands in for a secret rather than being one. */
const PLACEHOLDER =
  /your[-_]|example|placeholder|changeme|change[-_](?:me|this)|replace|redacted|xxxx|dummy|sample|todo|insert[-_]|[-_]here\b|\.\.\.|\*\*\*|[<>]/i;

/** A value read from somewhere else: `$VAR`, `${…}`, `$(…)`, `{{ … }}`, `process.env.…`, `os.environ[…]`. */
const REFERENCE =
  /^\$|\$\{|\{\{|process\.env|import\.meta\.env|os\.environ|getenv|\bENV\[|^env\./i;

/** A secret's value as written and as it reads once its escapes are decoded. */
interface Literal {
  raw: string;
  decoded: string;
}

/** Decodes backslash escapes: `\n`, `\t` and `\r` are their characters; `\x` is `x`. */
function unescape(raw: string): string {
  return raw.replace(/\\([\s\S])/g, (_whole, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char,
  );
}

/**
 * Adds the literal when it is a secret. A URL's secret is its credentials, never its host: only
 * the password (or a user name with none, as a DSN's key is) of `scheme://user:pass@host`.
 * `code` marks a value in YAML or source rather than dotenv or shell, which must also read as a
 * secret: one word (`"wrong password"` and `str | None` are not), not a digit-free word or
 * identifier that reads as words (`'Authorization'`, `"auth_session"`, `must-not-be-stored`), and not an environment
 * variable's name (`"SENTRY_AUTH_TOKEN"` refers to the value).
 */
function addLiteral(literal: Literal, code: boolean, found: Set<string>) {
  // A value never spans a line break: one its escapes decode to is taken line by line.
  if (/[\r\n]/.test(literal.decoded)) {
    for (const line of literal.decoded.split(/\r\n|\r|\n/))
      addLiteral({ raw: line, decoded: line }, code, found);
    return;
  }
  // A PEM key's BEGIN and END lines are labels, not secrets.
  if (/^-----(?:BEGIN|END) [A-Z0-9 ]+-----$/.test(literal.decoded)) return;
  const url = literal.decoded.match(/^[A-Za-z][\w+.-]*:\/\/([^/@\s]*)@/);
  if (url) {
    const userinfo = url[1]!;
    const secret = userinfo.slice(userinfo.indexOf(':') + 1);
    if (isSecret(secret)) found.add(secret);
    return;
  }
  if (/^[A-Za-z][\w+.-]*:\/\//.test(literal.decoded)) return;
  if (!isSecret(literal.decoded)) return;
  if (
    code &&
    (/\s/.test(literal.decoded) ||
      readsAsWords(literal.decoded) ||
      /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(literal.decoded))
  )
    return;
  found.add(literal.decoded);
  found.add(literal.raw);
}

/**
 * A word in camel, Pascal, snake or kebab case: each letter run is lower case, upper case, or
 * capitalised words (`Authorization`, `auth_session`, `sessionTokenValue`). A letters-only
 * credential (`QwErTyUiOpAsDf`) mixes case mid-word, so it does not read as words.
 */
const WORD_PART = /^(?:[a-z]+|[A-Z]+|[A-Z]?[a-z]+(?:[A-Z][a-z]{2,})*)$/;

/** Whether a digit-free identifier, dotted path or kebab string reads as words rather than a credential. */
function readsAsWords(value: string): boolean {
  if (/\d/.test(value) || !/^[A-Za-z_$][\w$.-]*$/.test(value)) return false;
  return value
    .split(/[_$.-]+/)
    .filter(Boolean)
    .every((part) => WORD_PART.test(part));
}

function isSecret(value: string): boolean {
  return (
    value.length >= MIN_LENGTH &&
    !/^[\d.,_-]+$/.test(value) &&
    !PLACEHOLDER.test(value) &&
    !REFERENCE.test(value)
  );
}

/** A quoted string opening a value, closed on its line, by its opening quote. */
const QUOTED_VALUE = {
  '"': /^"((?:\\.|[^"\\\r\n])*)"/,
  '`': /^`((?:\\.|[^`\\\r\n])*)`/,
  "'": /^'([^'\r\n]*)'/,
} as const;

/** A quoted string at the start of `text`, with its escapes decoded; null when there is none. */
function quoted(text: string): Literal | null {
  const quote = text[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  const raw = text.match(QUOTED_VALUE[quote])?.[1];
  if (raw === undefined) return null;
  // Single quotes are literal in shell, dotenv and YAML.
  return { raw, decoded: quote === "'" ? raw : unescape(raw) };
}

/** A dotenv or shell value: quoted, or bare up to the first unescaped whitespace. */
function shellValue(rest: string): Literal | null {
  if (!rest || /^\s/.test(rest)) return null;
  const string = quoted(rest);
  if (string) return string;
  // A quote left open on its line belongs to text this line cannot read.
  if (/^["'`]/.test(rest)) return null;
  const raw = rest.match(/^(?:\\.|[^\s\\])+/)?.[0];
  return raw ? { raw, decoded: unescape(raw) } : null;
}

/** A dotenv value: quoted, or bare to the line's end less any ` #` comment; empty is none. */
function dotenvValue(rest: string): Literal | null {
  const string = quoted(rest);
  if (string) return string;
  const bare = rest.replace(/[ \t]+#.*$/, '').trim();
  return bare ? { raw: bare, decoded: bare } : null;
}

/**
 * A YAML or source value at a line's start: quoted, or bare to the line's end less any comment.
 * A bare value that ends like source (`,`, `;`) or holds brackets (a call, an object, an index)
 * is code, not a literal; `addLiteral` judges the rest.
 */
function keyValue(rest: string): Literal | null {
  const string = quoted(rest);
  if (string) return string;
  if (/^["'`]/.test(rest)) return null;
  const bare = rest.replace(/[ \t]+#.*$/, '').trim();
  if (/[,;]$|[{}[\]()]/.test(bare)) return null;
  return { raw: bare, decoded: bare };
}

/** Whether a path names a dotenv file (`.env`, `.env.local`). */
function isDotenvPath(path: string): boolean {
  return (path.split('/').at(-1) ?? '').startsWith('.env');
}

/** Where a line sits: in a dotenv file's content, or in a diff section under a dotenv file. */
interface Section {
  dotenv: boolean;
  /** In a diff, whose lines start with a `+`, `-` or space marker. */
  diff?: boolean;
  /** The quote a dotenv value left open, which later lines continue until it closes. */
  quote?: string;
}

/** The secret values assigned in a text, line by line; `dotenv` when the text is a dotenv file. */
function textSecrets(text: string, found: Set<string>, dotenv = false): void {
  const section = { dotenv };
  for (const line of text.split(/\r?\n/)) lineSecrets(line, found, section);
}

/** The secret values one line assigns, by its grammar; a diff's `+++ b/<path>` header starts a section. */
function lineSecrets(line: string, found: Set<string>, section: Section) {
  const header = line.match(/^\+\+\+ (?:b\/)?(\S+)/);
  if (header) {
    section.dotenv = isDotenvPath(header[1]!);
    section.diff = true;
    section.quote = undefined;
    return;
  }
  if (section.dotenv && section.quote) {
    // A dotenv value open across lines is taken a line at a time, never as one block.
    const body = section.diff ? line.slice(1) : line;
    const end = body.indexOf(section.quote);
    const piece = end < 0 ? body : body.slice(0, end);
    if (end >= 0) section.quote = undefined;
    addLiteral({ raw: piece, decoded: piece }, false, found);
    return;
  }
  if (section.dotenv) {
    const entry = line.match(DOTENV_LINE);
    if (entry) {
      const rest = entry[2]!;
      const open = /^["']/.test(rest) && !quoted(rest);
      if (open) section.quote = rest[0];
      if (isSecretName(entry[1]!)) {
        const value = open
          ? { raw: rest.slice(1), decoded: rest.slice(1) }
          : dotenvValue(rest);
        if (value) addLiteral(value, false, found);
      } else if (open) section.quote = undefined;
      return;
    }
  }
  // A line quoted in Markdown (`> AUTH_SECRET=…` in an agent's message) is read without its `>`s.
  line = line.replace(/^[ \t]*(?:>[ \t]?)+/, '');
  const shell = line.match(SHELL_LINE);
  if (shell) {
    if (isSecretName(shell[1]!)) {
      const value = shellValue(shell[2]!);
      if (value) addLiteral(value, false, found);
    }
    return;
  }
  for (const match of line.matchAll(SHELL_WORD)) {
    if (!isSecretName(match[1]!)) continue;
    const [, , double, single, bare] = match;
    const raw = double ?? single ?? bare!;
    addLiteral(
      { raw, decoded: single === undefined ? unescape(raw) : raw },
      false,
      found,
    );
  }
  const key = line.match(KEY_LINE);
  if (key && isSecretName(key[1]!)) {
    const value = keyValue(key[2]!);
    if (value) addLiteral(value, true, found);
  }
  for (const match of line.matchAll(QUOTED)) {
    if (!isSecretName(match[2]!)) continue;
    addLiteral({ raw: match[4]!, decoded: unescape(match[4]!) }, true, found);
  }
}

/**
 * Walks decoded JSON: every string is read as text, and a secret-named member's string is a
 * value. The strings of a file tool's input (Write, Edit) whose `file_path` is a dotenv file are
 * read as dotenv.
 */
function jsonSecrets(value: unknown, found: Set<string>, dotenv = false): void {
  if (typeof value === 'string') return textSecrets(value, found, dotenv);
  if (Array.isArray(value))
    return value.forEach((item) => jsonSecrets(item, found, dotenv));
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const file =
    typeof record.file_path === 'string' && isDotenvPath(record.file_path);
  for (const [key, item] of Object.entries(record)) {
    if (IDENTIFIER.test(key) && isSecretName(key) && typeof item === 'string')
      addLiteral({ raw: item, decoded: item }, true, found);
    jsonSecrets(item, found, dotenv || file);
  }
}

function parseJson(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/**
 * A secret as it appears serialized into JSON up to three levels deep (a transcript line holding
 * a tool result that holds a JSON document): the value, then each JSON-string escape of the
 * last. Masking these forms in the text as it is leaves every other byte unchanged.
 */
export function escapedForms(value: string): string[] {
  const forms = [value];
  for (let level = 0; level < 3; level++)
    forms.push(JSON.stringify(forms.at(-1)).slice(1, -1));
  return [...new Set(forms)];
}

/**
 * Every secret value the texts assign, as written and as decoded. A JSON document, or each JSON
 * line of a JSONL file, is decoded first, so an `.env` file written through an agent's file tool
 * is read line by line rather than as escaped JSON; any other line is read as it is.
 */
export function writtenSecrets(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    const whole = parseJson(text);
    if (whole) {
      jsonSecrets(whole.value, found);
      continue;
    }
    const section = { dotenv: false };
    for (const line of text.split(/\r?\n/)) {
      const record = line.trimStart().startsWith('{') ? parseJson(line) : null;
      if (record) jsonSecrets(record.value, found);
      else lineSecrets(line, found, section);
    }
  }
  return [...found];
}
