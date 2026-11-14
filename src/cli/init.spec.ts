/**
 * ABOUTME: Drives `agentpicks init` against fixture repositories in temporary directories and a fake
 * machine: detection (a Next.js app, a pnpm monorepo, a directory with no package.json, a git remote
 * naming a catalogue tool), `--yes` and its named refusals, the wizard with scripted answers, a
 * custom job offline and drafted through a fake DevTune with its fallback, the overwrite refusal,
 * and every written file passing `validate` and planning as the matching `run --category`.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { readSetupFile } from '../setup/files';
import { categoryPlan, parseRunArgs, setupPlan, type RunPlan } from './args';
import { refused, stubFetch, TARGET } from './fake-devtune';
import { fakeHost } from './fake-host';
import type { HostIo } from './host';
import { detectRepository } from './init-detect';
import { main, type CliContext } from './main';

const ANTHROPIC_KEY = 'sk-ant-api03-secret-value-000000';
const DRAFTS = `${TARGET.baseUrl}/projects/${TARGET.projectId}/agent-picks`;

/** Claude Code installed and signed in; Codex installed without a key, so not signed in. */
const MACHINE = () =>
  fakeHost({
    commands: {
      claude: '2.1.322 (Claude Code)',
      codex: 'codex-cli 0.98.0',
    },
    env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
  });

/** The machine with a DevTune project key set, so init drafts through DevTune. */
const SIGNED_IN = () =>
  fakeHost({
    commands: { claude: '2.1.322 (Claude Code)' },
    env: {
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      DEVTUNE_API_KEY: TARGET.apiKey,
      DEVTUNE_PROJECT_ID: TARGET.projectId,
      DEVTUNE_API_BASE_URL: TARGET.baseUrl,
    },
  });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentpicks-init-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function write(path: string, text: string) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function git(...args: string[]) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
}

/** A Next.js app in a git repository whose remote names the error-tracking tool sentry. */
function nextApp() {
  write(
    'package.json',
    JSON.stringify({ name: 'docs-site', dependencies: { next: '16.0.0' } }),
  );
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:getsentry/sentry-docs.git');
}

function context(io: HostIo, answers: string[] | null) {
  const lines: string[] = [];
  const errors: string[] = [];
  const questions: string[] = [];
  const ctx: CliContext = {
    io,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    cwd: dir,
    dockerfileDir: '/pkg/docker',
    stdinIsTerminal: answers !== null,
    interactive: answers !== null,
    ask: async (question) => {
      questions.push(question);
      const answer = answers?.shift();
      if (answer === undefined) throw new Error(`unanswered: ${question}`);
      return answer;
    },
  };
  return { ctx, lines, errors, questions };
}

const setupText = (name: string) =>
  readFileSync(join(dir, 'agentpicks', `${name}.yaml`), 'utf8');
const setup = (name: string) => parse(setupText(name));

/** `validate` on the one file, as a customer would run it after init. */
async function validates(name: string) {
  const { ctx, lines, errors } = context(MACHINE(), null);
  expect(await main(['validate', name], ctx), errors.join('\n')).toBe(0);
  expect(lines).toContain(`agentpicks/${name}.yaml: valid`);
}

const withoutSetup = ({ setup: _setup, ...plan }: RunPlan) => plan;

describe('detection', () => {
  it('reads a Next.js app in a git repository: repo, stack, the tool its remote names, and the agents signed in', () => {
    nextApp();
    expect(detectRepository(join(dir), MACHINE())).toEqual({
      root: dir,
      git: true,
      stacks: ['nextjs'],
      stackSources: ['package.json'],
      packageName: 'docs-site',
      tool: {
        key: 'sentry',
        categories: ['error-tracking'],
        source: 'git remote',
      },
      agents: ['claude-code'],
    });
  });

  it("reads a pnpm monorepo's stacks from its lockfile's importers, and the tool from the package scope", () => {
    write(
      'package.json',
      JSON.stringify({ name: '@clerk/monorepo', private: true }),
    );
    write(
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .: {}',
        '  apps/web:',
        '    dependencies:',
        '      next: { specifier: 16.0.0, version: 16.0.0 }',
        '  apps/api:',
        '    dependencies:',
        '      express: { specifier: ^5.1.0, version: 5.1.0 }',
        '',
      ].join('\n'),
    );
    expect(detectRepository(dir, fakeHost())).toMatchObject({
      git: false,
      stacks: ['nextjs', 'express'],
      stackSources: ['pnpm-lock.yaml'],
      packageName: '@clerk/monorepo',
      tool: {
        key: 'clerk',
        categories: ['authentication'],
        source: 'package.json',
      },
      agents: [],
    });
  });

  it('reads FastAPI as a requirement or a quoted dependency, not fastapi-users or prose', () => {
    write('requirements.txt', 'fastapi-users==13.0\n# fastapi is great\n');
    write(
      'pyproject.toml',
      'description = "An app built on fastapi and more"\n',
    );
    expect(detectRepository(dir, fakeHost()).stacks).toEqual([]);
    write(
      'requirements.txt',
      'fastapi-users==13.0\nfastapi[standard]>=0.115\n',
    );
    expect(detectRepository(dir, fakeHost()).stacks).toEqual(['fastapi']);
    write('requirements.txt', '');
    write('pyproject.toml', 'dependencies = [\n  "fastapi >=0.115",\n]\n');
    expect(detectRepository(dir, fakeHost()).stacks).toEqual(['fastapi']);
  });

  it('finds nothing in a directory with no package.json', () => {
    write('README.md', '# notes\n');
    expect(detectRepository(dir, fakeHost())).toEqual({
      root: dir,
      git: false,
      stacks: [],
      stackSources: [],
      packageName: null,
      tool: null,
      agents: [],
    });
  });
});

describe('agentpicks init --yes', () => {
  it('writes a Next.js repository a file validate passes: its category, its tool, repo . and the agents signed in', async () => {
    nextApp();
    const { ctx, lines, questions } = context(MACHINE(), null);
    expect(await main(['init', '--yes'], ctx)).toBe(0);
    expect(questions).toEqual([]);
    expect(setup('error-tracking')).toEqual({
      from: 'error-tracking',
      tools: { own: 'sentry' },
      repo: '.',
      agents: ['claude-code'],
    });
    expect(lines.at(-1)).toBe('Run it with: agentpicks run error-tracking');
    await validates('error-tracking');
  });

  it('plans a category setup with every default as the matching run --category --stack', async () => {
    write(
      'package.json',
      JSON.stringify({ name: 'sentry-demo', dependencies: { next: '16' } }),
    );
    const { ctx, lines } = context(fakeHost(), null);
    expect(await main(['init', '--yes'], ctx)).toBe(0);
    expect(setup('error-tracking')).toEqual({
      from: 'error-tracking',
      tools: { own: 'sentry' },
      stacks: ['nextjs'],
    });
    expect(lines).toContain(
      'It names no agents, so run uses the one agent installed where it runs.',
    );
    const file = readSetupFile(join(dir, 'agentpicks', 'error-tracking.yaml'));
    expect(file.problems).toEqual([]);
    expect(
      withoutSetup(
        setupPlan(
          { ...file, setup: file.setup! },
          { out: './agentpicks-runs', upload: true },
          dir,
        ),
      ),
    ).toEqual(
      categoryPlan(
        parseRunArgs(['--category', 'error-tracking', '--stack', 'nextjs']),
        dir,
      ),
    );
  });

  it('refuses, by name, a job or a test it cannot detect, writing nothing', async () => {
    write('package.json', JSON.stringify({ name: 'notes' }));
    const noJob = context(fakeHost(), null);
    expect(await main(['init', '--yes'], noJob.ctx)).toBe(1);
    expect(noJob.errors).toEqual([
      "agentpicks init --yes can't choose a job: neither package.json nor the git remote names a catalogue tool. Run agentpicks init on a terminal to choose one.",
    ]);

    write('package.json', JSON.stringify({ name: 'stripe-notes' }));
    const noTest = context(fakeHost(), null);
    expect(await main(['init', '--yes'], noTest.ctx)).toBe(1);
    expect(noTest.errors[0]).toMatch(
      /^agentpicks init --yes found nothing to test in: .* isn't a git repository, and its package\.json and lockfiles name no framework of a stack \(.*\)\. Run it in a git repository, or on a terminal to choose stacks\.$/,
    );
    expect(() =>
      readFileSync(join(dir, 'agentpicks', 'payments.yaml')),
    ).toThrow();
  });

  it('never replaces a setup of the same name without --force', async () => {
    nextApp();
    write(
      'agentpicks/error-tracking.yaml',
      'from: error-tracking\nstacks: [nextjs]\n',
    );
    const refusedRun = context(MACHINE(), null);
    expect(await main(['init', '--yes'], refusedRun.ctx)).toBe(1);
    expect(refusedRun.errors).toEqual([
      'agentpicks/error-tracking.yaml exists. Choose another name, or pass --force to replace it.',
    ]);
    expect(setupText('error-tracking')).toBe(
      'from: error-tracking\nstacks: [nextjs]\n',
    );

    const forced = context(MACHINE(), null);
    expect(await main(['init', '--yes', '--force'], forced.ctx)).toBe(0);
    expect(setup('error-tracking').repo).toBe('.');
  });

  it('refuses to ask questions off a terminal, naming --yes', async () => {
    nextApp();
    const { ctx, errors } = context(MACHINE(), null);
    expect(await main(['init'], ctx)).toBe(1);
    expect(errors).toEqual([
      "agentpicks init asks questions, and this isn't a terminal. Run it on a terminal, or pass --yes to take every detected default.",
    ]);
  });
});

describe('the wizard', () => {
  it('writes the answers given, offering each detected default', async () => {
    nextApp();
    const { ctx, questions, errors } = context(MACHINE(), [
      '2',
      'stripe',
      'paddle, sentry, lemon-squeezy',
      'paddle, lemon-squeezy',
      'nextjs, rails',
      'codex',
      '3',
      'checkout',
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    expect(questions).toEqual([
      'Job: a category number, or your own job line [5]: ',
      'Your tool: a payments tool key, or none [none]: ',
      'Competitors: payments tool keys separated by commas, or all [all]: ',
      'Competitors: payments tool keys separated by commas, or all [all]: ',
      'Test in your repository (.) or in stacks separated by commas [.]: ',
      'Agents separated by commas, or any [claude-code]: ',
      'Runs per agent and stack [1]: ',
      'Name [payments]: ',
    ]);
    expect(errors[0]).toMatch(/^payments has no tool sentry\. Use stripe, /);
    expect(setup('checkout')).toEqual({
      from: 'payments',
      tools: { own: 'stripe', competitors: ['paddle', 'lemon-squeezy'] },
      stacks: ['nextjs', 'rails'],
      agents: ['codex'],
      runs: 3,
    });
    await validates('checkout');
  });

  it('writes a custom job offline from typed requests and packages, asking again until it passes validate', async () => {
    write(
      'package.json',
      JSON.stringify({ name: '@acme/flagkit', dependencies: { next: '16' } }),
    );
    const { ctx, errors, lines } = context(MACHINE(), [
      'Add feature flags',
      'short',
      'Add feature flags to this app, and put a new checkout page behind one.',
      '',
      'none',
      // A skipped tool and no competitors leave nothing a run can recognise, so it asks again.
      'none',
      'none',
      'Add feature flags to this app, and put a new checkout page behind one.',
      'What should I use for feature flags here? Pick one and set it up.',
      '',
      '',
      '',
      'launchdarkly-js-client-sdk',
      '',
      '',
      '',
      '',
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    expect(errors).toContain('Write the add request in 8 to 300 characters.');
    expect(errors).toContain('Answer the requests and tools again.');
    expect(setup('add-feature-flags')).toEqual({
      job: 'Add feature flags',
      requests: {
        add: 'Add feature flags to this app, and put a new checkout page behind one.',
        recommend:
          'What should I use for feature flags here? Pick one and set it up.',
      },
      tools: {
        own: {
          key: 'flagkit',
          name: 'flagkit',
          signals: { packages: { npm: ['@acme/flagkit'] } },
        },
        competitors: [
          {
            key: 'launchdarkly-js-client-sdk',
            name: 'launchdarkly-js-client-sdk',
            signals: { packages: { npm: ['launchdarkly-js-client-sdk'] } },
          },
        ],
      },
      stacks: ['nextjs'],
      agents: ['claude-code'],
    });
    expect(lines.at(-1)).toBe(
      'To upload its runs, first run: agentpicks push add-feature-flags, then agentpicks run add-feature-flags. To keep bundles on this machine only, run: agentpicks run add-feature-flags --no-upload.',
    );
    await validates('add-feature-flags');
  });
});

describe('drafting through DevTune', () => {
  const jobDraft = {
    status: 200,
    body: {
      data: {
        draft_id: 'd1',
        created_at: '2026-11-14T08:00:00Z',
        status: 'drafted',
        job: 'Add feature flags',
        requests: [
          {
            intent: 'add',
            text: 'Add feature flags to this app, and put a new checkout page behind one.',
          },
          {
            intent: 'recommend',
            text: 'What should I use for feature flags here? Pick one and set it up.',
          },
        ],
        building_blocks: { packages: {}, codePatterns: [] },
        competitors: [{ name: 'LaunchDarkly', domain: 'launchdarkly.com' }],
        rejected: [],
        error: null,
      },
    },
  };
  const toolDraft = (key: string, npm: string[]) => ({
    status: 200,
    body: {
      data: {
        draft_id: `d-${key}`,
        created_at: '2026-11-14T08:00:00Z',
        status: 'drafted',
        tool_key: key,
        signals: {
          packages: { npm },
          configNames: ['ACME FLAGS'],
          importPatterns: [],
          brandDomains: [`${key}.com`],
        },
        relationships: [],
        sources: [],
        rejected: [],
        error: null as string | null,
        failure: null,
      },
    },
  });

  it('drafts a custom job and its tools, offering the drafts as defaults', async () => {
    write(
      'package.json',
      JSON.stringify({ name: 'acme-flags', dependencies: { next: '16' } }),
    );
    const calls = stubFetch({
      [`POST ${DRAFTS}/job/draft`]: [jobDraft],
      [`POST ${DRAFTS}/tools/draft`]: [
        toolDraft('acme-flags', ['@acme/flags']),
        toolDraft('launchdarkly', ['launchdarkly-js-client-sdk']),
      ],
    });
    const { ctx, questions, errors } = context(SIGNED_IN(), [
      'Add feature flags',
      ...Array<string>(9).fill(''),
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    expect(errors).toEqual([]);
    expect(questions).toContain(
      'The add request, which a run asks [Add feature flags to this app, and put a new checkout page behind one.]: ',
    );
    expect(questions).toContain(
      "Competitors' names separated by commas, or none [LaunchDarkly]: ",
    );
    expect(calls.map((c) => [c.url, JSON.parse(c.body!)])).toEqual([
      [`${DRAFTS}/job/draft`, { job: 'Add feature flags' }],
      [
        `${DRAFTS}/tools/draft`,
        {
          tool_key: 'acme-flags',
          name: 'acme-flags',
          domain: null,
          job: 'Add feature flags',
          other_tools: [],
        },
      ],
      [
        `${DRAFTS}/tools/draft`,
        {
          tool_key: 'launchdarkly',
          name: 'LaunchDarkly',
          domain: 'launchdarkly.com',
          job: 'Add feature flags',
          other_tools: [{ tool_key: 'acme-flags', name: 'acme-flags' }],
        },
      ],
    ]);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TARGET.apiKey}`);
    expect(setup('add-feature-flags')).toMatchObject({
      job: 'Add feature flags',
      requests: {
        add: 'Add feature flags to this app, and put a new checkout page behind one.',
        recommend:
          'What should I use for feature flags here? Pick one and set it up.',
      },
      tools: {
        own: {
          key: 'acme-flags',
          signals: {
            packages: { npm: ['@acme/flags'] },
            brandDomains: ['acme-flags.com'],
          },
        },
        competitors: [
          {
            key: 'launchdarkly',
            name: 'LaunchDarkly',
            domain: 'launchdarkly.com',
            signals: { packages: { npm: ['launchdarkly-js-client-sdk'] } },
          },
        ],
      },
    });
    // The drafted config name has a space, which a setup file can't hold, so it is dropped.
    expect(setup('add-feature-flags').tools.own.signals.configNames).toBe(
      undefined,
    );
    await validates('add-feature-flags');
  });

  it('turns drafting off at the first failed tool draft, so later tools spend no drafts', async () => {
    write(
      'package.json',
      JSON.stringify({ name: 'acme', dependencies: { next: '16' } }),
    );
    const twoCompetitors = structuredClone(jobDraft);
    twoCompetitors.body.data.competitors = [
      { name: 'LaunchDarkly', domain: 'launchdarkly.com' },
      { name: 'Flagsmith', domain: 'flagsmith.com' },
    ];
    const failed = toolDraft('launchdarkly', []);
    failed.body.data.status = 'failed';
    failed.body.data.error = 'The site could not be read.';
    const calls = stubFetch({
      [`POST ${DRAFTS}/job/draft`]: [twoCompetitors],
      [`POST ${DRAFTS}/tools/draft`]: [failed],
    });
    const { ctx, errors, questions } = context(SIGNED_IN(), [
      'Add feature flags',
      '',
      '',
      '',
      'none',
      '',
      'launchdarkly-js-client-sdk',
      'flagsmith',
      '',
      '',
      '',
      '',
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    expect(errors).toEqual([
      "DevTune couldn't draft LaunchDarkly: The site could not be read. Continuing offline.",
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${DRAFTS}/job/draft`,
      `${DRAFTS}/tools/draft`,
    ]);
    expect(questions).toContain(
      "Flagsmith's npm packages separated by commas, or none [none]: ",
    );
    expect(setup('add-feature-flags').tools.competitors).toEqual([
      {
        key: 'launchdarkly',
        name: 'LaunchDarkly',
        domain: 'launchdarkly.com',
        signals: { packages: { npm: ['launchdarkly-js-client-sdk'] } },
      },
      {
        key: 'flagsmith',
        name: 'Flagsmith',
        domain: 'flagsmith.com',
        signals: { packages: { npm: ['flagsmith'] } },
      },
    ]);
    await validates('add-feature-flags');
  });

  it('strips terminal controls from questions and their defaults, from package.json and from DevTune', async () => {
    const osc52 = '\u001b]52;c;ZXZpbA==\u0007';
    write(
      'package.json',
      JSON.stringify({
        name: `acme${osc52}flags`,
        dependencies: { next: '16' },
      }),
    );
    const controlled = structuredClone(jobDraft);
    controlled.body.data.requests[0]!.text =
      'Add feature flags\u001b[2J\u001b[H to this app, behind a new checkout page.';
    controlled.body.data.competitors = [];
    stubFetch({
      [`POST ${DRAFTS}/job/draft`]: [controlled],
      [`POST ${DRAFTS}/tools/draft`]: [
        toolDraft('acme-flags', ['@acme/flags']),
      ],
    });
    const { ctx, questions, lines, errors } = context(SIGNED_IN(), [
      'Add feature flags',
      'Add feature flags to this app, and put a new checkout page behind one.',
      'none',
      'none',
      'Acme Flags',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    // Any C0 control but tab and newline, DEL, or a C1 control.
    const isControl = (c: string) => {
      const code = c.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 9 && code !== 10) ||
        (code >= 0x7f && code <= 0x9f)
      );
    };
    for (const text of [...questions, ...lines, ...errors])
      expect([...text].filter(isControl), text).toEqual([]);
    expect(questions).toContain(
      'The add request, which a run asks [Add feature flags[2J[H to this app, behind a new checkout page.]: ',
    );
    expect(questions).toContain(
      "Your tool's name, or none [acme]52;c;zxzpba==flags]: ",
    );
  });

  it.each([
    {
      why: 'a spent hourly allowance',
      reply: refused(
        409,
        'rate_limited',
        'This project has started its drafts for the hour. Try again later.',
      ),
      warning:
        "DevTune didn't draft: This project has started its drafts for the hour. Try again later. Continuing offline.",
    },
    {
      why: 'DevTune out of reach',
      reply: new TypeError('fetch failed'),
      warning: `DevTune didn't draft: Couldn't reach DevTune at ${TARGET.baseUrl} (TypeError). Check the connection and try again. Continuing offline.`,
    },
  ])(
    'falls back offline with one warning on $why',
    async ({ reply, warning }) => {
      write('package.json', JSON.stringify({ name: 'acme-flags' }));
      const calls = stubFetch({ [`POST ${DRAFTS}/job/draft`]: [reply] });
      const { ctx, errors } = context(SIGNED_IN(), [
        'Add feature flags',
        'Add feature flags to this app, and put a new checkout page behind one.',
        'none',
        'none',
        '',
        '',
        'none',
        'nextjs',
        '',
        '',
        '',
      ]);
      expect(await main(['init'], ctx)).toBe(0);
      expect(errors).toEqual([warning]);
      expect(calls).toHaveLength(1);
      expect(setup('add-feature-flags').tools).toEqual({
        own: {
          key: 'acme-flags',
          name: 'acme-flags',
          signals: { packages: { npm: ['acme-flags'] } },
        },
      });
      await validates('add-feature-flags');
    },
  );
});
