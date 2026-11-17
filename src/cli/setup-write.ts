/**
 * ABOUTME: Writes a setup file into `agentpicks/` for init, pull and push, never through a
 * symbolic link: a checkout can hold one at the directory or the file's path that points anywhere
 * on the machine. The text goes to a temporary file beside the target, which is then renamed over
 * it or linked into place. It also holds the schema line init and pull start a file with.
 */
import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import packageJson from '../../package.json';
import { UsageError } from './errors';

/** The setup file's JSON Schema as this version publishes it, on the public mirror at this version's tag. */
export const SETUP_SCHEMA_URL = `https://raw.githubusercontent.com/devtunehq/agentpicks/v${packageJson.version}/schema/setup.v1.json`;

/** The first line init and pull write, which points an editor with YAML support at the schema. */
export const SCHEMA_LINE = `# yaml-language-server: $schema=${SETUP_SCHEMA_URL}`;

/** Whether `path` is a symbolic link, dangling or not. */
function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Writes `text` to `path` in `dir`. With `replace` it is renamed over whatever file is there;
 * without it, it fails with EEXIST if a file appeared at `path` meanwhile. Refuses, naming
 * `shown`, when the directory or the path is a symbolic link.
 */
export function writeSetupText(
  dir: string,
  path: string,
  text: string,
  options: { replace: boolean; shown: (path: string) => string },
) {
  for (const target of [dir, path])
    if (isSymlink(target))
      throw new UsageError(
        `${options.shown(target)} is a symbolic link, and agentpicks writes setup files only to a real file in a real directory. Remove the link and run the command again.`,
      );
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.agentpicks-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    if (options.replace) renameSync(temporary, path);
    else linkOrCopy(temporary, path);
  } finally {
    // Linked, refused or half written, the temporary file is left beside the setup; renamed, it is gone.
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/**
 * Puts the temporary file at `path`, failing with EEXIST if one is there: a hard link, or an exclusive
 * copy on a filesystem without hard links (FAT, exFAT, some network shares).
 */
function linkOrCopy(temporary: string, path: string) {
  try {
    linkSync(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS')
      throw error;
    copyFileSync(temporary, path, constants.COPYFILE_EXCL);
  }
}
