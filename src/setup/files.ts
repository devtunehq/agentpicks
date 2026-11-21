/**
 * ABOUTME: Where setup files live and how one is read: `agentpicks/*.yaml` (or `.yml`) at the
 * repository root, the git root above the working directory (or the working directory outside git).
 * A setup's name is its file name without the extension. Reading parses the YAML, checks it against
 * the schema and resolves it against the catalogue, collecting every problem with its field.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

import { parseDocument } from 'yaml';
import type { z } from 'zod';

import { UsageError } from '../cli/errors';
import {
  resolveSetup,
  type HeldTool,
  type ResolvedSetup,
  type SetupProblem,
} from './resolve';
import { setupFileSchema, type SetupFile } from './schema';

/** The folder setup files live in, at the repository root. */
export const SETUPS_DIR = 'agentpicks';

const EXTENSIONS = ['.yaml', '.yml'];

/**
 * The nearest directory at or above `dir` holding a repository's `.git`, or null outside a
 * repository. That `.git` is a file (a linked worktree or submodule) or a folder with `HEAD`. Git
 * skips an empty `.git` folder, such as a sandbox's leftover mount point in /tmp, and so does this.
 */
export function gitRoot(dir: string): string | null {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const git = statSync(join(at, '.git'), { throwIfNoEntry: false });
    if (git?.isFile() || (git && existsSync(join(at, '.git', 'HEAD')))) {
      return at;
    }
    if (dirname(at) === at) return null;
  }
}

/** The repository root setups are found in: the git root, or `cwd` outside a repository. */
export function setupsRoot(cwd: string): string {
  return gitRoot(cwd) ?? resolve(cwd);
}

/**
 * Every setup file under `<root>/agentpicks`, sorted by name. One that can't be read, such as a
 * dangling symlink, is kept, so reading it reports the problem.
 */
export function listSetupFiles(root: string): string[] {
  const dir = join(root, SETUPS_DIR);
  if (!isDirectory(dir)) return [];
  return readdirSync(dir)
    .filter((name) => EXTENSIONS.includes(extname(name)))
    .map((name) => join(dir, name))
    .filter((path) => !isDirectory(path))
    .sort();
}

/** The tools a linked file's DevTune setup holds, by the file's id, where DevTune was read. */
export type HeldTools = (id: string) => readonly HeldTool[] | undefined;

/**
 * Every setup file under `<root>/agentpicks`, read, a linked one against what `held` says its
 * DevTune setup holds. Two files with one name (`x.yaml` and `x.yml`)
 * each get a problem, since `run x` can't tell them apart.
 */
export function readSetupFiles(root: string, held?: HeldTools): SetupOnDisk[] {
  const files = listSetupFiles(root).map((path) => readSetupFile(path, held));
  return files.map((file) => {
    const twin = files.find(
      (other) => other !== file && other.name === file.name,
    );
    return twin
      ? {
          ...file,
          setup: null,
          problems: [
            {
              field: '(file)',
              message: `${basename(twin.path)} is also named ${file.name}. Rename or remove one.`,
            },
            ...file.problems,
          ],
        }
      : file;
  });
}

export interface SetupOnDisk {
  path: string;
  name: string;
  /** The repository root `repo` is relative to. */
  root: string;
  /** Set when the file has no problems. */
  setup: ResolvedSetup | null;
  /** The file as parsed, set when it matches the schema, even if it fails the catalogue's checks. */
  content?: SetupFile;
  problems: SetupProblem[];
}

/** One setup file, read, checked and resolved; problems are collected, never thrown. */
export function readSetupFile(path: string, held?: HeldTools): SetupOnDisk {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return checkSetupText(path, null, error);
  }
  return checkSetupText(path, text, undefined, held);
}

/**
 * `text` checked and resolved as the setup file at `path` would be, so `init` can check a file
 * before writing it exactly as `validate` checks it after. A null text is a file that couldn't be
 * read, for `readError`'s reason.
 */
export function checkSetupText(
  path: string,
  text: string | null,
  readError?: unknown,
  held?: HeldTools,
): SetupOnDisk {
  const name = basename(path, extname(path));
  const dir = dirname(path);
  const root =
    gitRoot(dir) ?? (basename(dir) === SETUPS_DIR ? dirname(dir) : dir);
  const fail = (problems: SetupProblem[]) => ({
    path,
    name,
    root,
    setup: null,
    problems,
  });
  if (text === null)
    return fail([
      {
        field: '(file)',
        message: `Can't read it: ${readError instanceof Error ? readError.message : String(readError)}`,
      },
    ]);
  const document = parseDocument(text);
  if (document.errors.length > 0)
    return fail(
      document.errors.map((error) => ({
        field: `line ${error.linePos?.[0]?.line ?? '?'}`,
        message: `${error.message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '')}. Fix the YAML there.`,
      })),
    );
  const value: unknown = document.toJS();
  if (value === null || value === undefined)
    return fail([
      {
        field: '(file)',
        message: 'It is empty. Give at least job or from, and stacks or repo.',
      },
    ]);
  const parsed = setupFileSchema.safeParse(value);
  if (!parsed.success) return fail(parsed.error.issues.map(issueProblem));
  const resolved = resolveSetup(
    name,
    parsed.data,
    parsed.data.id ? held?.(parsed.data.id) : undefined,
  );
  if (!('setup' in resolved))
    return { ...fail(resolved.problems), content: parsed.data };
  return {
    path,
    name,
    root,
    setup: resolved.setup,
    content: parsed.data,
    problems: [],
  };
}

/** A schema issue as a problem: its field path, and what to write there. */
function issueProblem(issue: z.core.$ZodIssue): SetupProblem {
  const field =
    issue.path
      .map((key, i) =>
        typeof key === 'number' ? `[${key}]` : `${i ? '.' : ''}${String(key)}`,
      )
      .join('') || '(file)';
  if (issue.code === 'unrecognized_keys')
    return {
      field,
      message: `${issue.keys.join(', ')} ${issue.keys.length === 1 ? "isn't a" : "aren't"} setup field${issue.keys.length === 1 ? '' : 's'} here. Check the spelling, or remove ${issue.keys.length === 1 ? 'it' : 'them'}.`,
    };
  // The schema's two unions are a tool reference and repo; each gets the shapes it takes.
  if (issue.code === 'invalid_union')
    return {
      field,
      message:
        issue.path[0] === 'repo'
          ? 'Give a path, such as ., or path and optionally ref.'
          : 'Give a tool key of the from category, or a full entry with key, name and signals, and optionally domain.',
    };
  return { field, message: issue.message };
}

/** A problem as one line: the file, relative to `cwd`, its field and the fix. */
export function formatProblem(
  path: string,
  problem: SetupProblem,
  cwd: string,
): string {
  return `${relative(cwd, path) || path}: ${problem.field}: ${problem.message}`;
}

/**
 * The setup `arg` names: a path (it holds a slash or ends in .yaml or .yml), relative to `cwd`, or
 * a name in the repository's `agentpicks` folder. Refuses one that isn't there, listing the names.
 */
export function findSetup(arg: string, cwd: string): string {
  if (
    arg.includes('/') ||
    arg.includes('\\') ||
    EXTENSIONS.includes(extname(arg))
  ) {
    const path = resolve(cwd, arg);
    if (!existsSync(path))
      throw new UsageError(`There is no setup file at ${path}.`);
    return path;
  }
  const root = setupsRoot(cwd);
  const files = listSetupFiles(root);
  const matches = files.filter((path) => basename(path, extname(path)) === arg);
  if (matches.length > 1)
    throw new UsageError(
      `Both ${matches.map((p) => relative(cwd, p)).join(' and ')} are named ${arg}. Remove one, or run the other by its path.`,
    );
  if (matches.length === 1) return matches[0]!;
  const names = files.map((path) => basename(path, extname(path)));
  throw new UsageError(
    names.length
      ? `There is no setup ${arg} in ${join(root, SETUPS_DIR)}. Choose one of: ${names.join(', ')}.`
      : `There is no setup ${arg}: ${join(root, SETUPS_DIR)} holds no setup files. ${WRITE_ONE}`,
  );
}

/** How to write a first setup file, for a repository with none. */
export const WRITE_ONE = `Write one, such as agentpicks/error-tracking.yaml:

  job: Add error tracking
  from: error-tracking
  stacks: [nextjs]

then run it with: agentpicks run error-tracking. The package README describes every field.`;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
