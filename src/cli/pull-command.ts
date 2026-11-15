/**
 * ABOUTME: `agentpicks pull [<setup>] [--force]`: writes a DevTune setup into its setup file, or
 * into agentpicks/<name>.yaml when no file is linked to it, with the setup's id and what the file
 * saw. With no setup named, pulls every DevTune setup in the project. A file with changes not yet
 * pushed is replaced only with --force; a file already in sync is left alone.
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { readSetupFiles, SETUPS_DIR, setupsRoot } from '../setup/files';
import {
  devtuneSetupFile,
  devtuneSetupProblems,
  linkedSetupYaml,
  syncState,
} from '../setup/link';
import type { DevtuneSetup } from './devtune-setups';
import { UsageError } from './errors';
import type { CliContext } from './main';
import {
  findDevtuneSetup,
  orphanedMessage,
  heldTools,
  readSetups,
  type DevtuneSetups,
} from './setup-links';
import { writeSetupText } from './setup-write';

export async function pullCommand(
  argv: string[],
  ctx: CliContext,
): Promise<number> {
  const { values, positionals } = parse(argv);
  if (positionals.length > 1)
    throw new UsageError(
      `Name one setup to pull, or none for every one, not ${positionals.join(', ')}.`,
    );
  const [arg] = positionals;
  const root = setupsRoot(ctx.cwd);
  const devtune = await readSetups(ctx);
  const files = readSetupFiles(root, heldTools(devtune));
  let setups = devtune.list.setups;
  if (arg !== undefined) {
    // A local file's name pulls the setup it is linked to.
    const file = files.find((each) => each.name === arg && each.content?.id);
    const id = file?.content?.id;
    const setup = id
      ? devtune.list.setups.find((each) => each.id === id)
      : findDevtuneSetup(devtune, arg);
    if (file && !setup) {
      ctx.err(orphanedMessage(shown(file.path, ctx), id!));
      return 1;
    }
    if (!setup)
      throw new UsageError(
        devtune.list.setups.length
          ? `DevTune has no setup ${arg}. Choose one of: ${[...devtune.names.values()].join(', ')}.`
          : `DevTune has no setup ${arg}: the project has none yet. Write a setup file and push it.`,
      );
    setups = [setup];
  }
  if (setups.length === 0) {
    ctx.out(
      'The DevTune project has no setups yet. Write a setup file and push it.',
    );
    return 0;
  }
  let failed = 0;
  for (const setup of setups)
    if (!pullOne(setup, root, files, devtune, values.force, ctx)) failed++;
  return failed === 0 ? 0 : 1;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: { force: { type: 'boolean', default: false } },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

const shown = (path: string, ctx: CliContext) =>
  relative(ctx.cwd, path) || path;

/** Pulls one setup into its file, printing what it did; resolves whether it did not refuse. */
function pullOne(
  setup: DevtuneSetup,
  root: string,
  files: ReturnType<typeof readSetupFiles>,
  devtune: DevtuneSetups,
  force: boolean,
  ctx: CliContext,
): boolean {
  const name = devtune.names.get(setup.id)!;
  const linked = files.filter((file) => file.content?.id === setup.id);
  if (linked.length > 1) {
    ctx.err(
      `${linked.map((file) => shown(file.path, ctx)).join(' and ')} are both linked to the DevTune setup ${name}. Remove id and synced from all but one.`,
    );
    return false;
  }
  const [local] = linked;
  const path = local?.path ?? join(root, SETUPS_DIR, `${name}.yaml`);
  if (local) {
    const state = syncState(local.content!, setup);
    if (state === 'in_sync') {
      ctx.out(`${shown(path, ctx)} is in sync with DevTune.`);
      return true;
    }
    if ((state === 'local_changed' || state === 'both_changed') && !force) {
      ctx.err(
        `${shown(path, ctx)} has changes not pushed to DevTune${state === 'both_changed' ? ', and the DevTune setup changed too' : ''}. ${state === 'local_changed' ? `Push them with agentpicks push ${local.name}, or pass` : 'Copy your changes somewhere, then pass'} --force to replace the file with DevTune's setup.`,
      );
      return false;
    }
  } else if (existsSync(path) && !force) {
    ctx.err(
      `${shown(path, ctx)} isn't linked to the DevTune setup ${name}. Rename the file and pull again, or pass --force to replace it.`,
    );
    return false;
  }
  const mapped = devtuneSetupFile(setup, {
    repo: local?.content?.repo,
    runs: local?.content?.runs,
  });
  if ('problem' in mapped) {
    ctx.err(`DevTune setup ${name}: ${mapped.problem}`);
    return false;
  }
  try {
    writeSetupText(
      join(root, SETUPS_DIR),
      path,
      linkedSetupYaml(mapped.file, {
        id: setup.id,
        setupDigest: setup.snapshot_digest,
      }),
      { replace: force || local !== undefined, shown: (at) => shown(at, ctx) },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    ctx.err(
      `${shown(path, ctx)} appeared while pull ran. Rename the file and pull again, or pass --force to replace it.`,
    );
    return false;
  }
  ctx.out(`Pulled DevTune setup ${name} to ${shown(path, ctx)}.`);
  for (const problem of devtuneSetupProblems(
    setup,
    local?.name ?? name,
    mapped.file,
  ))
    ctx.err(
      `${shown(path, ctx)}: ${problem.field}: ${problem.message} Fix it before running the setup.`,
    );
  return true;
}
