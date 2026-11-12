/**
 * ABOUTME: Writes a self-run's bundle (`bundle/schema.ts`): artifacts, redaction summary and
 * manifest go to a hidden directory that is renamed into place only once every file is written,
 * so a failed write never leaves a partial bundle under the final name.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { lockedStarter } from '../assets/locked-starter';
import {
  BUNDLE_PATHS,
  BUNDLE_VERSION,
  bundleManifestSchema,
  redactionSummarySchema,
  type BundleManifest,
  type RedactionSummary,
} from '../bundle/schema';
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
 * Writes the bundle for one run under `outDir/<runId>`. `artifacts` are already redacted;
 * `counts` are the redactions each lost. The manifest is checked against its schema first.
 */
export async function writeBundle({
  outDir,
  manifest,
  artifacts,
  counts,
}: {
  outDir: string;
  manifest: Omit<BundleManifest, 'artifacts' | 'bundleVersion'>;
  artifacts: RunArtifacts;
  counts: ReadonlyMap<RunArtifactName, number>;
}): Promise<WrittenBundle> {
  const entries = Object.entries(artifacts) as [RunArtifactName, string][];
  const full = bundleManifestSchema.parse({
    bundleVersion: BUNDLE_VERSION,
    ...manifest,
    artifacts: entries.map(([name, text]) => ({
      name,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
    })),
  });
  const byArtifact = Object.fromEntries(
    entries
      .map(([name]) => [name, counts.get(name) ?? 0] as const)
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
  await mkdir(join(partial, BUNDLE_PATHS.artifacts), { recursive: true });
  try {
    for (const [name, text] of entries)
      await put(`${BUNDLE_PATHS.artifacts}/${name}`, text);
    await put(
      BUNDLE_PATHS.redactions,
      `${JSON.stringify(redactions, null, 2)}\n`,
    );
    await put(BUNDLE_PATHS.manifest, `${JSON.stringify(full, null, 2)}\n`);
    await rename(partial, dir);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
  return { dir, files, redactions };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
