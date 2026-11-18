/**
 * ABOUTME: Says why a failed agent stopped, for the lines under "Failed at agent": the error its
 * transcript's last event names, else its stderr's last lines, each redacted after decoding.
 */
import type { RunArtifacts } from '../run/sandbox-run';

/**
 * Why a failed agent stopped, from what it left behind: the error its transcript's last event
 * names (where Claude Code and Codex report API errors), else the last lines of its stderr, else
 * that last event as it is. `redact` runs on each text after JSON decoding and before the cut, so
 * a secret the artifacts held escaped, or one a cut would split, is still masked.
 */
export function agentLastWords(
  artifacts: RunArtifacts,
  redact: (text: string) => string,
): string[] {
  const lines = (name: 'agent.err' | 'transcript.jsonl') =>
    (artifacts[name] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const cut = (text: string) => {
    const line = redact(text);
    return `    ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`;
  };
  const last = lines('transcript.jsonl').at(-1);
  const named = last && eventError(last);
  if (named) return ['  The agent’s last error:', cut(named)];
  const stderr = lines('agent.err').slice(-5);
  if (stderr.length)
    return ['  The agent’s last error output:', ...stderr.map(cut)];
  return last ? ['  The agent’s last transcript event:', cut(last)] : [];
}

/**
 * The error one transcript event names, or null: Claude Code's failed `result`, or an `error`
 * or `message` as Codex writes them.
 */
function eventError(line: string): string | null {
  let event: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object') return null;
    event = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const { error } = event;
  if (event.is_error === true && typeof event.result === 'string')
    return event.result;
  if (typeof error === 'string') return error;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message;
  return typeof event.message === 'string' ? event.message : null;
}
