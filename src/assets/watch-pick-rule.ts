/**
 * ABOUTME: The early-stop watcher's pick rule (`buildWatchPickScript`) applied to a bundle's
 * artifacts after the run, so `agentpicks results` reads a pick the way the watcher does: a new
 * dependency matching the install pattern, an added code line matching the code pattern, or a
 * created config file matching the path pattern. `watch-pick-rule.spec.ts` runs the watcher's own
 * bash beside it on the same changes and holds the two to the same answer.
 */
import { RE2JS } from 're2js';

import type { EarlyStopPatterns } from '../catalogue/early-stop';
import { parseEarlyStop, type RunArtifacts } from '../run/sandbox-run';

/** What the rule found: the matching packages, code or config file, or no pick, or that it can't tell. */
export type WatchPick =
  | { status: 'picked'; signal: 'package'; packages: string[] }
  | { status: 'picked'; signal: 'code'; match: string }
  | { status: 'picked'; signal: 'config'; path: string }
  | { status: 'none' }
  | { status: 'unmeasured'; reason: string };

/** `[[:space:]]` and the other POSIX classes the watcher's `grep -E` reads, as JS ranges. */
const POSIX_CLASSES: Record<string, string> = {
  space: ' \\t\\n\\v\\f\\r',
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  digit: '0-9',
  upper: 'A-Z',
  lower: 'a-z',
};

/** A compiled watcher pattern: whether a line matches, and the text it matched. */
export interface EreMatcher {
  test(input: string): boolean;
  exec(input: string): [string] | null;
}

/**
 * A watcher pattern (POSIX ERE) compiled on RE2, or null when it doesn't compile. RE2 runs in linear
 * time, so a pattern read from a bundle can't hang the host the way a backtracking regex can.
 */
export function ereToRegExp(
  source: string,
  options: { caseInsensitive?: boolean } = {},
): EreMatcher | null {
  const translated = source.replace(
    /\[:(\w+):\]/g,
    (whole, name: string) => POSIX_CLASSES[name] ?? whole,
  );
  let pattern: RE2JS;
  try {
    pattern = RE2JS.compile(
      translated,
      options.caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0,
    );
  } catch {
    return null;
  }
  return {
    test: (input) => pattern.test(input),
    exec: (input) => {
      const m = pattern.matcher(input);
      return m.find() ? [m.group() ?? ''] : null;
    },
  };
}

/** The watcher's `[[:space:]]`, kept to ASCII as awk, sed and grep read it. */
const SP = '[ \\t\\v\\f\\r]';
const re = (source: string) => new RegExp(source);

const PACKAGE_DEPS_OPEN = re(
  `"(dev|peer|optional)?[dD]ependencies"${SP}*:${SP}*\\{`,
);
const GEM_LINE = re(`^${SP}*gem${SP}`);
const REQUIREMENT_SKIP = re(`^${SP}*(#|-|$)`);
const PYPROJECT_ARRAY = re(`^${SP}*(dependencies|requires)${SP}*=${SP}*\\[`);
const PACKAGE_NAME = re(`^${SP}*"([^"]+)"${SP}*:`);
const GEM_NAME = re(`^${SP}*gem${SP}+['"]([^'"]+)['"]`);
const REQUIREMENT_NAME = re(`^${SP}*([A-Za-z0-9_.-]+)`);
const PYPROJECT_TOKEN = new RegExp(
  `["'][A-Za-z0-9_.-]+|^${SP}*[A-Za-z0-9_.-]+${SP}*=`,
  'g',
);

/** The watcher's `deps`: the dependency entries of a manifest, by its file name. */
function deps(file: string, lines: string[]): string[] {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (base === 'package.json') {
    let inDeps = false;
    return lines.filter((line) => {
      if (PACKAGE_DEPS_OPEN.test(line)) {
        inDeps = true;
        return false;
      }
      if (inDeps && line.includes('}')) inDeps = false;
      return inDeps;
    });
  }
  if (base === 'Gemfile') return lines.filter((line) => GEM_LINE.test(line));
  if (/^requirements.*\.txt$/.test(base))
    return lines.filter((line) => !REQUIREMENT_SKIP.test(line));
  if (base === 'pyproject.toml') {
    let section = false;
    let array = false;
    return lines.filter((line) => {
      if (line.startsWith('[')) {
        section = /dependencies\]$/.test(line);
        return false;
      }
      if (PYPROJECT_ARRAY.test(line)) array = true;
      const kept = section || array;
      if (array && line.includes(']')) array = false;
      return kept;
    });
  }
  return [];
}

/** The watcher's `names`: quoted, lowercased package names on those entries, `_` read as `-`. */
function names(file: string, entries: string[]): Set<string> {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const found: string[] = [];
  for (const line of entries) {
    if (base === 'package.json') {
      const m = PACKAGE_NAME.exec(line);
      if (m) found.push(m[1]!);
    } else if (base === 'Gemfile') {
      const m = GEM_NAME.exec(line);
      if (m) found.push(m[1]!);
    } else if (/^requirements.*\.txt$/.test(base)) {
      const m = REQUIREMENT_NAME.exec(line);
      if (m) found.push(m[1]!);
    } else if (base === 'pyproject.toml') {
      for (const token of line.match(PYPROJECT_TOKEN) ?? [])
        found.push(
          token.replace(/^["' \t\v\f\r]*/, '').replace(/[ \t\v\f\r]*=$/, ''),
        );
    }
  }
  return new Set(
    found.map((name) => `"${name.replace(/[A-Z_]/g, normaliseChar)}"`),
  );
}

function normaliseChar(c: string): string {
  return c === '_' ? '-' : c.toLowerCase();
}

/**
 * The files in a manifest dump (`=== <path>` then its contents), keyed by path without `./`.
 * A header can follow a file with no final newline on the same line, as the dump's `cat` leaves it.
 */
export function splitDump(text: string): Map<string, string[]> {
  // A path never spans `=`, so a scan from one header stops at the next and a long line of false
  // headers stays linear.
  const header =
    /=== (?:\.\/)?((?:[^\n=]*\/)?package\.json|Gemfile|requirements(?:-dev)?\.txt|pyproject\.toml)\n/g;
  const files = new Map<string, string[]>();
  let current: string | null = null;
  let from = 0;
  const close = (end: number) => {
    if (current === null) return;
    const body = text.slice(from, end);
    const lines = body.split('\n');
    if (lines.at(-1) === '') lines.pop();
    files.set(current, lines);
  };
  for (const m of text.matchAll(header)) {
    close(m.index);
    current = m[1]!;
    from = m.index + m[0].length;
  }
  close(text.length);
  return files;
}

/** The watcher's `code_files` filter: source, template, env and YAML files outside build output. */
function isCodeFile(path: string): boolean {
  return (
    !/^(node_modules|\.venv|vendor|\.next|tmp|log)\//.test(path) &&
    /\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue|astro|py|rb|erb|ejs|haml|slim|html|jinja2?|ya?ml)$|(^|\/)\.env[^/]*$/.test(
      path,
    ) &&
    !/(^|\/)pnpm-lock\.yaml$/.test(path)
  );
}

interface DiffFile {
  path: string;
  created: boolean;
  added: string[];
}

/** Each file in a `git diff` patch: its new path, whether it was created, and its `+` lines. */
function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // The new path, also read from `+++ b/` below; this covers a file with no hunks.
      const path = / b\/(.*)$/.exec(line)?.[1] ?? '';
      file = { path, created: false, added: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('new file mode')) file.created = true;
      else if (line.startsWith('+++ b/')) file.path = line.slice(6);
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      continue;
    }
    // Inside a hunk, as the watcher reads it: `+` lines, but not one that reads as a file header.
    if (line.startsWith('+') && !line.startsWith('+++ ')) file.added.push(line);
  }
  return files;
}

/**
 * The pick the watcher's rule reads from a run's artifacts, checked in the watcher's order:
 * install, then code, then a created config file. Evidence that is missing, or a diff that was
 * cut, leaves its check unread: a match in a later check is then `unmeasured`, since the unread
 * one could have found another pick first, and no match is `unmeasured` too. A run whose
 * `earlystop.json` records a pick the final files don't show by the same check (install, or code
 * for a code line or config file) is `unmeasured`, never `none` or another check's pick.
 */
export function readWatchPick(
  artifacts: RunArtifacts,
  patterns: EarlyStopPatterns,
): WatchPick {
  const install = ereToRegExp(patterns.installPattern, {
    caseInsensitive: true,
  });
  const code = ereToRegExp(patterns.codePattern);
  const path = patterns.pathPattern ? ereToRegExp(patterns.pathPattern) : null;
  if (!install || !code || (patterns.pathPattern && !path))
    return {
      status: 'unmeasured',
      reason: "the run's early-stop patterns don't compile",
    };
  const gaps: string[] = [];
  // What the watcher saw during the run: the final files must show a pick by the same check.
  const stopped = parseEarlyStop(artifacts['earlystop.json'])?.reason;
  const recorded = stopped === 'install' || stopped === 'code' ? stopped : null;
  const lost: WatchPick = {
    status: 'unmeasured',
    reason: `the watcher saw a pick (${recorded}) that the final files no longer show`,
  };
  // A match is the pick only when every check before it was read in full, and it agrees with the
  // watcher's record, if any.
  const found = (
    pick: Extract<WatchPick, { status: 'picked' }>,
    shown: string,
  ): WatchPick => {
    if (gaps.length > 0)
      return {
        status: 'unmeasured',
        reason: `${gaps.join('; ')}, and the early stop checks that before the ${shown} it found`,
      };
    const check = pick.signal === 'package' ? 'install' : 'code';
    return recorded && recorded !== check ? lost : pick;
  };

  const final = artifacts['package-json.txt'];
  const others = artifacts['manifests.txt'];
  const baseline = artifacts['baseline-manifests.txt'];
  if (final === undefined || others === undefined || baseline === undefined)
    gaps.push('the dependency manifests are missing');
  else {
    const before = splitDump(baseline);
    const packages = new Set<string>();
    for (const [file, lines] of [...splitDump(final), ...splitDump(others)]) {
      const had = names(file, deps(file, before.get(file) ?? []));
      for (const name of names(file, deps(file, lines)))
        if (!had.has(name) && install.test(name))
          packages.add(name.slice(1, -1));
    }
    if (packages.size > 0)
      return found(
        { status: 'picked', signal: 'package', packages: [...packages].sort() },
        'packages',
      );
  }

  const patch = artifacts['diff.patch'];
  if (patch === undefined) gaps.push('the diff is missing');
  else {
    const files = parsePatch(patch);
    for (const file of files) {
      if (!isCodeFile(file.path)) continue;
      for (const line of file.added) {
        // The watcher reads a file the agent created whole, without the `+`.
        const m =
          code.exec(line) ?? (file.created ? code.exec(line.slice(1)) : null);
        if (m)
          return found(
            { status: 'picked', signal: 'code', match: m[0] },
            `code ${m[0].trim()}`,
          );
      }
    }
    // A cut diff can still show code; the code it lost could come before a config file.
    if (artifacts['diff-truncated.txt'] !== undefined)
      gaps.push('the diff was cut at its size limit');
    if (path)
      for (const file of files)
        if (
          file.created &&
          !/^(node_modules|\.venv|vendor|\.next|tmp|log)\//.test(file.path) &&
          path.test(file.path)
        )
          return found(
            { status: 'picked', signal: 'config', path: file.path },
            `config file ${file.path}`,
          );
  }

  if (gaps.length > 0) return { status: 'unmeasured', reason: gaps.join('; ') };
  return recorded ? lost : { status: 'none' };
}
