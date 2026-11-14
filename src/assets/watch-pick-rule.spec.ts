/**
 * ABOUTME: Parity between the early-stop watcher and `readWatchPick`: each case lays down a
 * starter in a git repository, makes the agent's changes, runs one pass of the real
 * watch-pick.sh detection on the live tree, then writes the bundle's artifacts with run-agent.sh's
 * own commands and reads them with `readWatchPick`. Both must find the same pick, or none.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EarlyStopPatterns } from '../catalogue/early-stop';
import { CATEGORY_EARLY_STOP } from '../catalogue/early-stop.generated';
import type { RunArtifacts } from '../run/sandbox-run';
import { mergeEarlyStop } from '../setup/resolve';
import { buildWatchPickScript } from './environment-scripts';
import { RUN_AGENT_SH } from './static-scripts';
import { readWatchPick, splitDump } from './watch-pick-rule';

const hasTools = (() => {
  try {
    for (const tool of ['bash', 'git', 'awk', 'sed', 'xargs'])
      execFileSync('sh', ['-c', `command -v ${tool}`]);
    return process.platform === 'linux';
  } catch {
    return false;
  }
})();

const root = mkdtempSync(join(tmpdir(), 'agent-picks-watch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'starter',
  GIT_AUTHOR_EMAIL: 'starter@example.com',
  GIT_COMMITTER_NAME: 'starter',
  GIT_COMMITTER_EMAIL: 'starter@example.com',
};

/**
 * One pass of the watcher's detection loop, then its first record to `$3/earlystop.json` when it
 * found a pick, as the watcher writes it before the grace period; prints the reason, or nothing.
 */
function watcherPass(patterns: EarlyStopPatterns): string {
  const script = buildWatchPickScript(patterns);
  const loop = 'while [ -z "$reason" ]; do\n  sleep 5';
  const out = 'OUT=/opt/agent-picks/out';
  const first = '\nrecord ""\n';
  const end = script.indexOf(first);
  expect(script).toContain(loop);
  expect(script).toContain(out);
  expect(end).toBeGreaterThan(0);
  return `${script
    .slice(0, end)
    .replace(loop, 'for pass in 1; do')
    .replace(
      out,
      'OUT="$3"',
    )}\n[ -n "$reason" ] && record ""\necho "$reason"\n`;
}

/** run-agent.sh's commands that write the artifacts the rule reads, with the patch uncut. */
function dumpCommands(): string {
  const lines = RUN_AGENT_SH.split('\n');
  const pick = (start: string) => {
    const line = lines.find((l) => l.startsWith(start));
    expect(line, start).toBeDefined();
    return line!;
  };
  return [
    'set -uo pipefail',
    pick('git add -A'),
    pick('BASE=$(git rev-list'),
    pick('git diff --cached $BASE -- .'),
    'cp $S/diff.full $OUT/diff.patch',
    pick('find . -name package.json'),
    pick('{ for f in Gemfile'),
    pick('{ git ls-tree -r --name-only "$BASE"'),
    // The runner ignores the dump's exit status; the last `cat-file -e` can fail.
    'true',
  ].join('\n');
}

function writeFiles(dir: string, files: Record<string, string | null>) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    if (text === null) rmSync(full);
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
}

let n = 0;
/**
 * The watcher's reason and the rule's reading for one starter and the agent's changes; `after`
 * is what the agent changes once the watcher has fired, in its grace period.
 */
function both(
  patterns: EarlyStopPatterns,
  starter: Record<string, string>,
  changes: Record<string, string | null>,
  after: Record<string, string | null> = {},
) {
  const dir = join(root, String(n++));
  const app = join(dir, 'app');
  const out = join(dir, 'out');
  mkdirSync(app, { recursive: true });
  mkdirSync(out);
  // run-agent.sh empties earlystop.json before the agent starts.
  writeFileSync(join(out, 'earlystop.json'), '');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: app, env: GIT_ENV, stdio: 'pipe' });
  git('init', '-q');
  writeFiles(app, starter);
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'starter');
  writeFiles(app, changes);

  const watcher = join(dir, 'watch.sh');
  writeFileSync(watcher, watcherPass(patterns));
  const reason = execFileSync('bash', [watcher, app, '0', out], {
    env: GIT_ENV,
    encoding: 'utf8',
  }).trim();
  writeFiles(app, after);

  const dump = join(dir, 'dump.sh');
  writeFileSync(dump, dumpCommands());
  execFileSync('bash', [dump], {
    cwd: app,
    env: { ...GIT_ENV, OUT: out, S: dir },
    stdio: 'pipe',
  });
  const read = (name: string) => readFileSync(join(out, name), 'utf8');
  const artifacts: RunArtifacts = {
    'diff.patch': read('diff.patch'),
    'package-json.txt': read('package-json.txt'),
    'manifests.txt': read('manifests.txt'),
    'baseline-manifests.txt': read('baseline-manifests.txt'),
    'earlystop.json': read('earlystop.json'),
  };
  const pick = readWatchPick(artifacts, patterns);
  const rule =
    pick.status === 'picked'
      ? pick.signal === 'package'
        ? 'install'
        : 'code'
      : pick.status === 'none'
        ? ''
        : 'unmeasured';
  return { reason, rule, pick, artifacts };
}

const ERRORS = CATEGORY_EARLY_STOP['error-tracking']!;
const PAYMENTS = CATEGORY_EARLY_STOP['payments']!;
const CI = CATEGORY_EARLY_STOP['ci']!;

const PACKAGE_JSON = (deps: Record<string, string>, extra = '') =>
  `{\n  "name": "app",\n${extra}  "dependencies": {\n${Object.entries(deps)
    .map(([k, v]) => `    "${k}": "${v}"`)
    .join(',\n')}\n  }\n}\n`;

const STARTER = {
  'package.json': PACKAGE_JSON({ next: '15.0.0' }),
  'app/page.tsx': 'export default function Page() {\n  return null;\n}\n',
};

describe.skipIf(!hasTools)('readWatchPick against the watcher', () => {
  const cases: {
    name: string;
    patterns: EarlyStopPatterns;
    starter?: Record<string, string>;
    changes: Record<string, string | null>;
    expected: { reason: string; tool?: string };
  }[] = [
    {
      name: 'a dependency added to package.json',
      patterns: ERRORS,
      changes: {
        'package.json': PACKAGE_JSON({
          next: '15.0.0',
          '@sentry/nextjs': '^9.0.0',
        }),
      },
      expected: { reason: 'install', tool: '@sentry/nextjs' },
    },
    {
      name: 'a dependency added to a nested package.json',
      patterns: ERRORS,
      starter: { ...STARTER, 'apps/web/package.json': PACKAGE_JSON({}) },
      changes: {
        'apps/web/package.json': PACKAGE_JSON({ '@sentry/node': '^9.0.0' }),
      },
      expected: { reason: 'install', tool: '@sentry/node' },
    },
    {
      name: "a version bump of the starter's own dependency",
      patterns: ERRORS,
      starter: {
        ...STARTER,
        'package.json': PACKAGE_JSON({ '@sentry/nextjs': '^8.0.0' }),
      },
      changes: {
        'package.json': PACKAGE_JSON({ '@sentry/nextjs': '^9.0.0' }),
      },
      expected: { reason: '' },
    },
    {
      name: 'a package named outside the dependencies',
      patterns: ERRORS,
      changes: {
        'package.json': PACKAGE_JSON(
          { next: '15.0.0' },
          '  "description": "uses \\"@sentry/nextjs\\" later",\n',
        ),
      },
      expected: { reason: '' },
    },
    {
      name: 'a gem added to the Gemfile',
      patterns: ERRORS,
      starter: { Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n" },
      changes: {
        Gemfile:
          "source 'https://rubygems.org'\ngem 'rails'\ngem 'sentry-ruby'\n",
      },
      expected: { reason: 'install', tool: 'sentry-ruby' },
    },
    {
      name: 'a requirement added',
      patterns: ERRORS,
      starter: { 'requirements.txt': 'fastapi==0.110\n' },
      changes: { 'requirements.txt': 'fastapi==0.110\nsentry_sdk>=2\n' },
      expected: { reason: 'install', tool: 'sentry-sdk' },
    },
    {
      name: 'a pyproject dependency added',
      patterns: ERRORS,
      starter: {
        'pyproject.toml':
          '[project]\nname = "app"\ndependencies = [\n  "fastapi",\n]\n',
      },
      changes: {
        'pyproject.toml':
          '[project]\nname = "app"\ndependencies = [\n  "fastapi",\n  "sentry-sdk>=2",\n]\n',
      },
      expected: { reason: 'install', tool: 'sentry-sdk' },
    },
    {
      name: 'code in a file the agent created',
      patterns: ERRORS,
      changes: {
        'instrumentation.ts': 'export const dsn = process.env.SENTRY_DSN;\n',
      },
      expected: { reason: 'code' },
    },
    {
      name: "code added to the starter's file",
      patterns: PAYMENTS,
      changes: {
        'app/page.tsx':
          "export default function Page() {\n  fetch('https://api.stripe.com/v1/charges');\n  return null;\n}\n",
      },
      expected: { reason: 'code' },
    },
    {
      name: 'code removed, not added',
      patterns: PAYMENTS,
      starter: {
        ...STARTER,
        'app/pay.ts': "export const url = 'https://api.stripe.com';\n",
      },
      changes: { 'app/pay.ts': 'export const url = null;\n' },
      expected: { reason: '' },
    },
    {
      name: 'code under node_modules',
      patterns: PAYMENTS,
      changes: {
        'node_modules/x/index.js': "module.exports = 'api.stripe.com';\n",
      },
      expected: { reason: '' },
    },
    {
      name: 'a CI config file the agent created',
      patterns: CI,
      changes: {
        '.github/workflows/ci.yml':
          'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
      },
      expected: { reason: 'code' },
    },
    {
      name: "a runner changed in the starter's workflow",
      patterns: CI,
      starter: {
        ...STARTER,
        '.github/workflows/ci.yml':
          'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
      },
      changes: {
        '.github/workflows/ci.yml':
          'on: push\njobs:\n  test:\n    runs-on: depot-ubuntu-24.04\n',
      },
      expected: { reason: 'code' },
    },
    {
      name: "a custom setup's own package",
      patterns: mergeEarlyStop(
        undefined,
        [
          {
            key: 'acme-flags',
            signals: { packages: { npm: ['@acme/flags'] } },
          },
        ],
        ['acme-flags'],
      ),
      changes: {
        'package.json': PACKAGE_JSON({
          next: '15.0.0',
          '@acme/flags': '^1.0.0',
        }),
      },
      expected: { reason: 'install', tool: '@acme/flags' },
    },
    {
      name: 'nothing the patterns name',
      patterns: ERRORS,
      changes: {
        'app/page.tsx':
          "export default function Page() {\n  console.error('oops');\n  return null;\n}\n",
      },
      expected: { reason: '' },
    },
  ];

  it.each(cases)('$name', ({ patterns, starter, changes, expected }) => {
    const { reason, rule, pick } = both(patterns, starter ?? STARTER, changes);
    expect(reason).toBe(expected.reason);
    expect(rule).toBe(reason);
    if (expected.tool)
      expect(pick).toMatchObject({ packages: [expected.tool] });
  });

  it('reads Unmeasured when the watcher saw a pick the agent then removed', () => {
    const withSentry = {
      'package.json': PACKAGE_JSON({
        next: '15.0.0',
        '@sentry/nextjs': '^9.0.0',
      }),
    };
    const removed = both(ERRORS, STARTER, withSentry, {
      'package.json': STARTER['package.json'],
    });
    expect(removed.reason).toBe('install');
    expect(JSON.parse(removed.artifacts['earlystop.json']!)).toMatchObject({
      reason: 'install',
    });
    expect(removed.pick).toEqual({
      status: 'unmeasured',
      reason:
        'the watcher saw a pick (install) that the final files no longer show',
    });

    // Kept through the grace period, the same pick reads as it did when the watcher fired.
    const kept = both(ERRORS, STARTER, withSentry);
    expect(kept.reason).toBe('install');
    expect(kept.pick).toEqual({
      status: 'picked',
      signal: 'package',
      packages: ['@sentry/nextjs'],
    });
  });

  it('reads Unmeasured when the watcher saw an install the agent removed, leaving code another check matches', () => {
    const dsn = {
      'instrumentation.ts': 'export const dsn = process.env.SENTRY_DSN;\n',
    };
    // The watcher fires on Rollbar; in the grace period the agent removes it but keeps the DSN.
    const switched = both(
      ERRORS,
      STARTER,
      {
        'package.json': PACKAGE_JSON({ next: '15.0.0', rollbar: '^2.26.0' }),
        ...dsn,
      },
      { 'package.json': STARTER['package.json'] },
    );
    expect(switched.reason).toBe('install');
    expect(switched.pick).toEqual({
      status: 'unmeasured',
      reason:
        'the watcher saw a pick (install) that the final files no longer show',
    });

    // Without a record (an agent the watcher doesn't run for), the code reads as the pick.
    const { 'earlystop.json': _record, ...unwatched } = switched.artifacts;
    expect(readWatchPick(unwatched, ERRORS)).toEqual({
      status: 'picked',
      signal: 'code',
      match: 'SENTRY_DSN',
    });

    // The watcher fires on the DSN and the code stays: the record agrees, so the pick stands.
    const agreed = both(ERRORS, STARTER, dsn);
    expect(agreed.reason).toBe('code');
    expect(agreed.pick).toEqual({
      status: 'picked',
      signal: 'code',
      match: 'SENTRY_DSN',
    });
  });

  it('reads Unmeasured for a code match when the dependency check it comes after is unread', () => {
    // Rollbar installed, and Sentry's DSN in the code: the early stop's install check picks Rollbar.
    const run = both(ERRORS, STARTER, {
      'package.json': PACKAGE_JSON({ next: '15.0.0', rollbar: '^2.26.0' }),
      'instrumentation.ts': 'export const dsn = process.env.SENTRY_DSN;\n',
    });
    expect(run.reason).toBe('install');
    expect(run.pick).toEqual({
      status: 'picked',
      signal: 'package',
      packages: ['rollbar'],
    });
    const { 'package-json.txt': _lost, ...withoutPackages } = run.artifacts;
    expect(readWatchPick(withoutPackages, ERRORS)).toEqual({
      status: 'unmeasured',
      reason:
        'the dependency manifests are missing, and the early stop checks that before the code SENTRY_DSN it found',
    });
  });
});

describe('readWatchPick', () => {
  const PATCH_NONE =
    'diff --git a/app/page.tsx b/app/page.tsx\n--- a/app/page.tsx\n+++ b/app/page.tsx\n@@ -1 +1 @@\n-a\n+b\n';

  it("can't rule out a pick when an input is missing or the diff was cut", () => {
    expect(readWatchPick({ 'diff.patch': PATCH_NONE }, ERRORS)).toEqual({
      status: 'unmeasured',
      reason: 'the dependency manifests are missing',
    });
    expect(
      readWatchPick(
        {
          'diff.patch': PATCH_NONE,
          'diff-truncated.txt': '500000\n',
          'package-json.txt': '',
          'manifests.txt': '',
          'baseline-manifests.txt': '',
        },
        ERRORS,
      ),
    ).toEqual({
      status: 'unmeasured',
      reason: 'the diff was cut at its size limit',
    });
  });

  it('reads Unmeasured for a config file when the diff it was found in was cut', () => {
    const created =
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\nnew file mode 100644\n--- /dev/null\n+++ b/.github/workflows/ci.yml\n@@ -0,0 +1 @@\n+on: push\n';
    const inputs = {
      'diff.patch': created,
      'package-json.txt': '',
      'manifests.txt': '',
      'baseline-manifests.txt': '',
    };
    expect(readWatchPick(inputs, CI)).toEqual({
      status: 'picked',
      signal: 'config',
      path: '.github/workflows/ci.yml',
    });
    expect(
      readWatchPick({ ...inputs, 'diff-truncated.txt': '500000\n' }, CI),
    ).toEqual({
      status: 'unmeasured',
      reason:
        'the diff was cut at its size limit, and the early stop checks that before the config file .github/workflows/ci.yml it found',
    });
  });

  it('still reads a pick another input shows', () => {
    expect(
      readWatchPick(
        {
          'package-json.txt': `=== ./package.json\n${PACKAGE_JSON({ '@sentry/nextjs': '9' })}`,
          'manifests.txt': '',
          'baseline-manifests.txt': '',
        },
        ERRORS,
      ),
    ).toEqual({
      status: 'picked',
      signal: 'package',
      packages: ['@sentry/nextjs'],
    });
  });

  it('reads a header the dump left on the line after a file with no final newline', () => {
    expect([
      ...splitDump('=== ./package.json\n{}=== ./a/package.json\n{\n}\n'),
    ]).toEqual([
      ['package.json', ['{}']],
      ['a/package.json', ['{', '}']],
    ]);
  });

  it('lists picked packages in one order, whatever order the manifest holds them in', () => {
    const pick = (deps: Record<string, string>) =>
      readWatchPick(
        {
          'package-json.txt': `=== ./package.json\n${PACKAGE_JSON(deps)}`,
          'manifests.txt': '',
          'baseline-manifests.txt': '',
        },
        ERRORS,
      );
    expect(pick({ '@sentry/react': '9', '@sentry/nextjs': '9' })).toEqual(
      pick({ '@sentry/nextjs': '9', '@sentry/react': '9' }),
    );
  });

  it('reads a bundle whose recorded pattern would backtrack, in linear time', () => {
    const started = performance.now();
    expect(
      readWatchPick(
        {
          'diff.patch': `diff --git a/app/a.ts b/app/a.ts\n--- a/app/a.ts\n+++ b/app/a.ts\n@@ -1 +1 @@\n-a\n+${'a'.repeat(40)}!\n`,
          'package-json.txt': '',
          'manifests.txt': '',
          'baseline-manifests.txt': '',
        },
        { installPattern: 'x', codePattern: '(a+)+$' },
      ),
    ).toEqual({ status: 'none' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('splits a long line of false headers in linear time', () => {
    const line = '=== ./a'.repeat(200_000);
    const started = performance.now();
    expect([...splitDump(`${line}\n=== ./package.json\n{}\n`)]).toEqual([
      ['package.json', ['{}']],
    ]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("reads Unmeasured when the run's patterns don't compile", () => {
    expect(
      readWatchPick({}, { installPattern: '(', codePattern: 'x' }),
    ).toMatchObject({ status: 'unmeasured' });
  });
});
