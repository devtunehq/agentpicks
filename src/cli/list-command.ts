/**
 * ABOUTME: `agentpicks list`: the repository's setup files as a table, flagging any that fails its
 * checks, and signed in, the project's DevTune setups in the same table, with where each lives
 * (local, DevTune or both) and whether a linked pair is in sync or which side changed. Signed out,
 * or with a key that can't read setups, the table is the files alone, and a line on standard error
 * says how to see DevTune's.
 */
import { join } from 'node:path';

import {
  readSetupFiles,
  SETUPS_DIR,
  setupsRoot,
  WRITE_ONE,
  type SetupOnDisk,
} from '../setup/files';
import { devtuneSetupFile, SYNC_STATE_LABELS, syncState } from '../setup/link';
import { resolveSetup, type ResolvedSetup } from '../setup/resolve';
import { NotLoggedInError, UploadError, UsageError } from './errors';
import type { CliContext } from './main';
import { readSetups, type DevtuneSetups } from './setup-links';

export async function listCommand(
  argv: string[],
  ctx: CliContext,
): Promise<number> {
  if (argv.length > 0)
    throw new UsageError(
      `agentpicks list takes no arguments, not ${argv.join(' ')}.`,
    );
  const root = setupsRoot(ctx.cwd);
  const files = readSetupFiles(root);
  let devtune: DevtuneSetups | null = null;
  try {
    devtune = await readSetups(ctx);
  } catch (error) {
    if (error instanceof NotLoggedInError)
      ctx.err(
        'To list your DevTune setups here too, sign in with agentpicks login.',
      );
    else if (error instanceof UploadError)
      ctx.err(`DevTune setups aren't listed: ${error.message}`);
    else throw error;
  }
  if (devtune) return linkedTable(files, devtune, ctx);
  if (files.length === 0) {
    ctx.out(`${join(root, SETUPS_DIR)} holds no setup files. ${WRITE_ONE}`);
    return 0;
  }
  printTable(
    ['NAME', 'JOB', 'FROM', 'TESTS', 'AGENTS', 'RUNS'],
    files.map((file) => ({
      name: file.name,
      cells: file.setup ? setupCells(file.setup) : null,
      problem: problemOf(file),
    })),
    ctx,
  );
  footer(files, ctx);
  return 0;
}

/** Local files and DevTune setups in one table, each linked file beside its setup. */
function linkedTable(
  files: SetupOnDisk[],
  devtune: DevtuneSetups,
  ctx: CliContext,
) {
  const linkedIds = new Set(files.flatMap((file) => file.content?.id ?? []));
  const rows = [
    ...files.map((file) => {
      const id = file.content?.id;
      const setup = id
        ? devtune.list.setups.find((each) => each.id === id)
        : undefined;
      return {
        name: file.name,
        cells: file.setup
          ? [
              id && setup ? 'both' : 'local',
              id ? SYNC_STATE_LABELS[syncState(file.content!, setup)] : '-',
              ...setupCells(file.setup),
            ]
          : null,
        problem: problemOf(file),
      };
    }),
    ...devtune.list.setups
      .filter((setup) => !linkedIds.has(setup.id))
      .map((setup) => {
        const name = devtune.names.get(setup.id)!;
        const mapped = devtuneSetupFile(setup);
        if ('problem' in mapped)
          return { name, cells: null, problem: mapped.problem };
        const resolved = resolveSetup(name, mapped.file);
        if (!('setup' in resolved)) {
          const [first] = resolved.problems;
          return {
            name,
            cells: null,
            problem: `${first!.field}: ${first!.message}`,
          };
        }
        return {
          name,
          cells: ['DevTune', '-', ...setupCells(resolved.setup)],
          problem: '',
        };
      }),
  ];
  if (rows.length === 0) {
    ctx.out(`Neither ${SETUPS_DIR}/ nor DevTune holds a setup. ${WRITE_ONE}`);
    return 0;
  }
  printTable(
    ['NAME', 'WHERE', 'SYNC', 'JOB', 'FROM', 'TESTS', 'AGENTS', 'RUNS'],
    rows,
    ctx,
  );
  footer(files, ctx);
  return 0;
}

function printTable(
  header: string[],
  rows: { name: string; cells: string[] | null; problem: string }[],
  ctx: CliContext,
) {
  const full = rows.flatMap((row) =>
    row.cells ? [[row.name, ...row.cells]] : [],
  );
  const widths = header.map((title, i) =>
    Math.max(title.length, ...full.map((cells) => cells[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) =>
        i === cells.length - 1 ? cell : cell.padEnd(widths[i]!),
      )
      .join('  ');
  ctx.out(line(header));
  for (const row of rows)
    ctx.out(
      row.cells
        ? line([row.name, ...row.cells])
        : `${row.name.padEnd(widths[0]!)}  invalid: ${row.problem}`,
    );
}

function footer(files: SetupOnDisk[], ctx: CliContext) {
  const invalid = files.filter((file) => !file.setup).length;
  if (invalid === 0) return;
  ctx.out('');
  ctx.out(
    `${invalid} setup file${invalid === 1 ? ' fails its' : 's fail their'} checks. agentpicks validate lists every problem.`,
  );
}

/** A file's first problem, for its row. */
function problemOf(file: SetupOnDisk) {
  const [first] = file.problems;
  return first ? `${first.field}: ${first.message}` : '';
}

/** A setup's job, from, tests, agents and runs cells. */
function setupCells(setup: ResolvedSetup): string[] {
  const job = setup.job.length > 48 ? `${setup.job.slice(0, 47)}…` : setup.job;
  const tests = setup.repo
    ? `repo ${setup.repo.path}${setup.repo.ref ? ` at ${setup.repo.ref}` : ''}`
    : setup.stacks
      ? setup.stacks.map((env) => env.slug).join(', ')
      : '-';
  return [
    job,
    setup.from ?? '-',
    tests,
    setup.agents?.join(', ') ?? 'the installed one',
    String(setup.runs ?? 1),
  ];
}
