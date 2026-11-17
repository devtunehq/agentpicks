/**
 * ABOUTME: The setup file checks: `agentpicks validate`, which checks setup files against the schema
 * and the catalogue, and `agentpicks schema`, which prints the JSON Schema they are checked with.
 */
import { join, relative } from 'node:path';

import {
  findSetup,
  formatProblem,
  readSetupFile,
  readSetupFiles,
  SETUPS_DIR,
  setupsRoot,
  WRITE_ONE,
  type SetupOnDisk,
} from '../setup/files';
import { setupJsonSchema } from '../setup/schema';
import { UsageError } from './errors';
import type { CliContext } from './main';

/**
 * `agentpicks validate [setup…]`: checks every setup file in the repository, or the ones named, against
 * the schema and the catalogue. Exits non-zero when any fails, naming its file and field.
 */
export function validateCommand(argv: string[], ctx: CliContext): number {
  const flag = argv.find((arg) => arg.startsWith('-'));
  if (flag)
    throw new UsageError(`agentpicks validate takes no flags, not ${flag}.`);
  const root = setupsRoot(ctx.cwd);
  // A file named by path is read alone, as `run <path>` reads it, so a twin name doesn't fail it.
  const files: (SetupOnDisk | { path: string; error: string })[] =
    argv.length > 0
      ? argv.map((arg) => {
          try {
            return readSetupFile(findSetup(arg, ctx.cwd));
          } catch (error) {
            if (!(error instanceof UsageError)) throw error;
            return { path: arg, error: error.message };
          }
        })
      : readSetupFiles(root);
  if (files.length === 0) {
    ctx.out(`${join(root, SETUPS_DIR)} holds no setup files. ${WRITE_ONE}`);
    return 0;
  }
  let failed = 0;
  for (const file of files) {
    if ('error' in file) {
      failed++;
      ctx.err(file.error);
      continue;
    }
    if (file.problems.length === 0) {
      ctx.out(`${relative(ctx.cwd, file.path) || file.path}: valid`);
      continue;
    }
    failed++;
    for (const problem of file.problems)
      ctx.err(formatProblem(file.path, problem, ctx.cwd));
  }
  const count = files.length;
  ctx.out(
    `${count - failed} of ${count} setup file${count === 1 ? '' : 's'} valid.`,
  );
  return failed === 0 ? 0 : 1;
}

/** `agentpicks schema`: the setup file's JSON Schema, as schema/setup.v1.json in the package holds it. */
export function schemaCommand(argv: string[], ctx: CliContext): number {
  if (argv.length > 0)
    throw new UsageError(
      `agentpicks schema takes no arguments, not ${argv[0]}.`,
    );
  ctx.out(JSON.stringify(setupJsonSchema(), null, 2));
  return 0;
}
