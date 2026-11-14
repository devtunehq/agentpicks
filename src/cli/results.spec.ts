/**
 * ABOUTME: `agentpicks results` over bundles written as `run` writes them: a pick the early stop
 * caught, a pick by installed package, no pick, missing and changed signals, a half-written
 * bundle, and a custom setup's runs, as the table with its per-setup counts and as JSON; an
 * empty or missing directory refused with the fix named; bundle text kept off the terminal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EarlyStopPatterns } from '../catalogue/early-stop';
import { CATEGORY_EARLY_STOP } from '../catalogue/early-stop.generated';
import type { AgentKind } from '../run/agent-kind';
import type { RunArtifacts } from '../run/sandbox-run';
import { writeBundle, type BundleSetup } from './bundle';
import { fakeHost } from './fake-host';
import { main, type CliContext } from './main';

const PACKAGE_JSON = (deps: string) =>
  `=== ./package.json\n{\n  "name": "app",\n  "dependencies": {\n    "next": "15.0.0"${deps}\n  }\n}\n`;
const BASELINE = PACKAGE_JSON('').replace('./', '');
const PATCH = (added: string) =>
  `diff --git a/app/page.tsx b/app/page.tsx\n--- a/app/page.tsx\n+++ b/app/page.tsx\n@@ -1,2 +1,3 @@\n export default function Page() {\n+${added}\n   return null;\n`;

/** The artifacts the pick rule reads, for a run that added `deps` and the `added` code line. */
const signals = (deps: string, added: string): RunArtifacts => ({
  'meta.json': '{"exitCode":0}',
  'package-json.txt': PACKAGE_JSON(deps),
  'manifests.txt': '',
  'baseline-manifests.txt': BASELINE,
  'diff.patch': PATCH(added),
});

let dir: string;
let minute: number;
let out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentpicks-results-'));
  out = join(dir, 'agentpicks-runs');
  minute = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function bundle(
  runId: string,
  artifacts: RunArtifacts,
  {
    kind = 'claude_code',
    model = 'opus',
    category = 'error-tracking',
    setup,
    earlyStop = CATEGORY_EARLY_STOP['error-tracking']!,
  }: {
    kind?: AgentKind;
    model?: string;
    category?: string;
    setup?: BundleSetup;
    /** The patterns the run recorded; null for a bundle written before runs recorded them. */
    earlyStop?: EarlyStopPatterns | null;
  } = {},
) {
  const started = `2026-11-11T12:${String(minute++).padStart(2, '0')}:00Z`;
  const written = await writeBundle({
    outDir: out,
    manifest: {
      runId,
      runner: { name: '@devtune/agentpicks', version: '0.2.0' },
      agent: { kind, version: '1.0.0', model },
      host: { os: 'linux', arch: 'x64' },
      sandbox: {
        provider: 'docker',
        imageDigest: `sha256:${'c'.repeat(64)}`,
        egressIp: null,
      },
      stack: { slug: 'nextjs', starter: 'nextjs', lockDigest: 'a'.repeat(64) },
      request: { category, intent: 'add', prompt: 'Add error tracking' },
      startedAt: started,
      finishedAt: started,
    },
    ...(setup ? { setup } : {}),
    ...(earlyStop ? { earlyStop } : {}),
    artifacts,
    counts: new Map(),
  });
  return written.dir;
}

function context(): CliContext & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    io: fakeHost(),
    out: (line) => lines.push(...line.split('\n')),
    err: (line) => errors.push(line),
    cwd: dir,
    dockerfileDir: '/pkg/docker',
    stdinIsTerminal: false,
    lines,
    errors,
  };
}

const RUN = (n: number) => `${n}0000000-0000-4000-8000-000000000000`;

/** One bundle of each kind the brief names, in run order. */
async function everyKind() {
  // Claude Code, stopped by the early stop once the DSN landed.
  await bundle(RUN(1), {
    ...signals('', '  const dsn = process.env.SENTRY_DSN;'),
    'earlystop.json':
      '{"reason":"code","triggerSec":40,"graceSec":60,"killed":true}',
  });
  await bundle(
    RUN(2),
    signals(',\n    "@sentry/nextjs": "^9.0.0"', '  init();'),
    { kind: 'codex', model: 'default' },
  );
  await bundle(RUN(3), signals('', '  console.error("x");'), {
    kind: 'codex',
    model: 'default',
  });
  // Ran, but its manifests and diff were never captured.
  await bundle(RUN(4), { 'meta.json': '{"exitCode":0}' });
  // Changed after it was written.
  const changed = await bundle(
    RUN(5),
    signals(',\n    "@sentry/nextjs": "^9.0.0"', ''),
  );
  writeFileSync(join(changed, 'artifacts', 'package-json.txt'), 'garbled');
  await bundle(RUN(6), signals(',\n    "@acme/flags": "^1.0.0"', ''), {
    category: 'setup:flags',
    setup: { name: 'flags', from: null, id: null, job: 'Add feature flags' },
    earlyStop: { installPattern: '"@acme/flags"', codePattern: '__no-pick__' },
  });
  // A category run from before bundles recorded the early stop they watched for.
  await bundle(RUN(7), signals(',\n    "@sentry/nextjs": "^9.0.0"', ''), {
    earlyStop: null,
  });
  // A run still being written, and a directory that isn't a bundle.
  mkdirSync(join(out, `.${RUN(8)}.partial`, 'artifacts'), { recursive: true });
  writeFileSync(join(out, `.${RUN(8)}.partial`, 'manifest.json'), '{');
  mkdirSync(join(out, 'notes'));
}

describe('agentpicks results', () => {
  it('prints each run’s pick, none or Unmeasured, and a count per setup', async () => {
    await everyKind();
    const ctx = context();
    expect(await main(['results'], ctx)).toBe(0);
    expect(ctx.errors).toEqual([]);
    expect(ctx.lines).toEqual([
      'RUN       SETUP           AGENT        MODEL       PICK',
      '10000000  error-tracking  claude_code  opus        code: SENTRY_DSN',
      '20000000  error-tracking  codex        default     @sentry/nextjs',
      '30000000  error-tracking  codex        default     none',
      '40000000  error-tracking  claude_code  opus        Unmeasured',
      '60000000  flags           claude_code  opus        @acme/flags',
      '70000000  error-tracking  claude_code  opus        Unmeasured',
      '50000000  Unmeasured      Unmeasured   Unmeasured  Unmeasured',
      '',
      'error-tracking: Unmeasured 2, @sentry/nextjs 1, code: SENTRY_DSN 1, none 1 (5 runs)',
      'flags: @acme/flags 1 (1 run)',
      '',
      '40000000 is Unmeasured: the dependency manifests are missing; the diff is missing',
      '70000000 is Unmeasured: the bundle was written before agentpicks recorded the early-stop patterns a run watches for. Run it again to read its pick.',
      `50000000 is Unmeasured: ${out}/${RUN(5)}/artifacts/package-json.txt isn't the file its manifest declares: the bundle changed after agentpicks wrote it.`,
    ]);
  });

  it('prints the same rows as JSON with --json', async () => {
    await everyKind();
    const ctx = context();
    expect(await main(['results', '--json', 'agentpicks-runs'], ctx)).toBe(0);
    const rows = JSON.parse(ctx.lines.join('\n')) as Record<string, unknown>[];
    expect(
      rows.map(({ runId, setup, agent, model, status, tool, signal }) => ({
        runId,
        setup,
        agent,
        model,
        status,
        tool,
        signal,
      })),
    ).toEqual([
      row(
        1,
        'error-tracking',
        'claude_code',
        'opus',
        'picked',
        'code: SENTRY_DSN',
        'code',
      ),
      row(
        2,
        'error-tracking',
        'codex',
        'default',
        'picked',
        '@sentry/nextjs',
        'package',
      ),
      row(3, 'error-tracking', 'codex', 'default', 'none', null, null),
      row(4, 'error-tracking', 'claude_code', 'opus', 'unmeasured', null, null),
      row(
        6,
        'flags',
        'claude_code',
        'opus',
        'picked',
        '@acme/flags',
        'package',
      ),
      row(7, 'error-tracking', 'claude_code', 'opus', 'unmeasured', null, null),
      row(5, null, null, null, 'unmeasured', null, null),
    ]);
  });

  it('counts a run once when a directory and a bundle inside it are both named', async () => {
    await everyKind();
    const ctx = context();
    expect(
      await main(
        ['results', '--json', 'agentpicks-runs', `agentpicks-runs/${RUN(1)}`],
        ctx,
      ),
    ).toBe(0);
    const rows = JSON.parse(ctx.lines.join('\n')) as { runId: string }[];
    expect(rows.filter((r) => r.runId === RUN(1))).toHaveLength(1);
  });

  it('refuses an empty or missing directory, naming the fix', async () => {
    const missing = context();
    expect(await main(['results'], missing)).toBe(1);
    expect(missing.errors).toEqual([
      `${out} doesn't exist. Run agentpicks run to write bundles there, or pass the --out directory you gave it.`,
    ]);

    mkdirSync(out);
    const empty = context();
    expect(await main(['results'], empty)).toBe(1);
    expect(empty.errors).toEqual([
      `${out} holds no bundle: pass a bundle directory, or the --out directory of agentpicks run.`,
    ]);
  });

  it('reads a run’s pick with the early stop it recorded, not the installed catalogue', async () => {
    // Recorded by a version whose error-tracking early stop watched for Rollbar alone.
    await bundle(RUN(1), signals(',\n    "@sentry/nextjs": "^9.0.0"', ''), {
      earlyStop: { installPattern: '"rollbar"', codePattern: '__no-pick__' },
    });
    const ctx = context();
    expect(await main(['results'], ctx)).toBe(0);
    expect(ctx.lines[1]).toBe(
      '10000000  error-tracking  claude_code  opus   none',
    );
  });

  it('keeps bundle text from driving the terminal', async () => {
    await bundle(RUN(1), signals('', ''), {
      model: 'opus\u001b]52;c;cGF5bG9hZA==\u0007\u001b[2J',
    });
    const ctx = context();
    expect(await main(['results'], ctx)).toBe(0);
    expect(ctx.lines.join('\n')).not.toContain('\u001b');
    expect(ctx.lines.join('\n')).not.toContain('\u0007');
    expect(ctx.lines).toEqual([
      'RUN       SETUP           AGENT        MODEL                      PICK',
      '10000000  error-tracking  claude_code  opus]52;c;cGF5bG9hZA==[2J  none',
      '',
      'error-tracking: none 1 (1 run)',
    ]);
  });

  it('drops bidirectional and zero-width characters, so a row reads as it is', async () => {
    await bundle(RUN(1), signals('', ''), {
      model: 'op\u202eus\u200b\u2066x\u2069\ufeff',
    });
    const ctx = context();
    expect(await main(['results'], ctx)).toBe(0);
    expect(ctx.lines[1]).toBe(
      '10000000  error-tracking  claude_code  opusx  none',
    );
  });

  it('refuses a flag it does not take', async () => {
    const ctx = context();
    expect(await main(['results', '--csv'], ctx)).toBe(1);
    expect(ctx.errors[0]).toMatch(/takes bundle directories and --json/);
  });
});

function row(
  n: number,
  setup: string | null,
  agent: string | null,
  model: string | null,
  status: string,
  tool: string | null,
  signal: string | null,
) {
  return { runId: RUN(n), setup, agent, model, status, tool, signal };
}
