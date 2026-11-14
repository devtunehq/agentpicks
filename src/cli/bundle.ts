/**
 * ABOUTME: Writes a self-run's bundle (`bundle/schema.ts`): artifacts, redaction summary and
 * manifest go to a hidden directory that is renamed into place only once every file is written,
 * so a failed write never leaves a partial bundle under the final name.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { lockedStarter } from '../assets/locked-starter';
import { uploadArtifactByteLimit } from '../bundle/artifact-limits';
import {
  BUNDLE_PATHS,
  BUNDLE_VERSION,
  bundleManifestSchema,
  redactionSummarySchema,
  type BundleArtifact,
  type BundleManifest,
  type RedactionSummary,
} from '../bundle/schema';
import type { EarlyStopPatterns } from '../catalogue/early-stop';
import { packEntries } from '../locks/locked-files';
import type { RunArtifactName, RunArtifacts } from '../run/sandbox-run';

/** SHA-256 of a starter's committed files and lockfiles, as a run uploads them. */
export function starterLockDigest(starter: string): string {
  const locked = lockedStarter(starter);
  return sha256(`${packEntries(locked.files)}\0${packEntries(locked.locks)}`);
}

export interface WrittenBundle {
  dir: string;
  /** Every file written, relative to `dir`, with its size. */
  files: { path: string; bytes: number }[];
  redactions: RedactionSummary;
}

/**
 * How a custom setup's `request.category` starts. No DevTune category slug carries it, so DevTune
 * refuses the run's upload by any route, and `agentpicks upload` refuses it first.
 */
export const CUSTOM_SETUP_CATEGORY_PREFIX = 'setup:';

/**
 * The setup file a run came from, which `run` writes into manifest.json beside the bundle format's
 * fields. It is agentpicks' own: `bundleManifestSchema` doesn't hold it, so every reader of the
 * bundle format, DevTune's included, drops it.
 */
export const bundleSetupSchema = z.object({
  /** The file name without its extension. */
  name: z.string().min(1),
  /** The built-in category it inherits, if any. */
  from: z.string().min(1).nullable(),
  /** The DevTune setup it is linked to, if any. */
  id: z.string().min(1).nullable(),
  /** The job line. */
  job: z.string().min(1),
  /** Set when the run asked a linked file's changes not yet pushed, so it can't file under its setup. */
  unpushed: z.boolean().optional(),
});

export type BundleSetup = z.infer<typeof bundleSetupSchema>;

/**
 * The early-stop patterns a run watched for, which `run` writes into manifest.json beside the
 * bundle format's fields and `agentpicks results` reads the run's pick with. Like `setup`, it is
 * agentpicks' own, so every reader of the bundle format, DevTune's included, drops it.
 */
export const bundleEarlyStopSchema = z.object({
  installPattern: z.string().min(1),
  codePattern: z.string().min(1),
  pathPattern: z.string().min(1).optional(),
});

/**
 * Writes the bundle for one run under `outDir/<runId>`. `artifacts` are already redacted;
 * `counts` are the redactions each lost. The manifest is checked against its schema first, and
 * `setup`, when the run came from a setup file, and `earlyStop` are written beside it.
 */
export async function writeBundle({
  outDir,
  manifest,
  setup,
  earlyStop,
  artifacts,
  counts,
}: {
  outDir: string;
  manifest: Omit<BundleManifest, 'artifacts' | 'bundleVersion'>;
  setup?: BundleSetup;
  earlyStop?: EarlyStopPatterns;
  artifacts: RunArtifacts;
  counts: ReadonlyMap<RunArtifactName, number>;
}): Promise<WrittenBundle> {
  const entries = (
    Object.entries(artifacts) as [RunArtifactName, string][]
  ).map(([name, text]) => trimArtifact(name, text));
  const full = bundleManifestSchema.parse({
    bundleVersion: BUNDLE_VERSION,
    ...manifest,
    artifacts: entries.map(({ name, text, truncation }) => ({
      name,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      ...(truncation ? { truncation } : {}),
    })),
  });
  const byArtifact = Object.fromEntries(
    entries
      .map(({ name }) => [name, counts.get(name) ?? 0] as const)
      .filter(([, count]) => count > 0),
  );
  const redactions = redactionSummarySchema.parse({
    bundleVersion: BUNDLE_VERSION,
    total: Object.values(byArtifact).reduce((sum, n) => sum + n, 0),
    byArtifact,
  });

  const dir = join(outDir, manifest.runId);
  const partial = join(outDir, `.${manifest.runId}.partial`);
  const files: WrittenBundle['files'] = [];
  const put = async (path: string, text: string) => {
    await writeFile(join(partial, path), text, { mode: 0o600 });
    files.push({ path, bytes: Buffer.byteLength(text) });
  };
  try {
    await mkdir(join(partial, BUNDLE_PATHS.artifacts), { recursive: true });
    for (const { name, text } of entries)
      await put(`${BUNDLE_PATHS.artifacts}/${name}`, text);
    await put(
      BUNDLE_PATHS.redactions,
      `${JSON.stringify(redactions, null, 2)}\n`,
    );
    await put(
      BUNDLE_PATHS.manifest,
      `${JSON.stringify({ ...full, ...(setup ? { setup } : {}), ...(earlyStop ? { earlyStop } : {}) }, null, 2)}\n`,
    );
    await rename(partial, dir);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
  return { dir, files, redactions };
}

/**
 * What self-run analysis reads; trimming any of these would leave a result drawn from part of the run. It must hold
 * every artifact the server's classifier reads (RECORD_INPUTS in apps/web's run-agent-pick/record.ts).
 */
const SELF_RUN_ANALYSIS_INPUTS: ReadonlySet<RunArtifactName> = new Set([
  'diff.patch',
  'source-files.json',
  'diff-truncated.txt',
  'ignored-env.txt',
  'package-json.txt',
  'manifests.txt',
  'baseline-manifests.txt',
  'transcript.jsonl',
  'requests.jsonl',
]);

/**
 * Trims an over-limit artifact that self-run analysis does not read to whole lines after redaction:
 * `mitm.log` and `agent.err` keep their tails (the last errors), other streams their heads.
 * The artifacts analysis reads (SELF_RUN_ANALYSIS_INPUTS) are never trimmed, so a result is never
 * drawn from part of a run: an over-limit one stays whole and `upload` refuses it with the limit
 * named. The sandbox already caps the patch and source JSON below their upload limits.
 */
function trimArtifact(
  name: RunArtifactName,
  text: string,
): {
  name: RunArtifactName;
  text: string;
  truncation?: BundleArtifact['truncation'];
} {
  const limit = uploadArtifactByteLimit(name);
  const originalBytes = Buffer.byteLength(text);
  if (SELF_RUN_ANALYSIS_INPUTS.has(name) || originalBytes <= limit)
    return { name, text };
  const bytes = Buffer.from(text);
  const tail = name === 'mitm.log' || name === 'agent.err';
  let kept: Buffer;
  if (tail) {
    const boundary = bytes.indexOf(10, bytes.length - limit - 1);
    kept = bytes.subarray(boundary < 0 ? bytes.length : boundary + 1);
  } else {
    kept = bytes.subarray(0, bytes.lastIndexOf(10, limit - 1) + 1);
  }
  return {
    name,
    text: kept.toString('utf8'),
    truncation: { originalBytes, keptBytes: kept.length },
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
