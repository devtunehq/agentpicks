/**
 * ABOUTME: Checks the project setup left on disk is the committed starter: every committed
 * file present with the same bytes, nothing removed, and nothing added beyond an explicit
 * allow-list of what an install writes. The live check runs it in every sandbox.
 */
import { createHash } from 'node:crypto';

import { INSTRUCTION_FILES } from '../assets/environment-scripts';
import { lockedStarter } from '../assets/locked-starter';
import type { EnvironmentDefinition } from '../catalogue/environments';
import { entryBytes } from './locked-files';

/**
 * Directories an install fills (and make-env's baseline repository): never listed or
 * compared, since the lock checks cover what is installed in them.
 */
export const INSTALL_OUTPUT_DIRS = [
  '.git',
  'node_modules',
  '.venv',
  'vendor/bundle',
  '.bundle',
  'tmp/cache',
] as const;

/** Files an install may write beyond the starter: the lockfile when a starter lacks one. */
export const INSTALL_OUTPUT_FILES = [
  'package-lock.json',
  'Gemfile.lock',
] as const;

/** Bash, run in the project: `<sha256>  <path>` for every file outside the install output. */
export const PROJECT_FILES_SH = `find . \\( ${INSTALL_OUTPUT_DIRS.map((d) => `-path ./${d}`).join(' -o ')} \\) -prune -o -type f -print0 | xargs -0 -r sha256sum | sed 's|  \\./|  |'`;

const insideInstallOutput = (path: string) =>
  (INSTALL_OUTPUT_FILES as readonly string[]).includes(path) ||
  INSTALL_OUTPUT_DIRS.some((d) => path.startsWith(`${d}/`));

/**
 * Every way `onDisk` (PROJECT_FILES_SH output) differs from the environment's committed
 * starter, as `changed|missing|added <path>`; empty when it is the starter. Instruction
 * files a stripped environment removes must be absent.
 */
export function starterDifferences(
  environment: Pick<EnvironmentDefinition, 'starter' | 'stripInstructions'>,
  onDisk: string,
): string[] {
  const disk = new Map(
    onDisk
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(66), line.slice(0, 64)] as const),
  );
  const stripped = (path: string) =>
    environment.stripInstructions === true &&
    INSTRUCTION_FILES.split(' ').some(
      (f) => path === f || path.startsWith(`${f}/`),
    );
  const differences: string[] = [];
  for (const entry of lockedStarter(environment.starter).files) {
    if (entry.kind !== 'file' || stripped(entry.path)) continue;
    const want = createHash('sha256').update(entryBytes(entry)).digest('hex');
    const got = disk.get(entry.path);
    if (got !== want)
      differences.push(`${got ? 'changed' : 'missing'} ${entry.path}`);
    disk.delete(entry.path);
  }
  for (const path of disk.keys())
    if (!insideInstallOutput(path)) differences.push(`added ${path}`);
  return differences;
}
