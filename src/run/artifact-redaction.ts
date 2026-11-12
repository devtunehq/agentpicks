/**
 * ABOUTME: Redacts a self-run's artifacts once all are read: its credentials and the secrets it
 * wrote itself, with the open trace rules that read values, counting what each artifact lost.
 * Free of Node built-ins, so the barrel can export it.
 */
import type { RunArtifactName, RunArtifacts } from './sandbox-run';
import { createTraceRedactor } from './trace-redaction';
import { escapedForms, writtenSecrets } from './written-secrets';

const MARK = '[redacted]';

/**
 * The most distinct secrets a run may write and still be redacted. Each is a pass over every
 * artifact, so code in the sandbox that writes thousands would stall redaction on the host; the
 * recorded runs write at most two.
 */
export const WRITTEN_SECRETS_LIMIT = 200;

/** The run wrote more secrets than `WRITTEN_SECRETS_LIMIT`, so none of its artifacts are kept. */
export class WrittenSecretsLimitError extends Error {
  override readonly name = 'WrittenSecretsLimitError';
}

/**
 * Redacts every artifact once all are read, with the open trace redactor's value-based rules
 * (see `createTraceRedactor`), so a diff, a transcript's token counts and a dependency list
 * still parse. The values masked are the run's credentials and every secret the run wrote
 * itself (`writtenSecrets`), wherever it then appears, including JSON-escaped (`escapedForms`).
 * Counts, per artifact, the masks added (a multi-line secret masks each of its lines). Throws
 * `WrittenSecretsLimitError` when the run wrote more than `WRITTEN_SECRETS_LIMIT` secrets.
 */
export function redactArtifacts(
  artifacts: RunArtifacts,
  credentials: readonly string[],
): {
  artifacts: RunArtifacts;
  counts: Map<RunArtifactName, number>;
  /** The same redaction, for the run's error and output. */
  redact: (text: string) => string;
} {
  const written = writtenSecrets(Object.values(artifacts));
  if (written.length > WRITTEN_SECRETS_LIMIT)
    throw new WrittenSecretsLimitError(
      `The run wrote ${written.length} secrets, more than the ${WRITTEN_SECRETS_LIMIT} agentpicks redacts. No bundle is written for it, and no further runs start.`,
    );
  const values = [...credentials, ...written].flatMap(escapedForms);
  const redact = createTraceRedactor(
    Object.fromEntries(values.map((value, i) => [`secret${i}`, value])),
    { names: false },
  );
  const redacted: RunArtifacts = {};
  const counts = new Map<RunArtifactName, number>();
  for (const [name, text] of Object.entries(artifacts) as [
    RunArtifactName,
    string,
  ][]) {
    const out = redact(text);
    redacted[name] = out;
    counts.set(name, Math.max(0, marks(out) - marks(text)));
  }
  return { artifacts: redacted, counts, redact };
}

function marks(text: string): number {
  return text.split(MARK).length - 1;
}
