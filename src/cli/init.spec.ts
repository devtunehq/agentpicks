/**
 * ABOUTME: Drives `agentpicks init` against fixture repositories in temporary directories and a fake
 * machine: detection (a Next.js app, a pnpm monorepo, a directory with no package.json, a git remote
 * naming a catalogue tool), `--yes` and its named refusals, the wizard with scripted answers, a
 * custom job offline and drafted through a fake DevTune with its fallback, the overwrite refusal,
 * and every written file passing `validate` and planning as the matching `run --category`. Also
 * the flags (answering off a terminal, their refusals, the questions left to ask), the closing
 * command replayed into a second repository byte for byte, typed ranges, and `agentpicks catalogue`.
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

import { CATEGORY_REQUESTS } from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import { setupEnvironments } from '../catalogue/environments';
import { readSetupFile } from '../setup/files';
import { SETUP_MAX_COMPETITORS } from '../setup/rules';
import { categoryPlan, parseRunArgs, setupPlan, type RunPlan } from './args';
import { refused, stubFetch, TARGET } from './fake-devtune';
import { fakeHost } from './fake-host';
import type { HostIo } from './host';
import { detectRepository } from './init-detect';
import { main, type CliContext } from './main';
import { SCHEMA_LINE } from './setup-write';

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
    expect(setupText('error-tracking').split('\n')[0]).toBe(SCHEMA_LINE);
    expect(lines.slice(-2)).toEqual([
      'Run it with: agentpicks run error-tracking --no-upload',
      'That needs no DevTune account. To upload its runs to DevTune, sign in with agentpicks login.',
    ]);
    await validates('error-tracking');
  });

  it('writes the setup and says to run it with --no-upload when the API address is unusable', async () => {
    nextApp();
    const { ctx, lines, errors } = context(
      fakeHost({ env: { DEVTUNE_API_BASE_URL: 'invalid' } }),
      null,
    );
    expect(await main(['init', '--yes'], ctx)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines.at(-2)).toBe(
      'Run it with: agentpicks run error-tracking --no-upload',
    );
  });

  it('ends with run and no --no-upload where runs upload by default, or AGENTPICKS_NO_UPLOAD keeps them here', async () => {
    nextApp();
    const envs: Record<string, string>[] = [
      { DEVTUNE_API_KEY: TARGET.apiKey, DEVTUNE_PROJECT_ID: TARGET.projectId },
      { AGENTPICKS_NO_UPLOAD: '1' },
    ];
    for (const env of envs) {
      const { ctx, lines } = context(fakeHost({ env }), null);
      expect(await main(['init', '--yes', '--force'], ctx)).toBe(0);
      expect(lines.at(-1)).toBe('Run it with: agentpicks run error-tracking');
    }
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
      'agentpicks init can\'t ask "Category number, or your own job line" without a terminal. Pass --category or --job, or --yes to take its default.',
    ]);
  });
});

describe('the wizard', () => {
  it('asks again for competitors when more are listed than a setup tracks', async () => {
    nextApp();
    const rivals = CATEGORY_TOOLS.payments!.filter((key) => key !== 'stripe');
    const { ctx, questions, errors } = context(MACHINE(), [
      '2',
      'stripe',
      rivals.slice(0, SETUP_MAX_COMPETITORS + 1).join(', '),
      rivals.slice(0, 2).join(', '),
      'nextjs',
      'codex',
      '1',
      'checkout',
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    expect(
      questions.filter((question) => question.startsWith('Competitors')),
    ).toHaveLength(2);
    expect(errors[0]).toBe(
      `List at most ${SETUP_MAX_COMPETITORS} competitors, or all.`,
    );
    expect(setup('checkout').tools).toEqual({
      own: 'stripe',
      competitors: rivals.slice(0, 2),
    });
  });

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
      'Category number, or your own job line [5]: ',
      'Your tool: its number, or none [none]: ',
      'Competitors: their numbers or ranges separated by commas (2, 5-8), or all [all]: ',
      'Competitors: their numbers or ranges separated by commas (2, 5-8), or all [all]: ',
      'Where to test: this repository (repo), all stacks (all), or stack numbers or ranges separated by commas (1, 3-4) [repo]: ',
      'Agents separated by commas, or any [claude-code]: ',
      'Runs per agent and stack [1]: ',
      'Setup name, saved as agentpicks/<name>.yaml [payments]: ',
    ]);
    expect(errors[0]).toBe(
      `sentry isn't on the list. Give numbers from 1 to ${CATEGORY_TOOLS.payments!.length}, or all.`,
    );
    expect(setup('checkout')).toEqual({
      from: 'payments',
      tools: { own: 'stripe', competitors: ['paddle', 'lemon-squeezy'] },
      stacks: ['nextjs', 'rails'],
      agents: ['codex'],
      runs: 3,
    });
    await validates('checkout');
  });

  it("lists the categories, the chosen category's tools and its stacks, and takes each by number", async () => {
    nextApp();
    const keys = CATEGORY_TOOLS.payments!;
    const { ctx, lines } = context(MACHINE(), [
      '2',
      String(keys.indexOf('stripe') + 1),
      `${keys.indexOf('paddle') + 1}, ${keys.indexOf('lemon-squeezy') + 1}`,
      '1',
      'codex',
      '1',
      'checkout',
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    expect(lines).toContain(
      "DevTune's public categories. Choose one to write a setup that runs its tests on this machine:",
    );
    expect(lines).toContain('Payments tools DevTune tests:');
    expect(lines.some((line) => line.startsWith(`   1  ${keys[0]} `))).toBe(
      true,
    );
    expect(lines).toContain(
      'Stacks: starter apps a run can build in instead of this repository:',
    );
    expect(setup('checkout')).toMatchObject({
      from: 'payments',
      tools: { own: 'stripe', competitors: ['paddle', 'lemon-squeezy'] },
    });
    expect(setup('checkout').stacks).toHaveLength(1);
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
      // push saves a job with its recommend request, so it has no default.
      '',
      'What should I use for feature flags here? Pick one and set it up.',
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
    expect(errors).toContain(
      'Write the recommend request in 8 to 300 characters.',
    );
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
    expect(lines.slice(-2)).toEqual([
      'Run it with: agentpicks run add-feature-flags --no-upload',
      'That needs no DevTune account. To upload its runs to DevTune, sign in with agentpicks login, then run agentpicks push add-feature-flags.',
    ]);
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

  it('refuses under --yes a drafted job line that fails its checks, instead of asking again forever', async () => {
    const failed = toolDraft('launchdarkly', []);
    failed.body.data.status = 'failed';
    failed.body.data.error = 'The site could not be read.';
    const calls = stubFetch({
      [`POST ${DRAFTS}/job/draft`]: [jobDraft],
      [`POST ${DRAFTS}/tools/draft`]: [failed],
    });
    const { ctx, errors, questions } = context(SIGNED_IN(), null);
    expect(
      await main(['init', '--job', 'Add feature flags', '--yes'], ctx),
    ).toBe(1);
    expect(questions).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(errors.at(-1)).toMatch(
      /^tools: [^\n]*\nRun agentpicks init on a terminal to answer the requests and tools, or write the setup against agentpicks schema\.$/,
    );
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
      '',
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
        'What should I use for feature flags here? Pick one and set it up.',
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

describe('where to test', () => {
  it.each([
    {
      answer: 'all',
      written: { stacks: setupEnvironments('payments').map((env) => env.slug) },
    },
    { answer: 'repo', written: { repo: '.' } },
    { answer: '.', written: { repo: '.' } },
  ])(
    'writes $answer typed at the where-to-test question',
    async ({ answer, written }) => {
      nextApp();
      const { ctx, errors } = context(MACHINE(), [
        '2',
        'none',
        '',
        answer,
        '',
        '',
        'checkout',
      ]);
      expect(await main(['init'], ctx), errors.join('\n')).toBe(0);
      expect(errors).toEqual([]);
      const file = setup('checkout');
      expect(file).toMatchObject(written);
      expect('repo' in written ? file.stacks : file.repo).toBeUndefined();
      await validates('checkout');
    },
  );

  it('writes every stack the category runs in for --stack all, with or without the job given', async () => {
    const stacks = setupEnvironments('payments').map((env) => env.slug);
    nextApp();
    const given = context(MACHINE(), null);
    const argv = [
      'init',
      '--category',
      'payments',
      '--stack',
      'all',
      '--name',
      'checkout',
      '--yes',
    ];
    expect(await main(argv, given.ctx), given.errors.join('\n')).toBe(0);
    expect(setup('checkout').stacks).toEqual(stacks);
    const detected = context(MACHINE(), null);
    expect(
      await main(
        ['init', '--stack', 'all', '--name', 'detected', '--yes'],
        detected.ctx,
      ),
      detected.errors.join('\n'),
    ).toBe(0);
    expect(setup('detected').stacks).toEqual(
      setupEnvironments(setup('detected').from!).map((env) => env.slug),
    );
  });

  it('refuses all with other stacks, and repo as a --stack value', async () => {
    nextApp();
    for (const value of ['all,nextjs', 'repo']) {
      const { ctx, errors } = context(MACHINE(), null);
      expect(
        await main(
          ['init', '--category', 'payments', '--stack', value, '--yes'],
          ctx,
        ),
      ).toBe(1);
      expect(errors.join('\n')).toContain(
        "isn't a stack for payments. Give stack slugs, or all.",
      );
    }
  });
});

describe('agentpicks init flags', () => {
  const PAYMENTS = [
    '--category',
    'payments',
    '--tool',
    'stripe',
    '--competitors',
    'paddle,lemon-squeezy',
    '--stack',
    'nextjs',
    '--stack',
    'rails',
    '--agent',
    'codex',
    '--runs',
    '3',
    '--name',
    'checkout',
  ];
  const again = (lines: string[]) =>
    lines.find((line) =>
      line.startsWith('To write the same setup in another repository: '),
    );

  it.each([
    { form: 'repeated', argv: PAYMENTS },
    {
      form: 'as a comma list',
      argv: [
        ...PAYMENTS.slice(0, 6),
        '--stack',
        'nextjs,rails',
        ...PAYMENTS.slice(10),
      ],
    },
  ])(
    'writes a category setup off a terminal from flags alone, with --stack $form, asking nothing',
    async ({ argv }) => {
      nextApp();
      const { ctx, questions, errors, lines } = context(MACHINE(), null);
      expect(await main(['init', ...argv], ctx), errors.join('\n')).toBe(0);
      expect(questions).toEqual([]);
      expect(setup('checkout')).toEqual({
        from: 'payments',
        tools: { own: 'stripe', competitors: ['paddle', 'lemon-squeezy'] },
        stacks: ['nextjs', 'rails'],
        agents: ['codex'],
        runs: 3,
      });
      expect(lines).not.toContain(
        'Press Enter to take the default in brackets.',
      );
      expect(again(lines)).toBe(
        'To write the same setup in another repository: agentpicks init --category payments --tool stripe --competitors paddle,lemon-squeezy --stack nextjs --stack rails --agent codex --runs 3 --name checkout --yes',
      );
      await validates('checkout');
    },
  );

  it('refuses off a terminal at the first question no flag answers, naming its flag and --yes, and takes its default with --yes', async () => {
    nextApp();
    const argv = PAYMENTS.filter(
      (_, i) => PAYMENTS[i] !== '--runs' && PAYMENTS[i - 1] !== '--runs',
    );
    const refusedRun = context(MACHINE(), null);
    expect(await main(['init', ...argv], refusedRun.ctx)).toBe(1);
    expect(refusedRun.errors).toEqual([
      'agentpicks init can\'t ask "Runs per agent and stack" without a terminal. Pass --runs, or --yes to take its default.',
    ]);
    expect(() => setupText('checkout')).toThrow();

    const defaulted = context(MACHINE(), null);
    expect(await main(['init', ...argv, '--yes'], defaulted.ctx)).toBe(0);
    expect(defaulted.questions).toEqual([]);
    expect(setup('checkout').runs).toBe(undefined);
  });

  it('refuses a job line off a terminal without --yes, naming --yes, before drafting', async () => {
    nextApp();
    const calls = stubFetch({});
    const { ctx, errors } = context(SIGNED_IN(), null);
    expect(
      await main(['init', '--job', 'Add feature flags to my app'], ctx),
    ).toBe(1);
    expect(errors).toEqual([
      "agentpicks init can't ask a job line's requests and tools without a terminal, and they have no flags. Pass --yes to take DevTune's drafts, which needs a sign-in, or write the setup against agentpicks schema.",
    ]);
    expect(calls).toEqual([]);
  });

  it('refuses off a terminal a question with no default, naming its flag and why, not --yes', async () => {
    write('package.json', JSON.stringify({ name: 'notes' }));
    const noJob = context(fakeHost(), null);
    expect(await main(['init'], noJob.ctx)).toBe(1);
    expect(noJob.errors).toEqual([
      'agentpicks init can\'t ask "Category number, or your own job line" without a terminal, and can\'t choose a job: neither package.json nor the git remote names a catalogue tool. Run agentpicks init on a terminal to choose one. Or pass --category or --job.',
    ]);

    const noTest = context(fakeHost(), null);
    expect(
      await main(
        [
          'init',
          '--category',
          'payments',
          '--tool',
          'none',
          '--competitors',
          'all',
        ],
        noTest.ctx,
      ),
    ).toBe(1);
    expect(noTest.errors[0]).toMatch(
      /^agentpicks init can't ask "Where to test: this repository \(repo\), all stacks \(all\), or stack .*" without a terminal, and found nothing to test in: .* Run it in a git repository, or on a terminal to choose stacks\. Or pass --stack\.$/,
    );
  });

  /** PAYMENTS with `flag`'s value replaced, or `flag` added when it isn't there. */
  const withFlag = (flag: string, value: string) => {
    const i = PAYMENTS.indexOf(flag);
    return i < 0
      ? [...PAYMENTS, flag, value]
      : PAYMENTS.map((arg, j) => (j === i + 1 ? value : arg));
  };
  const rivals = CATEGORY_TOOLS.payments!.filter((key) => key !== 'stripe');

  it.each([
    {
      why: 'a list number for --category',
      argv: withFlag('--category', '1'),
      error:
        '--category takes keys, not list numbers such as 1. Give them from: agentpicks catalogue',
    },
    {
      why: 'a list number for --tool',
      argv: withFlag('--tool', '3'),
      error:
        '--tool takes keys, not list numbers such as 3. Give them from: agentpicks catalogue payments',
    },
    {
      why: 'list numbers for --competitors',
      argv: withFlag('--competitors', '2,4'),
      error:
        '--competitors takes keys, not list numbers such as 2. Give them from: agentpicks catalogue payments',
    },
    {
      why: 'a range for --competitors',
      argv: withFlag('--competitors', '2-4'),
      error:
        '--competitors takes keys, not list numbers such as 2-4. Give them from: agentpicks catalogue payments',
    },
    {
      why: 'a list number for --stack',
      argv: [...PAYMENTS.slice(0, 6), '--stack', '1', ...PAYMENTS.slice(10)],
      error:
        '--stack takes keys, not list numbers such as 1. Give them from: agentpicks catalogue payments',
    },
    {
      why: 'an unknown category',
      argv: withFlag('--category', 'invoicing'),
      error:
        '--category: There is no category invoicing. List the keys with: agentpicks catalogue',
    },
    {
      why: 'a job line for --category',
      argv: withFlag('--category', 'Add payments'),
      error:
        '--category: There is no category Add payments. List the keys with: agentpicks catalogue',
    },
    {
      why: 'an unknown tool',
      argv: withFlag('--tool', 'sentry'),
      error:
        "--tool: sentry isn't on the list. Give a tool key, or none. List the keys with: agentpicks catalogue payments",
    },
    {
      why: 'an unknown competitor',
      argv: withFlag('--competitors', 'paddle,sentry'),
      error:
        "--competitors: sentry isn't on the list. Give tool keys, or all. List the keys with: agentpicks catalogue payments",
    },
    {
      why: 'no competitors',
      argv: withFlag('--competitors', ''),
      error:
        '--competitors: Give tool keys, or all. List the keys with: agentpicks catalogue payments',
    },
    {
      why: 'more competitors than a setup tracks',
      argv: withFlag(
        '--competitors',
        rivals.slice(0, SETUP_MAX_COMPETITORS + 1).join(','),
      ),
      error: `--competitors: List at most ${SETUP_MAX_COMPETITORS} competitors, or all. List the keys with: agentpicks catalogue payments`,
    },
    {
      why: 'an unknown stack',
      argv: [
        ...PAYMENTS.slice(0, 6),
        '--stack',
        'nextjs,svelte',
        ...PAYMENTS.slice(10),
      ],
      error:
        "--stack: svelte isn't a stack for payments. Give stack slugs, or all. List the keys with: agentpicks catalogue payments",
    },
    {
      why: 'an unknown agent',
      argv: withFlag('--agent', 'cursor'),
      error: expect.stringMatching(
        /^--agent: Give up to four of .*, or any\.$/,
      ),
    },
    {
      why: 'runs past 100',
      argv: withFlag('--runs', '101'),
      error: '--runs: Give a whole number of runs, 1 to 100.',
    },
    {
      why: 'a bad name',
      argv: withFlag('--name', 'Checkout'),
      error:
        '--name: A name is lowercase letters, digits and hyphens, such as error-tracking.',
    },
    {
      why: '--category with --job',
      argv: [...PAYMENTS, '--job', 'Add payments'],
      error:
        'Pass --category or --job, not both: a setup tests a category or a job line of its own.',
    },
    {
      why: '--repo with --stack',
      argv: [...PAYMENTS, '--repo', '.'],
      error:
        'Pass --repo or --stack, not both: a setup tests this repository or stacks.',
    },
    {
      why: '--repo other than .',
      argv: ['--category', 'payments', '--repo', 'src'],
      error:
        "--repo takes only . (this repository's committed files), not src.",
    },
    {
      why: '--stack .',
      argv: ['--category', 'payments', '--stack', '.'],
      error:
        "--stack takes stack slugs. To test this repository's committed files, pass --repo .",
    },
    {
      why: '--tool with --job',
      argv: ['--job', 'Add payments', '--tool', 'stripe'],
      error:
        "--tool answers a category's questions, and Add payments is a job line. Pass --category, or leave it out.",
    },
    {
      why: '--competitors with --job',
      argv: ['--job', 'Add payments', '--competitors', 'paddle'],
      error:
        "--competitors answers a category's questions, and Add payments is a job line. Pass --category, or leave it out.",
    },
    {
      why: 'a category for --job',
      argv: ['--job', 'payments'],
      error:
        '--job: payments names a category. Pass it as --category payments.',
    },
    {
      why: 'a list number for --job',
      argv: ['--job', '99'],
      error:
        '--job: Write the job as a line of 8 to 300 characters, such as Add feature flags.',
    },
    {
      why: 'an unknown flag',
      argv: ['--category', 'payments', '--model', 'opus'],
      error: expect.stringContaining("'--model'"),
    },
  ])(
    'refuses $why on a terminal, asking nothing and writing nothing',
    async ({ argv, error }) => {
      nextApp();
      const { ctx, errors, questions, lines } = context(MACHINE(), []);
      expect(await main(['init', ...argv], ctx)).toBe(1);
      expect(errors).toEqual([error]);
      expect(questions).toEqual([]);
      expect(lines).toEqual([]);
      expect(() => setupText('checkout')).toThrow();
    },
  );

  it.each([
    {
      argv: ['--category', 'authentication', '--competitors', '2-4'],
      error:
        '--competitors takes keys, not list numbers such as 2-4. Give them from: agentpicks catalogue authentication',
    },
    {
      argv: ['--category', 'authentication', '--runs', '0'],
      error: '--runs: Give a whole number of runs, 1 to 100.',
    },
    {
      argv: ['--category', 'authentication', '--tool', 'stripe'],
      error:
        "--tool: stripe isn't on the list. Give a tool key, or none. List the keys with: agentpicks catalogue authentication",
    },
    {
      argv: ['--category', 'payments', '--stack', 'svelte'],
      error:
        "--stack: svelte isn't a stack for payments. Give stack slugs, or all. List the keys with: agentpicks catalogue payments",
    },
    {
      argv: ['--job', 'Add payments', '--stack', 'svelte'],
      error:
        "--stack: svelte isn't a stack for your own job. Give stack slugs, or all. List the keys with: agentpicks catalogue",
    },
    { argv: ['--agent', 'cursor'], error: expect.stringMatching(/^--agent: /) },
    {
      argv: ['--name', 'Checkout'],
      error:
        '--name: A name is lowercase letters, digits and hyphens, such as error-tracking.',
    },
    {
      argv: ['--category', 'payments', '--name', 'checkout'],
      error:
        '--name: agentpicks/checkout.yaml exists. Choose another name, or pass --force to replace it.',
    },
    {
      argv: ['--stack', '1'],
      error:
        '--stack takes keys, not list numbers such as 1. Give them from: agentpicks catalogue',
    },
    {
      argv: ['--stack', 'svelte'],
      error:
        "--stack: svelte isn't a stack. Give stack slugs, or all. List the keys with: agentpicks catalogue",
    },
    {
      argv: ['--tool', '3'],
      error:
        '--tool takes keys, not list numbers such as 3. Give them from: agentpicks catalogue <category>',
    },
    {
      argv: ['--competitors', '2'],
      error:
        '--competitors takes keys, not list numbers such as 2. Give them from: agentpicks catalogue <category>',
    },
  ])(
    'refuses $argv before listing or asking anything, on a terminal or off one',
    async ({ argv, error }) => {
      nextApp();
      write('agentpicks/checkout.yaml', 'from: payments\nstacks: [nextjs]\n');
      for (const answers of [[], null]) {
        const { ctx, errors, questions, lines } = context(MACHINE(), answers);
        expect(await main(['init', ...argv], ctx)).toBe(1);
        expect(errors).toEqual([error]);
        expect(questions).toEqual([]);
        expect(lines).toEqual([]);
      }
    },
  );

  it('says what a competitor that is the tool this repository names needs', async () => {
    write(
      'package.json',
      JSON.stringify({ name: 'stripe-demo', dependencies: { next: '16' } }),
    );
    git('init', '-q');
    const { ctx, errors } = context(MACHINE(), null);
    expect(
      await main(
        [
          'init',
          '--category',
          'payments',
          '--competitors',
          'stripe,paddle',
          '--yes',
        ],
        ctx,
      ),
    ).toBe(1);
    expect(errors).toEqual([
      '--competitors: stripe is your tool, as this repository names it. Pass --tool none, or leave stripe out. List the keys with: agentpicks catalogue payments',
    ]);
  });

  it('refuses a --name that exists before drafting a job line', async () => {
    nextApp();
    write('agentpicks/foo.yaml', 'from: payments\nstacks: [nextjs]\n');
    const calls = stubFetch({});
    const { ctx, errors } = context(SIGNED_IN(), null);
    expect(
      await main(
        [
          'init',
          '--job',
          'Add feature flags to the app',
          '--name',
          'foo',
          '--yes',
        ],
        ctx,
      ),
    ).toBe(1);
    expect(errors).toEqual([
      '--name: agentpicks/foo.yaml exists. Choose another name, or pass --force to replace it.',
    ]);
    expect(calls).toEqual([]);
  });

  it('prints the Enter hint first on a terminal with no flags, before the categories, as it always has', async () => {
    nextApp();
    const { ctx, lines } = context(MACHINE(), ['', '', '', '', '', '', '']);
    expect(await main(['init'], ctx)).toBe(0);
    expect(lines.slice(0, 2)).toEqual([
      'Press Enter to take the default in brackets.',
      "DevTune's public categories. Choose one to write a setup that runs its tests on this machine:",
    ]);
  });

  it('prints no Enter hint when flags answer every question on a terminal', async () => {
    nextApp();
    const { ctx, lines, questions } = context(MACHINE(), []);
    expect(await main(['init', ...PAYMENTS], ctx)).toBe(0);
    expect(questions).toEqual([]);
    expect(lines).not.toContain('Press Enter to take the default in brackets.');
  });

  it('refuses --tool after a job line typed on a terminal', async () => {
    nextApp();
    const { ctx, errors } = context(MACHINE(), ['Add payments to this app']);
    expect(await main(['init', '--tool', 'stripe'], ctx)).toBe(1);
    expect(errors).toEqual([
      "--tool answers a category's questions, and Add payments to this app is a job line. Pass --category, or leave it out.",
    ]);
  });

  it('asks only what the flags leave, listing only the lists those questions pick from', async () => {
    nextApp();
    const { ctx, lines, questions } = context(MACHINE(), [
      'stripe',
      'paddle',
      'nextjs',
      'codex',
      '',
      'checkout',
    ]);
    expect(await main(['init', '--category', 'payments'], ctx)).toBe(0);
    // The hint comes once, before the first list shown.
    expect(lines.filter((line) => line.startsWith('Press Enter'))).toHaveLength(
      1,
    );
    expect(lines.indexOf('Press Enter to take the default in brackets.')).toBe(
      lines.indexOf('Payments tools DevTune tests:') - 1,
    );
    expect(lines).not.toContain(
      "DevTune's public categories. Choose one to write a setup that runs its tests on this machine:",
    );
    expect(lines).toContain('Payments tools DevTune tests:');
    expect(lines).toContain(
      'Stacks: starter apps a run can build in instead of this repository:',
    );
    expect(questions.map((question) => question.split(':')[0])).toEqual([
      'Your tool',
      'Competitors',
      'Where to test',
      'Agents separated by commas, or any [claude-code]',
      'Runs per agent and stack [1]',
      'Setup name, saved as agentpicks/<name>.yaml [payments]',
    ]);
    expect(setup('checkout')).toEqual({
      from: 'payments',
      tools: { own: 'stripe', competitors: ['paddle'] },
      stacks: ['nextjs'],
      agents: ['codex'],
    });
  });

  it('lists no tools when --tool and --competitors answer both their questions', async () => {
    nextApp();
    const { ctx, lines } = context(MACHINE(), ['.', '', '', 'checkout']);
    expect(
      await main(
        [
          'init',
          '--category',
          'payments',
          '--tool',
          'none',
          '--competitors',
          'all',
        ],
        ctx,
      ),
    ).toBe(0);
    expect(lines).not.toContain('Payments tools DevTune tests:');
    expect(setup('checkout')).toEqual({
      from: 'payments',
      repo: '.',
      agents: ['claude-code'],
    });
  });

  it('writes with --yes alone the file it always has for a Next.js repository', async () => {
    nextApp();
    const { ctx } = context(MACHINE(), null);
    expect(await main(['init', '--yes'], ctx)).toBe(0);
    expect(setupText('error-tracking')).toBe(
      `${SCHEMA_LINE}\nfrom: error-tracking\ntools:\n  own: sentry\nrepo: .\nagents:\n  - claude-code\n`,
    );
  });

  /** Runs `command`'s flags off a terminal in a new Next.js repository, returning the file named `name`. */
  async function replay(command: string, name: string) {
    const first = dir;
    dir = mkdtempSync(join(tmpdir(), 'agentpicks-init-again-'));
    try {
      nextApp();
      const [program, init, ...argv] = command.split(' ');
      expect([program, init]).toEqual(['agentpicks', 'init']);
      const { ctx, errors, questions } = context(MACHINE(), null);
      expect(await main(['init', ...argv], ctx), errors.join('\n')).toBe(0);
      expect(questions).toEqual([]);
      return setupText(name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      dir = first;
    }
  }

  it.each([
    {
      why: 'every answer given',
      answers: [
        '2',
        'stripe',
        'paddle, lemon-squeezy',
        'nextjs, rails',
        'codex',
        '3',
        'checkout',
      ],
      name: 'checkout',
      command:
        'agentpicks init --category payments --tool stripe --competitors paddle,lemon-squeezy --stack nextjs --stack rails --agent codex --runs 3 --name checkout --yes',
    },
    {
      why: 'every default, the tool this repository names included',
      answers: ['', '', '', '', '', '', ''],
      name: 'error-tracking',
      command:
        'agentpicks init --category error-tracking --tool sentry --repo . --agent claude-code --name error-tracking --yes',
    },
    {
      why: 'no tool where this repository names one, and the defaults',
      answers: ['', 'none', '', '', '', '', ''],
      name: 'error-tracking',
      command:
        'agentpicks init --category error-tracking --tool none --repo . --agent claude-code --name error-tracking --yes',
    },
    {
      why: 'no tool and any agent, which say --tool none and --agent any',
      answers: ['2', '', '', '', 'any', '', 'checkout'],
      name: 'checkout',
      command:
        'agentpicks init --category payments --tool none --repo . --agent any --name checkout --yes',
    },
  ])(
    'ends a category setup with the command that writes it again, byte for byte: $why',
    async ({ answers, name, command }) => {
      nextApp();
      const { ctx, lines } = context(MACHINE(), answers);
      expect(await main(['init'], ctx)).toBe(0);
      expect(again(lines)).toBe(
        `To write the same setup in another repository: ${command}`,
      );
      expect(await replay(command, name)).toBe(setupText(name));
    },
  );

  it('prints no such command for a job line', async () => {
    write(
      'package.json',
      JSON.stringify({ name: '@acme/flagkit', dependencies: { next: '16' } }),
    );
    const { ctx, lines, questions, errors } = context(MACHINE(), [
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
      '',
    ]);
    expect(
      await main(['init', '--job', 'Add feature flags'], ctx),
      errors.join('\n'),
    ).toBe(0);
    expect(questions[0]).toBe('The add request, which a run asks: ');
    expect(setup('add-feature-flags').job).toBe('Add feature flags');
    expect(again(lines)).toBe(undefined);
  });
});

describe('ranges in typed answers', () => {
  it('picks competitors 2-4 and stacks 1-2, refusing a range backwards, from 0 or past the list', async () => {
    nextApp();
    const keys = CATEGORY_TOOLS.payments!;
    const { ctx, errors } = context(MACHINE(), [
      '2',
      'none',
      '4-2',
      '0-3',
      '1-99',
      '2-4',
      '4-2',
      '0-3',
      '1-99',
      '1-2',
      '',
      '',
      'checkout',
    ]);
    expect(await main(['init'], ctx)).toBe(0);
    const stacks = setupEnvironments('payments').map((env) => env.slug);
    expect(errors).toEqual([
      ...['4-2', '0-3', '1-99'].map(
        (entry) =>
          `${entry} isn't on the list. Give numbers from 1 to ${keys.length}, or all.`,
      ),
      ...['4-2', '0-3', '1-99'].map(
        (entry) =>
          `${entry} isn't a stack for payments. Give repo, all, or numbers from 1 to ${stacks.length}.`,
      ),
    ]);
    expect(setup('checkout')).toMatchObject({
      tools: { competitors: keys.slice(1, 4) },
      stacks: stacks.slice(0, 2),
    });
  });
});

describe('agentpicks catalogue', () => {
  const run = async (argv: string[]) => {
    const { ctx, lines, errors } = context(MACHINE(), null);
    const code = await main(['catalogue', ...argv], ctx);
    return { code, lines, errors };
  };
  const pairs = (items: { slug: string; name: string }[]) =>
    items.map(({ slug, name }) => ({ slug, name }));

  it('lists every category and the stacks a job line can run in, as text and JSON', async () => {
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.lines[0]).toBe('Categories:');
    for (const category of CATEGORY_REQUESTS)
      expect(
        text.lines.some((line) =>
          new RegExp(`^  ${category.slug} +${category.name}$`).test(line),
        ),
        category.slug,
      ).toBe(true);
    expect(text.lines).toContain('Stacks a job line can run in:');

    const json = await run(['--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.lines.join('\n'))).toEqual({
      categories: pairs(CATEGORY_REQUESTS),
      stacks: pairs(setupEnvironments('job-')),
    });
  });

  it("lists a category's tool keys and stacks, as text and JSON", async () => {
    const text = await run(['authentication']);
    expect(text.code).toBe(0);
    expect(text.lines[0]).toMatch(/^ {2}authentication +Authentication$/);
    for (const key of CATEGORY_TOOLS.authentication!)
      expect(text.lines).toContain(`  ${key}`);
    expect(text.lines).toContain('Stacks:');

    const json = await run(['authentication', '--json']);
    expect(JSON.parse(json.lines.join('\n'))).toEqual({
      category: { slug: 'authentication', name: 'Authentication' },
      tools: CATEGORY_TOOLS.authentication,
      stacks: pairs(setupEnvironments('authentication')),
    });
  });

  it('refuses an unknown category, naming agentpicks catalogue', async () => {
    const { code, errors } = await run(['invoicing', '--json']);
    expect(code).toBe(1);
    expect(errors).toEqual([
      'There is no category invoicing. List them with: agentpicks catalogue',
    ]);
  });
});
