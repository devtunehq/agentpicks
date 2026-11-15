/**
 * ABOUTME: `agentpicks results [dir…] [--json]`: which tool each run in a bundle directory picked,
 * read from its bundle with the early-stop watcher's own rule (`readWatchPick`) and the patterns
 * the run recorded, as a table with a
 * count per setup, or as JSON rows. A run with no pick reads `none`; one whose bundle or signals
 * can't be read reads `Unmeasured`, and so does one with no pick from a setup naming a catalogue
 * tool by key, whose signals only DevTune holds. DevTune's full analysis (the stated pick, the
 * decision trail, rates) isn't here.
 */
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readWatchPick, type WatchPick } from '../assets/watch-pick-rule';
import { CUSTOM_SETUP_CATEGORY_PREFIX } from './bundle';
import { BundleError, UsageError } from './errors';
import { isFormatControl } from './terminal-text';
import { findBundles, readBundle, type BundleOnDisk } from './upload';

/** Where `agentpicks run` writes bundles unless --out says otherwise. */
export const DEFAULT_RUNS_DIR = 'agentpicks-runs';

const UNMEASURED = 'Unmeasured';

export interface ResultRow {
  /** The bundle directory. */
  dir: string;
  /** The run id, or the directory's name when its manifest can't be read. */
  runId: string;
  /** The setup file's name, or the built-in category; null when the manifest can't be read. */
  setup: string | null;
  agent: string | null;
  model: string | null;
  status: 'picked' | 'none' | 'unmeasured';
  /** The packages, code or config file that show the pick; null without one. */
  tool: string | null;
  signal: 'package' | 'code' | 'config' | null;
  /** Why the run reads Unmeasured. */
  reason: string | null;
  startedAt: string | null;
}

interface ResultsContext {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
}

/** Runs `agentpicks results`; exits non-zero, naming the fix, when a directory holds no bundle. */
export function resultsCommand(argv: string[], ctx: ResultsContext): number {
  const { json, dirs } = parseResultsArgs(argv);
  // A directory and a bundle inside it name the same run once.
  const rows = [
    ...new Set(
      dirs.flatMap((dir) =>
        bundleDirs(resolve(ctx.cwd, dir)).map((bundle) => resolve(bundle)),
      ),
    ),
  ]
    .map(resultRow)
    .sort(
      (a, b) =>
        (a.startedAt ?? '￿').localeCompare(b.startedAt ?? '￿') ||
        a.dir.localeCompare(b.dir),
    );
  if (json) {
    ctx.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const line of resultsTable(rows)) ctx.out(line);
  return 0;
}

function parseResultsArgs(argv: string[]): { json: boolean; dirs: string[] } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: { json: { type: 'boolean' } },
    });
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : String(error)} agentpicks results takes bundle directories and --json.`,
    );
  }
  const dirs = parsed.positionals;
  return {
    json: parsed.values.json === true,
    dirs: dirs.length > 0 ? dirs : [DEFAULT_RUNS_DIR],
  };
}

function bundleDirs(dir: string): string[] {
  if (!existsSync(dir))
    throw new BundleError(
      `${dir} doesn't exist. Run agentpicks run to write bundles there, or pass the --out directory you gave it.`,
    );
  return findBundles(dir);
}

/** One run's row; a bundle that fails its checks reads Unmeasured, with why. */
export function resultRow(dir: string): ResultRow {
  let bundle: BundleOnDisk;
  try {
    bundle = readBundle(dir);
  } catch (error) {
    if (!(error instanceof BundleError)) throw error;
    return {
      dir,
      runId: basename(dir),
      setup: null,
      agent: null,
      model: null,
      status: 'unmeasured',
      tool: null,
      signal: null,
      reason: error.message,
      startedAt: null,
    };
  }
  const { manifest, setup, earlyStop } = bundle;
  const { category } = manifest.request;
  const custom = category.startsWith(CUSTOM_SETUP_CATEGORY_PREFIX);
  // Only the patterns the run watched for: a later catalogue could read an old run differently.
  const watched: WatchPick = earlyStop
    ? readWatchPick(
        Object.fromEntries(
          [...bundle.contents].map(([name, bytes]) => [
            name,
            bytes.toString('utf8'),
          ]),
        ),
        earlyStop,
      )
    : {
        status: 'unmeasured',
        reason:
          'the bundle was written before agentpicks recorded the early-stop patterns a run watches for. Run it again to read its pick.',
      };
  // No pick by the patterns could still be a pick of a tool they don't hold.
  const pick: WatchPick =
    watched.status === 'none' && setup?.unrecognised?.length
      ? {
          status: 'unmeasured',
          reason: `${setup.name} measures ${setup.unrecognised.join(', ')} from DevTune's catalogue, and this machine has no signals for ${setup.unrecognised.length === 1 ? 'it' : 'them'}.`,
        }
      : watched;
  return {
    dir,
    runId: manifest.runId,
    setup:
      setup?.name ??
      (custom ? category.slice(CUSTOM_SETUP_CATEGORY_PREFIX.length) : category),
    agent: manifest.agent.kind,
    model: manifest.agent.model,
    status: pick.status,
    tool: pickTool(pick),
    signal: pick.status === 'picked' ? pick.signal : null,
    reason: pick.status === 'unmeasured' ? pick.reason : null,
    startedAt: manifest.startedAt,
  };
}

function pickTool(pick: WatchPick): string | null {
  if (pick.status !== 'picked') return null;
  if (pick.signal === 'package') return pick.packages.join(' + ');
  if (pick.signal === 'code') return `code: ${clip(pick.match.trim())}`;
  return `config: ${pick.path}`;
}

/** What the PICK column shows: the tool, `none`, or `Unmeasured`. */
function shown(row: ResultRow): string {
  if (row.status === 'none') return 'none';
  if (row.status === 'unmeasured') return UNMEASURED;
  return row.tool!;
}

/** The table, then a count of picks per setup, then why any run reads Unmeasured. */
export function resultsTable(rows: ResultRow[]): string[] {
  const header = ['RUN', 'SETUP', 'AGENT', 'MODEL', 'PICK'];
  const cells = rows.map((row) =>
    [
      row.runId.slice(0, 8),
      row.setup ?? UNMEASURED,
      row.agent ?? UNMEASURED,
      row.model ?? UNMEASURED,
      shown(row),
    ].map(oneLine),
  );
  const widths = header.map((title, i) =>
    Math.max(title.length, ...cells.map((row) => row[i]!.length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join('  ');
  const lines = [line(header), ...cells.map(line), ''];

  const bySetup = new Map<string, Map<string, number>>();
  // A bundle that can't be read has no setup to count it under; it is listed below.
  for (const row of rows) {
    if (row.setup === null) continue;
    const setup = oneLine(row.setup);
    const counts = bySetup.get(setup) ?? new Map<string, number>();
    const pick = oneLine(shown(row));
    counts.set(pick, (counts.get(pick) ?? 0) + 1);
    bySetup.set(setup, counts);
  }
  for (const [setup, counts] of bySetup) {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    const picks = [...counts]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([pick, n]) => `${pick} ${n}`)
      .join(', ');
    lines.push(`${setup}: ${picks} (${total} run${total === 1 ? '' : 's'})`);
  }

  const unmeasured = rows.filter((row) => row.status === 'unmeasured');
  if (unmeasured.length > 0) {
    lines.push('');
    for (const row of unmeasured)
      lines.push(
        `${row.runId.slice(0, 8)} is Unmeasured: ${oneLine(row.reason ?? '')}`,
      );
  }
  return lines;
}

/**
 * Bundle text on one line and without terminal controls, so a cell can't break the table, and
 * its width is the width it prints at.
 */
function oneLine(text: string): string {
  // Format controls go first: `\s` counts U+FEFF as a space.
  const visible = Array.from(text)
    .filter((c) => !isFormatControl(c.codePointAt(0) ?? 0))
    .join('');
  return Array.from(visible.replace(/\s+/g, ' '))
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join('');
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
