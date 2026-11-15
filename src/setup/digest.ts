/**
 * ABOUTME: The digest of what a setup file says DevTune holds: its content without the fields that
 * stay on this machine, as canonical JSON. Sync states compare it with what pull or push last saw,
 * and resolve uses it to tell a linked file's job line apart from one edited since.
 */
import { createHash } from 'node:crypto';

import type { SetupFile } from './schema';

/** Fields that stay on this machine: DevTune setups test stacks, and a run's count is the runner's. */
export const LOCAL_ONLY = ['id', 'synced', 'repo', 'runs'] as const;

/** JSON with keys sorted at every depth, so a digest doesn't depend on the order a file lists them in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The digest of what a file says DevTune holds: its parsed content without id, synced, repo and
 * runs, so formatting, comments and local-only fields don't count as a change.
 */
export function fileDigest(file: SetupFile): string {
  const content: Record<string, unknown> = { ...file };
  for (const key of LOCAL_ONLY) delete content[key];
  return createHash('sha256').update(canonical(content)).digest('hex');
}
