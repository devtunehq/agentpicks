/** ABOUTME: Recognises credential values that span physical lines (YAML blocks, continued quotes, split JSON) while keeping line breaks and noncredential neighbours intact. */
export interface TraceCredentialState {
  kind: 'pending' | 'indent' | 'quote' | 'balanced' | 'opaque';
  indent: number;
  json: boolean;
  emitted: boolean;
  delimiter?: string;
  quote?: string;
  comment?: 'line' | 'block';
  commentBoundary?: boolean;
  escaped?: boolean;
  brackets?: string;
  opened?: boolean;
  header?: boolean;
}
/** A name whose value is a credential. */
export const sensitive =
  /key|token|secret|password|passwd|credential|auth|cookie|bearer/i;
/** A schema validator call, such as `z.string()`, which names a field without a value. */
export const validator = /^(?:z|yup|Joi)\.[A-Za-z_$][\w$]*\(/;
/** A `name=`, `name:`, `name =>` or `--option` and its separator; a fresh regex per scan. */
export const fieldPattern = () =>
  /(?<![\w.-])(["']?)(--[\w.-]+|[\w.-]+)\1([ \t]*(?:=>|=|:)[ \t]*|[ \t]+)/g;
/** Masks a value line by line, so redacted text keeps its line count. */
export const mask = (text: string) => text.replace(/[^\r\n]+/g, '[redacted]');
const newlineOnly = (text: string) => text.replace(/[^\r\n]/g, '');

/** State contains delimiters/indentation only, never the secret itself. JSONL records are handled by the decoded event walker. */
export function redactCredentialValues(
  text: string,
  initial: TraceCredentialState | null = null,
  skipJsonRecords = false,
) {
  let state = initial ? { ...initial } : null;
  let pos = 0;
  const output: string[] = [];
  const hide = (start: number, end: number) => {
    if (!state) throw new Error('Missing credential state');
    const value = text.slice(start, end);
    output.push(
      state.json
        ? (state.emitted ? '' : '"[redacted]"') + newlineOnly(value)
        : mask(value),
    );
    state.emitted = true;
    pos = end;
  };
  while (pos < text.length) {
    if (state?.kind === 'opaque') {
      hide(pos, text.length);
      break;
    }
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl < 0 ? text.length : nl + 1;
    if (state?.kind === 'pending') {
      const rest = text.slice(pos, lineEnd);
      const first = /\S/.exec(rest);
      if (!first) {
        output.push(rest);
        pos = lineEnd;
        continue;
      }
      const at = pos + first.index;
      const indent = /^[ \t]*/.exec(text.slice(lineStart, lineEnd))![0].length;
      if (
        !state.json &&
        indent <= state.indent &&
        /^[\w.-]+\s*(?:=>|=|:)/.test(text.slice(at, lineEnd))
      ) {
        state = null;
        continue;
      }
      output.push(text.slice(pos, at));
      pos = at;
      const ch = text[pos]!;
      if (ch === '"' || ch === "'" || ch === '`')
        state = {
          ...state,
          kind: 'quote',
          delimiter: text.startsWith(ch.repeat(3), pos) ? ch.repeat(3) : ch,
          opened: false,
        };
      else if (ch === '{' || ch === '[')
        state = {
          ...state,
          kind: 'balanced',
          brackets: '',
          quote: '',
          opened: false,
        };
      else if (!state.json && indent > state.indent)
        state = { ...state, kind: 'indent' };
      else {
        const end = state.json
          ? pos + (/^[^\s,}\]]+/.exec(text.slice(pos))?.[0].length ?? 1)
          : lineEnd;
        hide(pos, end);
        state = null;
        continue;
      }
    }
    if (state?.kind === 'indent') {
      const line = text.slice(pos, lineEnd);
      const indent = /^[ \t]*/.exec(text.slice(lineStart, lineEnd))![0].length;
      if (state.emitted && line.trim() && indent <= state.indent) {
        state = null;
        continue;
      }
      hide(pos, lineEnd);
      continue;
    }
    if (state?.kind === 'quote') {
      const start = pos,
        delimiter = state.delimiter!;
      let i = state.opened ? pos : pos + delimiter.length,
        done = false;
      for (; i < text.length; i++) {
        if (state.escaped) {
          state.escaped = false;
          continue;
        }
        if (text[i] === '\\') {
          state.escaped = true;
          continue;
        }
        if (text.startsWith(delimiter, i)) {
          i += delimiter.length;
          done = true;
          break;
        }
      }
      state.opened = true;
      hide(start, Math.min(i, text.length));
      if (done) state = null;
      continue;
    }
    if (state?.kind === 'balanced') {
      const start = pos;
      let i = pos,
        done = false;
      for (; i < text.length; i++) {
        const ch = text[i]!;
        if (state.comment) {
          if (state.comment === 'line' && ch === '\n')
            state.comment = undefined;
          else if (state.comment === 'block' && text.startsWith('*/', i)) {
            state.comment = undefined;
            i++;
          }
          continue;
        }
        if (state.quote) {
          if (state.escaped) state.escaped = false;
          else if (ch === '\\') state.escaped = true;
          else if (ch === state.quote) state.quote = '';
          continue;
        }
        if (
          (ch === '#' || text.startsWith('//', i)) &&
          (i > 0 ? /\s/.test(text[i - 1]!) : (state.commentBoundary ?? true))
        ) {
          state.comment = 'line';
          continue;
        }
        if (
          text.startsWith('/*', i) &&
          (i > 0 ? /\s/.test(text[i - 1]!) : (state.commentBoundary ?? true))
        ) {
          state.comment = 'block';
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          state.quote = ch;
          continue;
        }
        if (ch === '{' || ch === '[') {
          state.brackets = (state.brackets ?? '') + ch;
          if (state.brackets.length > 128) {
            state.kind = 'opaque';
            i = text.length;
            break;
          }
        } else if (
          (ch === '}' && state.brackets?.endsWith('{')) ||
          (ch === ']' && state.brackets?.endsWith('['))
        ) {
          state.brackets = state.brackets!.slice(0, -1);
          if (!state.brackets) {
            i++;
            done = true;
            break;
          }
        }
      }
      state.commentBoundary = /\s/.test(text[i - 1] ?? '');
      hide(start, i);
      if (done) state = null;
      continue;
    }
    const line = text.slice(pos, lineEnd);
    if (skipJsonRecords && pos === lineStart) {
      try {
        JSON.parse(line);
        output.push(line);
        pos = lineEnd;
        continue;
      } catch {
        /* A plaintext line can open a continued value. */
      }
    }
    const fields = fieldPattern();
    let chosen: RegExpExecArray | null = null;
    for (let match = fields.exec(line); match; match = fields.exec(line)) {
      const name = match[2]!,
        separator = match[3]!;
      if (
        !sensitive.test(name) ||
        (!separator.trim() && !name.startsWith('--'))
      )
        continue;
      const value = line.slice(fields.lastIndex);
      if (
        !name.startsWith('--') &&
        (validator.test(value) ||
          (name.toLowerCase() === 'key' && /^id\b/.test(value)))
      )
        continue;
      chosen = match;
      break;
    }
    if (!chosen) {
      output.push(line);
      pos = lineEnd;
      continue;
    }
    const at = pos + chosen.index + chosen[0].length;
    const indent = /^[ \t]*/.exec(text.slice(lineStart, lineEnd))![0].length;
    const json = chosen[1] === '"' && chosen[3]!.includes(':');
    const tail = text.slice(at, lineEnd).replace(/[\r\n]+$/, '');
    const base = { indent, json, emitted: false };
    if (!tail.trim()) {
      output.push(text.slice(pos, lineEnd));
      pos = lineEnd;
      state = { ...base, kind: 'pending' };
      continue;
    }
    const ch = text[at]!;
    const block = /^[|>][+\-0-9]*(?:[ \t]*(?:#.*)?)?$/.test(tail);
    const delimiter =
      ch === '"' || ch === "'" || ch === '`'
        ? text.startsWith(ch.repeat(3), at)
          ? ch.repeat(3)
          : ch
        : null;
    let unfinishedQuote = false;
    if (delimiter) {
      let escaped = false,
        closed = false;
      for (let i = at + delimiter.length; i < lineEnd; i++) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (text[i] === '\\') {
          escaped = true;
          continue;
        }
        if (text.startsWith(delimiter, i)) {
          closed = true;
          break;
        }
      }
      unfinishedQuote = !closed;
    }
    if (
      block ||
      (chosen[3]!.includes(':') &&
        !chosen[1] &&
        !delimiter &&
        ch !== '{' &&
        ch !== '[')
    ) {
      output.push(text.slice(pos, at));
      pos = at;
      state = { ...base, kind: 'indent' };
      hide(pos, lineEnd);
      continue;
    }
    if (delimiter && (json || unfinishedQuote || delimiter.length === 3)) {
      output.push(text.slice(pos, at));
      pos = at;
      state = { ...base, kind: 'quote', delimiter, opened: false };
      continue;
    }
    if (ch === '{' || ch === '[') {
      output.push(text.slice(pos, at));
      pos = at;
      state = { ...base, kind: 'balanced', brackets: '', quote: '' };
      continue;
    }
    if (json) {
      const len = /^[^\s,}\]]+/.exec(text.slice(at))?.[0].length ?? 1;
      output.push(text.slice(pos, at));
      pos = at;
      state = { ...base, kind: 'pending' };
      hide(pos, at + len);
      state = null;
      continue;
    }
    // The ordinary single-line literal/CLI reader handles this value.
    output.push(text.slice(pos, at));
    pos = at;
  }
  return { text: output.join(''), state };
}
