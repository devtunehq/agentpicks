/**
 * ABOUTME: Drives `agentpicks list`, `pull`, `push` and `run <name>` against a fake DevTune: the sync
 * states of a linked file, pull and push in each, push's digest and setup_changed refusal, a new
 * file's push and its retry after a lost answer, an orphaned link, a job measuring a catalogue tool
 * by key and its runs reading Unmeasured without the tool's signals, and a linked or DevTune-only
 * setup's runs uploading under its DevTune setup while an unlinked category setup's upload is
 * unchanged; and a signed-in `run --category` running the project's copy of the category as
 * `run <copy-name>` would, creating it first, running the copy another save made, and stopping on
 * any other refusal, while signed out and --no-upload runs read and save no setups.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { findCategoryRequests } from '../catalogue/categories';
import type { Sandbox, SandboxProvider } from '../sandbox/provider';
import { fileDigest } from '../setup/link';
import { setupFileSchema } from '../setup/schema';
import {
  completed,
  created,
  JOB,
  refused,
  savedSetup,
  SETUPS,
  setupList,
  stubFetch,
  TARGET,
  UPLOADS,
} from './fake-devtune';
import { fakeHost } from './fake-host';
import { main, type CliContext } from './main';

const D = (c: string) => c.repeat(64);
const JOB_ID = '1a000000-0000-4000-8000-000000000001';
const COPY_ID = '1a000000-0000-4000-8000-000000000002';
const NEXTJS = { id: 'e0000000-0000-4000-8000-000000000001', slug: 'nextjs' };
const ERRORS = findCategoryRequests('error-tracking')!;

const FLAGS_SIGNALS = {
  packages: { npm: ['@acme/flags'] },
  configNames: ['ACME_FLAGS_KEY'],
  importPatterns: [],
  brandDomains: [],
};

/** The project's custom job, as GET agent-picks/setup returns it. */
function jobSetup(
  digest = D('a'),
  add = 'Add feature flags to this app, and put a new checkout page behind one.',
) {
  return {
    id: JOB_ID,
    category_slug: 'job-add-feature-flags',
    name: 'Add feature flags',
    kind: 'job',
    source_category_slug: null,
    snapshot_digest: digest,
    requests: {
      add,
      recommend: 'Recommend a feature flag service for this app.',
      hosted: null,
      improve: null,
    },
    tools: [
      {
        tool_key: 'acme-flags',
        display_name: 'Acme Flags',
        brand_domain: 'acme.dev',
        signals: FLAGS_SIGNALS,
      },
      {
        tool_key: 'launchdarkly',
        display_name: 'LaunchDarkly',
        brand_domain: null,
        signals: {
          packages: { npm: ['launchdarkly-node-server-sdk'] },
          configNames: [],
          importPatterns: [],
          brandDomains: [],
          dismissedYieldsTo: ['acme-flags'],
        },
      },
    ],
    own_tool_key: 'acme-flags',
    competitor_tool_keys: ['launchdarkly'],
    environments: [NEXTJS],
    agent_models: [
      { agent: 'claude_code', model: 'claude-opus-5-5' },
      { agent: 'muse_code', model: 'meta/muse-wonder-1.0' },
    ],
    building_blocks: { packages: { npm: ['unleash'] }, codePatterns: [] },
  };
}

/** The project's unedited copy of error-tracking. */
function copySetup(digest = D('b')) {
  return {
    id: COPY_ID,
    category_slug: 'error-tracking-copy',
    name: 'Error tracking',
    kind: 'copy',
    source_category_slug: 'error-tracking',
    snapshot_digest: digest,
    requests: Object.fromEntries(
      ['add', 'recommend', 'hosted', 'improve'].map((intent) => [
        intent,
        ERRORS.prompts.find((p) => p.intent === intent)?.text ?? null,
      ]),
    ),
    tools: [
      {
        tool_key: 'sentry',
        display_name: 'Sentry',
        brand_domain: 'sentry.io',
        signals: {
          packages: {},
          configNames: [],
          importPatterns: [],
          brandDomains: [],
        },
      },
    ],
    own_tool_key: 'sentry',
    competitor_tool_keys: [],
    environments: [NEXTJS],
    agent_models: [{ agent: 'claude_code', model: 'claude-sonnet-5-5' }],
    building_blocks: null,
  };
}

const SSO_SIGNALS = {
  packages: { npm: ['@acme/errors'] },
  configNames: ['ACME_ERRORS_KEY'],
  importPatterns: [],
  brandDomains: [],
};

/**
 * A copy of error-tracking holding the customer's own tool beside the catalogue's, which DevTune
 * lists by key alone, and leaving out the hosted request.
 */
function ownToolCopy(digest = D('b')) {
  const copy = copySetup(digest);
  return {
    ...copy,
    requests: { ...copy.requests, hosted: null },
    tools: [
      { ...copy.tools[0]!, signals: null },
      {
        tool_key: 'rollbar',
        display_name: 'Rollbar',
        brand_domain: 'rollbar.com',
        signals: null,
      },
      {
        tool_key: 'acme-errors',
        display_name: 'Acme Errors',
        brand_domain: 'acme.dev',
        signals: SSO_SIGNALS,
      },
    ],
    own_tool_key: 'acme-errors',
    competitor_tool_keys: ['sentry', 'rollbar'],
  };
}

const SIGNED_IN = {
  DEVTUNE_API_KEY: TARGET.apiKey,
  DEVTUNE_PROJECT_ID: TARGET.projectId,
  DEVTUNE_API_BASE_URL: TARGET.baseUrl,
};

/** A sandbox that completes every run. */
function fakeProvider(): SandboxProvider {
  const box: Sandbox & { imageDigest(): Promise<string> } = {
    id: 'fake-container',
    async exec(command) {
      if (command.includes('api.ipify.org'))
        return { exitCode: 0, stdout: '203.0.113.7\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async spawn() {},
    async writeFile() {},
    async readFile(path) {
      return (
        (
          {
            'meta.json': '{"exitCode":0,"wallSec":12.5}',
            'transcript.jsonl': '{"type":"result"}\n',
            'diff.patch': '+flags.init()\n',
          } as Record<string, string>
        )[path.split('/').at(-1)!] ?? null
      );
    },
    async destroy() {},
    imageDigest: async () => `sha256:${D('c')}`,
  };
  return { name: 'fake', create: async () => box, get: async () => box };
}

function context(env: Record<string, string> = SIGNED_IN) {
  const lines: string[] = [];
  const errors: string[] = [];
  const ctx: CliContext = {
    io: fakeHost({
      commands: { claude: '2.1.322 (Claude Code)' },
      env: { ANTHROPIC_API_KEY: 'sk-ant-api03-secret-value-000000', ...env },
    }),
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    cwd: repo,
    dockerfileDir: '/pkg/docker',
    stdinIsTerminal: true,
    docker: {
      version: async () => '29.9.2',
      platform: async () => 'linux/amd64',
      run: async () => ({ exitCode: 0, stdout: 'sha256:image\n', stderr: '' }),
      build: async () => 0,
      provider: () => fakeProvider(),
    },
  };
  return { ctx, lines, errors };
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentpicks-link-'));
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'agentpicks'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(repo, { recursive: true, force: true });
});

const setupPath = (name: string) => join(repo, 'agentpicks', `${name}.yaml`);
const readYaml = (name: string) =>
  setupFileSchema.parse(parse(readFileSync(setupPath(name), 'utf8')));

/** Pulls every DevTune setup given into the repository. */
async function pulled(setups: unknown[]) {
  stubFetch({ [`GET ${SETUPS}`]: [setupList(setups)] });
  const { ctx } = context();
  expect(await main(['pull'], ctx)).toBe(0);
}

describe('signed-out setup commands', () => {
  it.each(['push', 'pull'])(
    '%s asks for sign-in without an upload-only flag',
    async (command) => {
      writeFileSync(
        setupPath('errors'),
        'from: error-tracking\nstacks: [nextjs]\n',
      );
      const calls = stubFetch({});
      const run = context({});
      expect(await main([command], run.ctx)).toBe(1);
      expect(run.errors).toEqual([
        'Pushing or pulling setups needs a DevTune sign-in or project API key. Run agentpicks login, or set DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID.',
      ]);
      expect(calls).toEqual([]);
    },
  );
});

describe('agentpicks init then push', () => {
  it('saves detected stacks without editing the repo file, whose run still tests HEAD', async () => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Dev',
          GIT_AUTHOR_EMAIL: 'dev@example.com',
          GIT_COMMITTER_NAME: 'Dev',
          GIT_COMMITTER_EMAIL: 'dev@example.com',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '-q');
    git('remote', 'add', 'origin', 'git@github.com:getsentry/sentry-docs.git');
    writeFileSync(
      join(repo, 'package.json'),
      '{"name":"sentry-docs","dependencies":{"next":"16.0.0"}}',
    );
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
    git('add', 'package.json', 'package-lock.json');
    git('commit', '-qm', 'app');
    const head = git('rev-parse', 'HEAD');
    const init = context();
    expect(
      await main(['init', '--yes'], init.ctx),
      init.errors.join('\n'),
    ).toBe(0);
    expect(readYaml('error-tracking')).toMatchObject({ repo: '.' });
    expect(readYaml('error-tracking')).not.toHaveProperty('stacks');
    const original = readFileSync(setupPath('error-tracking'), 'utf8');
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([])],
      [`PUT ${SETUPS}`]: [savedSetup(COPY_ID, 'error-tracking-copy', D('b'))],
    });
    const push = context();
    expect(await main(['push'], push.ctx), push.errors.join('\n')).toBe(0);
    expect(JSON.parse(calls.at(-1)!.body!).environment_ids).toEqual([
      NEXTJS.id,
    ]);
    expect(readYaml('error-tracking')).toMatchObject({
      repo: '.',
      id: COPY_ID,
    });
    expect(readYaml('error-tracking')).not.toHaveProperty('stacks');
    const run = context();
    expect(
      await main(
        ['run', 'agentpicks/error-tracking.yaml', '--no-upload'],
        run.ctx,
      ),
      run.errors.join('\n'),
    ).toBe(0);
    const [id] = readdirSync(join(repo, 'agentpicks-runs'));
    const manifest = JSON.parse(
      readFileSync(join(repo, 'agentpicks-runs', id!, 'manifest.json'), 'utf8'),
    );
    expect(manifest.repository).toEqual({
      remoteUrl: 'github.com:getsentry/sentry-docs.git',
      commit: head,
    });
    expect(manifest.stack).toBeUndefined();

    // A lost save answer links only when DevTune holds the stacks the retry detects.
    for (const matches of [true, false]) {
      writeFileSync(setupPath('error-tracking'), original);
      const saved = {
        ...copySetup(),
        environments: matches ? [NEXTJS] : [],
      };
      stubFetch({
        [`GET ${SETUPS}`]: [setupList([saved]), setupList([saved])],
        [`PUT ${SETUPS}`]: [
          refused(409, 'setup_changed', 'The setup changed after it was read.'),
        ],
      });
      const retry = context();
      expect(await main(['push'], retry.ctx), retry.errors.join('\n')).toBe(
        matches ? 0 : 1,
      );
      expect(readYaml('error-tracking').id).toBe(matches ? COPY_ID : undefined);
    }
  });

  it('refuses a repo with no detectable stacks and says what to add', async () => {
    writeFileSync(
      setupPath('errors'),
      'from: error-tracking\nrepo: .\nagents: [claude-code]\n',
    );
    const calls = stubFetch({ [`GET ${SETUPS}`]: [setupList([])] });
    const push = context();
    expect(await main(['push'], push.ctx)).toBe(1);
    expect(push.errors).toEqual([
      "agentpicks/errors.yaml: couldn't detect any supported stacks for this repository. Replace repo: with stacks: (for example, stacks: [nextjs]), then push again. To test the repository, pass --repo to agentpicks run.",
    ]);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });
});

describe('agentpicks pull', () => {
  it('never writes through a symbolic link at the setup path or the agentpicks directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'agentpicks-outside-'));
    const planted = join(outside, 'planted.yaml');
    const pull = async (args: string[]) => {
      stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup()])] });
      const run = context();
      expect(await main(args, run.ctx)).not.toBe(0);
      return run.errors.join('\n');
    };
    try {
      // A dangling link where the setup's file would go.
      symlinkSync(planted, setupPath('add-feature-flags'));
      expect(await pull(['pull'])).toContain(
        'agentpicks/add-feature-flags.yaml is a symbolic link',
      );
      expect(existsSync(planted)).toBe(false);

      // --force with a link to a file that exists leaves the file as it was.
      writeFileSync(planted, 'keep\n');
      expect(await pull(['pull', '--force'])).toContain(
        'agentpicks/add-feature-flags.yaml is a symbolic link',
      );
      expect(readFileSync(planted, 'utf8')).toBe('keep\n');

      // The directory itself.
      rmSync(planted);
      rmSync(join(repo, 'agentpicks'), { recursive: true, force: true });
      symlinkSync(outside, join(repo, 'agentpicks'));
      expect(await pull(['pull'])).toContain('agentpicks is a symbolic link');
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes each DevTune setup as a file that validate passes, linked by id and the digest it saw', async () => {
    stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup(), copySetup()])] });
    const { ctx, lines, errors } = context();
    expect(await main(['pull'], ctx)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      'Pulled DevTune setup add-feature-flags to agentpicks/add-feature-flags.yaml.',
      'Pulled DevTune setup error-tracking to agentpicks/error-tracking.yaml.',
    ]);
    const job = readYaml('add-feature-flags');
    expect(job).toEqual({
      id: JOB_ID,
      synced: { setup: D('a'), file: expect.stringMatching(/^[a-f0-9]{64}$/) },
      job: 'Add feature flags',
      requests: {
        add: 'Add feature flags to this app, and put a new checkout page behind one.',
        recommend: 'Recommend a feature flag service for this app.',
      },
      tools: {
        own: {
          key: 'acme-flags',
          name: 'Acme Flags',
          domain: 'acme.dev',
          signals: {
            packages: { npm: ['@acme/flags'] },
            configNames: ['ACME_FLAGS_KEY'],
          },
        },
        competitors: [
          {
            key: 'launchdarkly',
            name: 'LaunchDarkly',
            signals: { packages: { npm: ['launchdarkly-node-server-sdk'] } },
          },
        ],
      },
      stacks: ['nextjs'],
      agents: ['claude-code'],
    });
    expect(job.synced!.file).toBe(fileDigest(job));
    // An unedited copy is its category with tools by key.
    expect(readYaml('error-tracking')).toEqual({
      id: COPY_ID,
      synced: { setup: D('b'), file: expect.any(String) },
      from: 'error-tracking',
      tools: { own: 'sentry' },
      stacks: ['nextjs'],
      agents: ['claude-code'],
    });

    const validate = context();
    expect(await main(['validate'], validate.ctx)).toBe(0);
    expect(validate.lines.at(-1)).toBe('2 of 2 setup files valid.');
  });

  it('leaves a file in sync alone, writes DevTune’s change, and replaces local changes only with --force', async () => {
    await pulled([jobSetup()]);
    const path = setupPath('add-feature-flags');

    stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup()])] });
    const same = context();
    expect(await main(['pull', 'add-feature-flags'], same.ctx)).toBe(0);
    expect(same.lines).toEqual([
      'agentpicks/add-feature-flags.yaml is in sync with DevTune.',
    ]);

    const changed = jobSetup(
      D('d'),
      'Add feature flags to this app, behind a settings page.',
    );
    stubFetch({ [`GET ${SETUPS}`]: [setupList([changed])] });
    const devtune = context();
    expect(await main(['pull'], devtune.ctx)).toBe(0);
    expect(readYaml('add-feature-flags').requests?.add).toBe(
      'Add feature flags to this app, behind a settings page.',
    );
    expect(readYaml('add-feature-flags').synced?.setup).toBe(D('d'));

    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'behind a settings page',
        'for beta users',
      ),
    );
    stubFetch({
      [`GET ${SETUPS}`]: [setupList([changed]), setupList([changed])],
    });
    const local = context();
    expect(await main(['pull', 'add-feature-flags'], local.ctx)).toBe(1);
    expect(local.errors).toEqual([
      "agentpicks/add-feature-flags.yaml has changes not pushed to DevTune. Push them with agentpicks push add-feature-flags, or pass --force to replace the file with DevTune's setup.",
    ]);
    expect(readFileSync(path, 'utf8')).toContain('for beta users');
    const forced = context();
    expect(
      await main(['pull', 'add-feature-flags', '--force'], forced.ctx),
    ).toBe(0);
    expect(readFileSync(path, 'utf8')).not.toContain('for beta users');
  });

  it('refuses an unlinked file in the way, and a file linked to a setup DevTune no longer has', async () => {
    writeFileSync(
      setupPath('add-feature-flags'),
      'from: error-tracking\nstacks: [nextjs]\n',
    );
    stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup()])] });
    const blocked = context();
    expect(await main(['pull'], blocked.ctx)).toBe(1);
    expect(blocked.errors).toEqual([
      "agentpicks/add-feature-flags.yaml isn't linked to the DevTune setup add-feature-flags. Rename the file and pull again, or pass --force to replace it.",
    ]);

    writeFileSync(
      setupPath('gone'),
      `id: 9f000000-0000-4000-8000-000000000000\nfrom: error-tracking\nstacks: [nextjs]\n`,
    );
    stubFetch({ [`GET ${SETUPS}`]: [setupList([]), setupList([])] });
    const orphan = context();
    expect(await main(['pull', 'gone'], orphan.ctx)).toBe(1);
    expect(orphan.errors).toEqual([
      'agentpicks/gone.yaml is linked to DevTune setup 9f000000-0000-4000-8000-000000000000, which the project no longer has. Remove id and synced from it to push it as a new setup, or delete the file.',
    ]);
    const push = context();
    expect(await main(['push', 'gone'], push.ctx)).toBe(1);
    expect(push.errors).toEqual(orphan.errors);
  });
});

describe('agentpicks list', () => {
  it('signed in, shows local files and DevTune setups with where each lives and its sync state', async () => {
    await pulled([jobSetup()]);
    const path = setupPath('add-feature-flags');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'put a new checkout page',
        'put a new cart page',
      ),
    );
    writeFileSync(
      setupPath('mine'),
      'from: error-tracking\nstacks: [express]\n',
    );
    stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup(), copySetup()])] });
    const { ctx, lines } = context();
    expect(await main(['list'], ctx)).toBe(0);
    expect(lines).toEqual([
      'NAME               WHERE    SYNC           JOB                FROM            TESTS    AGENTS             RUNS',
      'add-feature-flags  both     local changed  Add feature flags  -               nextjs   claude-code        1',
      'mine               local    -              Error tracking     error-tracking  express  the installed one  1',
      'error-tracking     DevTune  -              Error tracking     error-tracking  nextjs   claude-code        1',
    ]);
  });

  it.each([
    ['DevTune changed', jobSetup(D('d')), false],
    ['both changed', jobSetup(D('d')), true],
    ['in sync', jobSetup(), false],
  ] as const)('labels a linked file %s', async (label, setup, edit) => {
    await pulled([jobSetup()]);
    const path = setupPath('add-feature-flags');
    if (edit)
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace('checkout', 'cart'),
      );
    stubFetch({ [`GET ${SETUPS}`]: [setupList([setup])] });
    const { ctx, lines } = context();
    expect(await main(['list'], ctx)).toBe(0);
    expect(lines[1]).toContain(`both   ${label}`);
  });

  it('signed out, prints the same table as before and says how to see DevTune setups', async () => {
    writeFileSync(
      setupPath('errors'),
      'job: Add error tracking\nfrom: error-tracking\nstacks: [nextjs]\n',
    );
    const calls = stubFetch({});
    const { ctx, lines, errors } = context({});
    expect(await main(['list'], ctx)).toBe(0);
    expect(lines).toEqual([
      'NAME    JOB                 FROM            TESTS   AGENTS             RUNS',
      'errors  Add error tracking  error-tracking  nextjs  the installed one  1',
    ]);
    expect(errors).toEqual([
      'To list your DevTune setups here too, sign in with agentpicks login.',
    ]);
    expect(calls).toEqual([]);
  });

  it('with a key that can’t read setups, prints the files and DevTune’s refusal', async () => {
    writeFileSync(
      setupPath('errors'),
      'from: error-tracking\nstacks: [nextjs]\n',
    );
    stubFetch({
      [`GET ${SETUPS}`]: [
        refused(
          403,
          'forbidden',
          'This API key does not have the visibility.read scope',
        ),
      ],
    });
    const { ctx, lines, errors } = context();
    expect(await main(['list'], ctx)).toBe(0);
    expect(lines[0]).toMatch(/^NAME {4}JOB/);
    expect(errors).toEqual([
      "DevTune setups aren't listed: This API key does not have the visibility.read scope",
    ]);
  });
});

describe('agentpicks push', () => {
  it('sends nothing for a file in sync, and saves a local change with the digest it saw, then records the new one', async () => {
    await pulled([jobSetup()]);
    stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup()])] });
    const same = context();
    expect(await main(['push', 'add-feature-flags'], same.ctx)).toBe(0);
    expect(same.lines).toEqual([
      'agentpicks/add-feature-flags.yaml is in sync with DevTune; nothing to push.',
    ]);

    const path = setupPath('add-feature-flags');
    writeFileSync(
      path,
      `# Our flags job\n${readFileSync(path, 'utf8').replace('checkout page', 'cart page')}`,
    );
    const after = jobSetup(
      D('e'),
      'Add feature flags to this app, and put a new cart page behind one.',
    );
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([jobSetup()])],
      [`PUT ${JOB}`]: [savedSetup(JOB_ID, 'job-add-feature-flags', D('e'))],
    });
    const push = context();
    expect(await main(['push', 'add-feature-flags'], push.ctx)).toBe(0);
    expect(push.errors).toEqual([]);
    expect(push.lines).toEqual([
      'Pushed agentpicks/add-feature-flags.yaml to DevTune setup add-feature-flags.',
    ]);
    const body = JSON.parse(calls.find((c) => c.method === 'PUT')!.body!);
    expect(body).toEqual({
      job: 'Add feature flags',
      source_category_id: null,
      requests: {
        add: 'Add feature flags to this app, and put a new cart page behind one.',
        recommend: 'Recommend a feature flag service for this app.',
        hosted: null,
      },
      // What a file can't say is sent as DevTune holds it.
      building_blocks: { packages: { npm: ['unleash'] }, codePatterns: [] },
      tools: [
        {
          tool_key: 'acme-flags',
          display_name: 'Acme Flags',
          brand_domain: 'acme.dev',
          signals: FLAGS_SIGNALS,
        },
        {
          tool_key: 'launchdarkly',
          display_name: 'LaunchDarkly',
          brand_domain: null,
          signals: {
            packages: { npm: ['launchdarkly-node-server-sdk'] },
            configNames: [],
            importPatterns: [],
            brandDomains: [],
            dismissedYieldsTo: ['acme-flags'],
          },
        },
      ],
      own_tool_key: 'acme-flags',
      competitor_tool_keys: ['launchdarkly'],
      environment_ids: [NEXTJS.id],
      agent_models: [
        { agent: 'claude_code', model: 'claude-opus-5-5' },
        { agent: 'muse_code', model: 'meta/muse-wonder-1.0' },
      ],
      snapshot_digest: D('a'),
      setup: JOB_ID,
    });
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/^# Our flags job\n/);
    expect(readYaml('add-feature-flags').synced?.setup).toBe(D('e'));

    stubFetch({ [`GET ${SETUPS}`]: [setupList([after])] });
    const list = context();
    await main(['list'], list.ctx);
    expect(list.lines[1]).toContain('both   in sync');
  });

  it('records the digest the save committed, so an app edit landing just after the push reads as DevTune changed', async () => {
    await pulled([jobSetup()]);
    const path = setupPath('add-feature-flags');
    writeFileSync(path, readFileSync(path, 'utf8').replace('checkout', 'cart'));
    // The save commits D('e'); an edit in the app moves the setup on to D('f') before anything reads it again.
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([jobSetup()])],
      [`PUT ${JOB}`]: [savedSetup(JOB_ID, 'job-add-feature-flags', D('e'))],
    });
    expect(await main(['push', 'add-feature-flags'], context().ctx)).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(readYaml('add-feature-flags').synced?.setup).toBe(D('e'));

    stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup(D('f'))])] });
    const list = context();
    await main(['list'], list.ctx);
    expect(list.lines[1]).toContain('both   DevTune changed');
  });

  it('refuses a setup changed in DevTune since the file saw it, before sending and when DevTune refuses the digest', async () => {
    await pulled([jobSetup()]);
    const path = setupPath('add-feature-flags');
    writeFileSync(path, readFileSync(path, 'utf8').replace('checkout', 'cart'));
    const message =
      "The DevTune setup changed since agentpicks/add-feature-flags.yaml last saw it (setup_changed), so push didn't overwrite it. Run agentpicks pull add-feature-flags to take DevTune's version, then push again.";

    // Another save landed between this push's read and its write: DevTune refuses the stale digest.
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([jobSetup()])],
      [`PUT ${JOB}`]: [
        refused(
          409,
          'setup_changed',
          'The setup changed after it was read, so this save was not checked against it. Read the setup again and save.',
        ),
      ],
    });
    const raced = context();
    expect(await main(['push', 'add-feature-flags'], raced.ctx)).toBe(1);
    expect(raced.errors).toEqual([message]);
    expect(JSON.parse(calls.at(-1)!.body!).snapshot_digest).toBe(D('a'));
    expect(readYaml('add-feature-flags').synced?.setup).toBe(D('a'));

    // Read as changed, nothing is sent.
    const seen = stubFetch({
      [`GET ${SETUPS}`]: [setupList([jobSetup(D('d'))])],
    });
    const changed = context();
    expect(await main(['push'], changed.ctx)).toBe(1);
    expect(changed.errors).toEqual([
      'agentpicks/add-feature-flags.yaml and its DevTune setup both changed since the file last saw it (setup_changed). Copy your changes somewhere, run agentpicks pull add-feature-flags --force, apply them again, then push.',
    ]);
    expect(seen.map((c) => c.method)).toEqual(['GET']);
  });

  it('saves a new file as a new setup with a null digest and links it; a retry after a lost answer links the setup it made', async () => {
    const FLAGS = `job: Add feature flags
requests:
  add: Add feature flags to this app, and put a new checkout page behind one.
  recommend: Recommend a feature flag service for this app.
tools:
  own:
    key: acme-flags
    name: Acme Flags
    domain: acme.dev
    signals:
      packages:
        npm: ['@acme/flags']
      configNames: [ACME_FLAGS_KEY]
stacks: [nextjs]
agents: [claude-code]
`;
    writeFileSync(setupPath('flags'), FLAGS);
    const made = {
      ...jobSetup(),
      competitor_tool_keys: [],
      tools: [jobSetup().tools[0]],
      agent_models: [{ agent: 'claude_code', model: 'claude-sonnet-5-5' }],
    };
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([])],
      [`PUT ${JOB}`]: [savedSetup(JOB_ID, 'job-add-feature-flags', D('a'))],
    });
    const first = context();
    expect(await main(['push', 'flags'], first.ctx)).toBe(0);
    expect(first.lines).toEqual([
      'Pushed agentpicks/flags.yaml to DevTune, and linked agentpicks/flags.yaml to the setup it saved.',
    ]);
    const body = JSON.parse(calls.find((c) => c.method === 'PUT')!.body!);
    expect(body.snapshot_digest).toBeNull();
    expect(body).not.toHaveProperty('setup');
    expect(body.agent_models).toEqual([
      { agent: 'claude_code', model: 'claude-sonnet-5-5' },
    ]);
    expect(readYaml('flags')).toMatchObject({
      id: JOB_ID,
      synced: { setup: D('a') },
    });

    // The same push again, after its answer was lost: DevTune holds the job, so the null digest is refused.
    writeFileSync(setupPath('flags'), FLAGS);
    stubFetch({
      [`GET ${SETUPS}`]: [setupList([made]), setupList([made])],
      [`PUT ${JOB}`]: [
        refused(409, 'setup_changed', 'The setup changed after it was read.'),
      ],
    });
    const retry = context();
    expect(await main(['push', 'flags'], retry.ctx)).toBe(0);
    expect(retry.lines).toEqual([
      'DevTune already holds agentpicks/flags.yaml as setup add-feature-flags; linked agentpicks/flags.yaml to it.',
    ]);
    expect(readYaml('flags').id).toBe(JOB_ID);

    // A retry whose file writes what the save fills in or normalises (empty signal lists, a domain's case,
    // a flag left false) still saves what DevTune holds, so it links too.
    const spelled = FLAGS.replace(
      'domain: acme.dev',
      'domain: Acme.DEV',
    ).replace(
      '      configNames: [ACME_FLAGS_KEY]\n',
      '      configNames: [ACME_FLAGS_KEY]\n      importPatterns: []\n      brandDomains: []\n      aliases: []\n',
    );
    expect(spelled).toContain('aliases: []');
    const defaulted = {
      ...made,
      tools: [
        {
          ...made.tools[0]!,
          signals: { ...FLAGS_SIGNALS, frameworkBuiltIn: false },
        },
      ],
    };
    writeFileSync(setupPath('flags'), spelled);
    stubFetch({
      [`GET ${SETUPS}`]: [setupList([defaulted]), setupList([defaulted])],
      [`PUT ${JOB}`]: [
        refused(409, 'setup_changed', 'The setup changed after it was read.'),
      ],
    });
    const normalised = context();
    expect(await main(['push', 'flags'], normalised.ctx)).toBe(0);
    expect(normalised.errors).toEqual([]);
    expect(readYaml('flags').id).toBe(JOB_ID);

    // A retry whose stacks are listed in another order than DevTune holds them still links.
    const both = {
      ...made,
      environments: [
        NEXTJS,
        { id: 'e0000000-0000-4000-8000-000000000002', slug: 'express' },
      ],
    };
    writeFileSync(
      setupPath('flags'),
      FLAGS.replace('stacks: [nextjs]', 'stacks: [express, nextjs]'),
    );
    stubFetch({
      [`GET ${SETUPS}`]: [setupList([both]), setupList([both])],
      [`PUT ${JOB}`]: [
        refused(409, 'setup_changed', 'The setup changed after it was read.'),
      ],
    });
    const reordered = context();
    expect(
      await main(['push', 'flags'], reordered.ctx),
      reordered.errors.join('\n'),
    ).toBe(0);
    expect(readYaml('flags').id).toBe(JOB_ID);

    // A different file with that job line isn't linked to it: push says to pull it.
    writeFileSync(
      setupPath('flags'),
      FLAGS.replace('checkout page', 'cart page'),
    );
    stubFetch({
      [`GET ${SETUPS}`]: [setupList([made]), setupList([made])],
      [`PUT ${JOB}`]: [
        refused(409, 'setup_changed', 'The setup changed after it was read.'),
      ],
    });
    const other = context();
    expect(await main(['push', 'flags'], other.ctx)).toBe(1);
    expect(other.errors).toEqual([
      "DevTune already has a setup for this job: add-feature-flags, which this file isn't linked to. Run agentpicks pull add-feature-flags to write it as a file, copy your changes into that file, and push it.",
    ]);
  });

  it('saves a category setup through the setup route, and names what DevTune refuses', async () => {
    writeFileSync(
      setupPath('errors'),
      'from: error-tracking\ntools: {own: sentry}\nstacks: [nextjs]\nagents: [codex]\n',
    );
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([])],
      [`PUT ${SETUPS}`]: [savedSetup(COPY_ID, 'error-tracking-copy', D('b'))],
    });
    const { ctx } = context();
    expect(await main(['push', 'errors'], ctx)).toBe(0);
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({
      category_id: 'c0000000-0000-4000-8000-000000000001',
      tool_key: 'sentry',
      competitor_tool_keys: [],
      environment_ids: [NEXTJS.id],
      agent_models: [{ agent: 'codex', model: 'gpt-6.1-sol' }],
      snapshot_digest: null,
    });

    writeFileSync(
      setupPath('errors'),
      'from: error-tracking\nrequests:\n  add: Add error tracking to this app and its workers.\nstacks: [nextjs]\nagents: [codex]\n',
    );
    stubFetch({
      [`GET ${SETUPS}`]: [setupList([])],
      [`PUT ${SETUPS}`]: [
        refused(
          400,
          'names_tool',
          "Requests can't name a tool you're testing. Describe the job instead.",
        ),
      ],
    });
    const refusedPush = context();
    await expect(main(['push', 'errors'], refusedPush.ctx)).resolves.toBe(1);
    expect(refusedPush.errors).toEqual([
      "Requests can't name a tool you're testing. Describe the job instead.",
    ]);
  });

  it("pulls a copy's catalogue tools by key and its own tool in full, and pushes them by key through the setup route", async () => {
    await pulled([ownToolCopy()]);
    const file = readYaml('error-tracking-setup');
    expect(file.tools).toEqual({
      own: {
        key: 'acme-errors',
        name: 'Acme Errors',
        domain: 'acme.dev',
        signals: {
          packages: { npm: ['@acme/errors'] },
          configNames: ['ACME_ERRORS_KEY'],
        },
      },
      competitors: ['sentry', 'rollbar'],
    });

    const path = setupPath('error-tracking-setup');
    writeFileSync(path, readFileSync(path, 'utf8').replace('- sentry\n', ''));
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([ownToolCopy()])],
      [`PUT ${SETUPS}`]: [savedSetup(COPY_ID, 'error-tracking-copy', D('e'))],
    });
    const push = context();
    expect(await main(['push', 'error-tracking-setup'], push.ctx)).toBe(0);
    expect(push.errors).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${SETUPS}`,
      `PUT ${SETUPS}`,
    ]);
    expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({
      tool_key: 'acme-errors',
      competitor_tool_keys: ['rollbar'],
      setup: COPY_ID,
      snapshot_digest: D('b'),
    });
  });

  it("refuses a from file's own tool DevTune doesn't hold as written, before sending", async () => {
    const OWN = `from: error-tracking
tools:
  own:
    key: acme-errors
    name: Acme Errors
    signals:
      packages:
        npm: ['@acme/errors']
stacks: [nextjs]
agents: [codex]
`;
    writeFileSync(setupPath('errors'), OWN);
    const fresh = stubFetch({ [`GET ${SETUPS}`]: [setupList([])] });
    const added = context();
    expect(await main(['push', 'errors'], added.ctx)).toBe(1);
    expect(added.errors).toEqual([
      "agentpicks/errors.yaml: acme-errors isn't a tool of error-tracking. Add it to a category copy in the DevTune app, then run agentpicks pull.",
    ]);
    expect(fresh.map((c) => c.method)).toEqual(['GET']);

    // Linked, with the tool's signals edited in the file: DevTune holds it otherwise, so push refuses too.
    await pulled([ownToolCopy()]);
    const path = setupPath('error-tracking-setup');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        'ACME_ERRORS_KEY',
        'ACME_ERRORS_TOKEN',
      ),
    );
    const linked = stubFetch({
      [`GET ${SETUPS}`]: [setupList([ownToolCopy()])],
    });
    const edited = context();
    expect(await main(['push', 'error-tracking-setup'], edited.ctx)).toBe(1);
    expect(edited.errors).toEqual([
      "agentpicks/error-tracking-setup.yaml: acme-errors isn't a tool of error-tracking. Add it to a category copy in the DevTune app, then run agentpicks pull.",
    ]);
    expect(linked.map((c) => c.method)).toEqual(['GET']);

    // A catalogue tool by key that error-tracking doesn't measure and the copy doesn't hold.
    writeFileSync(
      path,
      readFileSync(path, 'utf8')
        .replace('ACME_ERRORS_TOKEN', 'ACME_ERRORS_KEY')
        .replace('- rollbar', '- clerk'),
    );
    const byKey = stubFetch({
      [`GET ${SETUPS}`]: [setupList([ownToolCopy()])],
    });
    const keyed = context();
    expect(await main(['push', 'error-tracking-setup'], keyed.ctx)).toBe(1);
    expect(keyed.errors.join('\n')).toMatch(
      /error-tracking has no tool clerk\. .*add clerk to a category copy in the DevTune app, then run agentpicks pull\./,
    );
    expect(byKey.map((c) => c.method)).toEqual(['GET']);
  });

  it("keeps a copy's left-out request through pull and push, and deleting an override or null goes back to the category's", async () => {
    await pulled([ownToolCopy()]);
    expect(readYaml('error-tracking-setup').requests).toEqual({ hosted: null });
    const path = setupPath('error-tracking-setup');

    // A change elsewhere sends the left-out request as left out, not the category's.
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('- claude-code', '- codex'),
    );
    const kept = stubFetch({
      [`GET ${SETUPS}`]: [setupList([ownToolCopy()])],
      [`PUT ${SETUPS}`]: [savedSetup(COPY_ID, 'error-tracking-copy', D('e'))],
    });
    expect(await main(['push', 'error-tracking-setup'], context().ctx)).toBe(0);
    expect(JSON.parse(kept.at(-1)!.body!).requests).toEqual({
      hosted: 'omitted',
    });

    // Deleting the null asks the category's hosted request again.
    const omitted = ownToolCopy(D('e'));
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('requests:\n  hosted: null\n', ''),
    );
    expect(readYaml('error-tracking-setup').requests).toBeUndefined();
    const revived = stubFetch({
      [`GET ${SETUPS}`]: [setupList([omitted])],
      [`PUT ${SETUPS}`]: [savedSetup(COPY_ID, 'error-tracking-copy', D('f'))],
    });
    expect(await main(['push', 'error-tracking-setup'], context().ctx)).toBe(0);
    expect(JSON.parse(revived.at(-1)!.body!).requests).toEqual({
      hosted: ERRORS.prompts.find((p) => p.intent === 'hosted')!.text,
    });
  });

  it('lists, pulls, pushes and runs a job measuring PostHog, a catalogue tool, by its key', async () => {
    const job = jobSetup();
    // DevTune lists a catalogue tool by key and display fields alone, in a job as in a copy.
    const posthog = (digest = D('a')) => ({
      ...jobSetup(digest),
      tools: [
        job.tools[0]!,
        {
          tool_key: 'posthog',
          display_name: 'PostHog',
          brand_domain: 'posthog.com',
          signals: null,
        },
      ],
      competitor_tool_keys: ['posthog'],
    });

    stubFetch({ [`GET ${SETUPS}`]: [setupList([posthog()])] });
    const listed = context();
    expect(await main(['list'], listed.ctx)).toBe(0);
    expect(listed.lines[1]).toBe(
      'add-feature-flags  DevTune  -     Add feature flags  -     nextjs  claude-code  1',
    );

    await pulled([posthog()]);
    expect(readYaml('add-feature-flags').tools).toEqual({
      own: {
        key: 'acme-flags',
        name: 'Acme Flags',
        domain: 'acme.dev',
        signals: {
          packages: { npm: ['@acme/flags'] },
          configNames: ['ACME_FLAGS_KEY'],
        },
      },
      competitors: ['posthog'],
    });
    stubFetch({ [`GET ${SETUPS}`]: [setupList([posthog()])] });
    const same = context();
    expect(await main(['push', 'add-feature-flags'], same.ctx)).toBe(0);
    expect(same.lines).toEqual([
      'agentpicks/add-feature-flags.yaml is in sync with DevTune; nothing to push.',
    ]);

    const path = setupPath('add-feature-flags');
    writeFileSync(path, readFileSync(path, 'utf8').replace('checkout', 'cart'));
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([posthog()])],
      [`PUT ${JOB}`]: [savedSetup(JOB_ID, 'job-add-feature-flags', D('e'))],
    });
    const push = context();
    expect(await main(['push', 'add-feature-flags'], push.ctx)).toBe(0);
    expect(push.errors).toEqual([]);
    const body = JSON.parse(calls.find((c) => c.method === 'PUT')!.body!);
    // DevTune's save fills in PostHog's signals: the setup's, else the catalogue's.
    expect(body.tools).toEqual([
      {
        tool_key: 'acme-flags',
        display_name: 'Acme Flags',
        brand_domain: 'acme.dev',
        signals: FLAGS_SIGNALS,
      },
      { tool_key: 'posthog' },
    ]);
    expect(body).toMatchObject({
      own_tool_key: 'acme-flags',
      competitor_tool_keys: ['posthog'],
      snapshot_digest: D('a'),
    });
  });

  it('carries a catalogue tool a job measures beside its own and competitors by key alone', async () => {
    const job = jobSetup();
    const beside = {
      ...job,
      tools: [
        ...job.tools,
        {
          tool_key: 'posthog',
          display_name: 'PostHog',
          brand_domain: 'posthog.com',
          signals: null,
        },
      ],
    };
    await pulled([beside]);
    const path = setupPath('add-feature-flags');
    writeFileSync(path, readFileSync(path, 'utf8').replace('checkout', 'cart'));
    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([beside])],
      [`PUT ${JOB}`]: [savedSetup(JOB_ID, 'job-add-feature-flags', D('e'))],
    });
    expect(await main(['push', 'add-feature-flags'], context().ctx)).toBe(0);
    const body = JSON.parse(calls.find((c) => c.method === 'PUT')!.body!);
    expect(body.tools.at(-1)).toEqual({ tool_key: 'posthog' });
  });
});

describe('agentpicks run, linked to DevTune', () => {
  const signIn =
    'Uploading needs a DevTune sign-in or project API key. Run agentpicks login, or set DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID. To keep bundles on this machine only, pass --no-upload.';

  it('keeps upload sign-in guidance for a signed-out run of a linked file', async () => {
    await pulled([jobSetup()]);
    const calls = stubFetch({});
    const run = context({});
    expect(await main(['run', 'add-feature-flags'], run.ctx)).toBe(1);
    expect(run.errors).toEqual([signIn]);
    expect(calls).toEqual([]);
    expect(existsSync(join(repo, 'agentpicks-runs'))).toBe(false);
  });

  it('keeps upload sign-in guidance for a signed-out upload of a linked bundle', async () => {
    await pulled([jobSetup()]);
    const calls = stubFetch({});
    const local = context({});
    expect(
      await main(['run', 'add-feature-flags', '--no-upload'], local.ctx),
    ).toBe(0);
    const [id] = readdirSync(join(repo, 'agentpicks-runs'));
    const upload = context({});
    expect(
      await main(['upload', join(repo, 'agentpicks-runs', id!)], upload.ctx),
    ).toBe(1);
    expect(upload.errors).toEqual([signIn]);
    expect(calls).toEqual([]);
  });

  function uploadReplies(runs: number) {
    return {
      [`POST ${UPLOADS}`]: Array.from({ length: runs }, () =>
        created('0f9d5a8e-5d1c-4b8e-9a43-3c1f0e6b7a21', [], {}),
      ),
      [`POST ${UPLOADS}/0f9d5a8e-5d1c-4b8e-9a43-3c1f0e6b7a21/complete`]:
        Array.from({ length: runs }, () =>
          completed('0f9d5a8e-5d1c-4b8e-9a43-3c1f0e6b7a21'),
        ),
    };
  }
  const uploadedCategory = (calls: ReturnType<typeof stubFetch>) =>
    calls
      .filter((c) => c.method === 'POST' && c.url === UPLOADS)
      .map((c) => JSON.parse(c.body!).request.category);

  it('refuses a DevTune setup by name that asks its own add request before any sandbox, saying to pull it', async () => {
    const calls = stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup()])] });
    const { ctx, errors } = context();
    let sandboxes = 0;
    ctx.docker!.provider = () => {
      sandboxes++;
      return fakeProvider();
    };
    expect(
      await main(['run', 'add-feature-flags', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    expect(errors).toEqual([
      'DevTune setup add-feature-flags asks its own add request, which agentpicks runs only from a setup file. Write it as a file with agentpicks pull add-feature-flags, then run that file; commit it for a workflow to run.',
    ]);
    expect(sandboxes).toBe(0);
    expect(uploadedCategory(calls)).toEqual([]);
    expect(existsSync(join(repo, 'agentpicks-runs'))).toBe(false);
  });

  it('runs a pulled DevTune job measuring a catalogue tool, recording the tool its run has no signals for', async () => {
    const job = jobSetup();
    const posthog = {
      ...job,
      tools: [
        job.tools[0]!,
        {
          tool_key: 'posthog',
          display_name: 'PostHog',
          brand_domain: 'posthog.com',
          signals: null,
        },
      ],
      competitor_tool_keys: ['posthog'],
    };
    stubFetch({
      [`GET ${SETUPS}`]: [
        setupList([posthog]),
        setupList([posthog]),
        setupList([posthog]),
      ],
      ...uploadReplies(1),
    });
    const pulled = context();
    expect(await main(['pull', 'add-feature-flags'], pulled.ctx)).toBe(0);
    const { ctx, errors } = context();
    expect(
      await main(['run', 'add-feature-flags', '--stack', 'nextjs'], ctx),
    ).toBe(0);
    expect(errors).toEqual([]);
    const [id] = readdirSync(join(repo, 'agentpicks-runs'));
    const manifest = JSON.parse(
      readFileSync(join(repo, 'agentpicks-runs', id!, 'manifest.json'), 'utf8'),
    );
    expect(manifest.setup).toMatchObject({
      name: 'add-feature-flags',
      id: JOB_ID,
      unrecognised: ['posthog'],
    });
  });

  it('uploads a linked custom file under its DevTune setup, and an unlinked category setup as its category, as before', async () => {
    await pulled([jobSetup()]);
    const linked = stubFetch({
      [`GET ${SETUPS}`]: [setupList([jobSetup()])],
      ...uploadReplies(1),
    });
    const run = context();
    expect(await main(['run', 'add-feature-flags'], run.ctx)).toBe(0);
    expect(uploadedCategory(linked)).toEqual(['job-add-feature-flags']);

    writeFileSync(
      setupPath('errors'),
      'from: error-tracking\nstacks: [nextjs]\n',
    );
    const plain = stubFetch(uploadReplies(1));
    const category = context();
    expect(await main(['run', 'errors'], category.ctx)).toBe(0);
    expect(uploadedCategory(plain)).toEqual(['error-tracking']);
    expect(plain.map((c) => c.url)).not.toContain(SETUPS);
  });

  it('refuses a linked file DevTune changed since its pull before Docker, saying to pull, with only the read linking makes', async () => {
    await pulled([jobSetup()]);
    const pull =
      "agentpicks/add-feature-flags.yaml's DevTune setup changed since the file last saw it, so its runs would ask what DevTune no longer holds. Run agentpicks pull add-feature-flags, then run it again, or pass --no-upload to keep the bundles on this machine.";
    // DevTune changed; then both changed once the file is edited too.
    for (const edit of [false, true]) {
      if (edit) {
        const path = setupPath('add-feature-flags');
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace('checkout', 'cart'),
        );
      }
      const calls = stubFetch({
        [`GET ${SETUPS}`]: [setupList([jobSetup(D('d'))])],
      });
      const run = context();
      expect(await main(['run', 'add-feature-flags'], run.ctx)).toBe(1);
      expect(run.errors).toEqual([pull]);
      expect(calls.map((c) => c.method)).toEqual(['GET']);
    }
    expect(() => readdirSync(join(repo, 'agentpicks-runs'))).toThrow();
  });

  it('refuses a linked file with changes not pushed before Docker, and with --no-upload, its bundle at upload', async () => {
    await pulled([jobSetup()]);
    const path = setupPath('add-feature-flags');
    writeFileSync(path, readFileSync(path, 'utf8').replace('checkout', 'cart'));
    const message =
      "agentpicks/add-feature-flags.yaml has changes not pushed to its DevTune setup, so its runs would ask what DevTune doesn't hold. Run agentpicks push add-feature-flags, then run it again, or pass --no-upload to keep the bundles on this machine.";

    const read = stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup()])] });
    const run = context();
    expect(await main(['run', 'add-feature-flags'], run.ctx)).toBe(1);
    expect(run.errors).toEqual([message]);
    expect(read.map((c) => c.method)).toEqual(['GET']);
    expect(() => readdirSync(join(repo, 'agentpicks-runs'))).toThrow();

    stubFetch({});
    const local = context();
    expect(
      await main(['run', 'add-feature-flags', '--no-upload'], local.ctx),
    ).toBe(0);
    const [id] = readdirSync(join(repo, 'agentpicks-runs'));
    const dir = join(repo, 'agentpicks-runs', id!);
    expect(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).setup,
    ).toMatchObject({ id: JOB_ID, unpushed: true });

    const calls = stubFetch({ [`GET ${SETUPS}`]: [setupList([jobSetup()])] });
    const upload = context();
    expect(await main(['upload', dir], upload.ctx)).toBe(1);
    expect(upload.errors).toEqual([
      `${dir} (a run of add-feature-flags) ran with changes not pushed to its DevTune setup, so it can't file under it. Run agentpicks push add-feature-flags, then run the setup again.`,
    ]);
    expect(calls).toEqual([]);
  });

  it("uploads an unedited linked copy's --no-upload bundle under its copy, not its category's series", async () => {
    await pulled([copySetup()]);
    stubFetch({});
    const local = context();
    expect(
      await main(['run', 'error-tracking', '--no-upload'], local.ctx),
    ).toBe(0);
    const [id] = readdirSync(join(repo, 'agentpicks-runs'));
    const dir = join(repo, 'agentpicks-runs', id!);
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    );
    expect(manifest.request.category).toBe('error-tracking');
    expect(manifest.setup).toMatchObject({ id: COPY_ID });

    const calls = stubFetch({
      [`GET ${SETUPS}`]: [setupList([copySetup()])],
      ...uploadReplies(1),
    });
    const upload = context();
    await main(['upload', dir], upload.ctx);
    expect(upload.errors).toEqual([]);
    expect(uploadedCategory(calls)).toEqual(['error-tracking-copy']);
  });

  it('refuses a linked file whose DevTune setup is gone before Docker, and a name neither has', async () => {
    writeFileSync(
      setupPath('gone'),
      `id: 9f000000-0000-4000-8000-000000000000\njob: Add feature flags\nrequests:\n  add: Add feature flags to this app.\ntools:\n  own: {key: acme-flags, name: Acme Flags, signals: {packages: {npm: ['@acme/flags']}}}\nstacks: [nextjs]\n`,
    );
    stubFetch({ [`GET ${SETUPS}`]: [setupList([]), setupList([])] });
    const gone = context();
    expect(await main(['run', 'gone'], gone.ctx)).toBe(1);
    expect(gone.errors).toEqual([
      'agentpicks/gone.yaml is linked to DevTune setup 9f000000-0000-4000-8000-000000000000, which the project no longer has. Remove id and synced from it to push it as a new setup, or delete the file.',
    ]);
    const missing = context();
    expect(await main(['run', 'payments'], missing.ctx)).toBe(1);
    expect(missing.errors).toEqual([
      `There is no setup payments in ${join(repo, 'agentpicks')}. Choose one of: gone.`,
    ]);
  });

  describe('run --category', () => {
    const CATEGORY_ID = 'c0000000-0000-4000-8000-000000000001';
    const category = [
      'run',
      '--category',
      'error-tracking',
      '--stack',
      'nextjs',
    ];
    const saves = (calls: ReturnType<typeof stubFetch>) =>
      calls.filter((c) => c.method === 'PUT' && c.url === SETUPS);
    const manifestOf = () => {
      const [id] = readdirSync(join(repo, 'agentpicks-runs'));
      const dir = join(repo, 'agentpicks-runs', id!);
      const manifest = JSON.parse(
        readFileSync(join(dir, 'manifest.json'), 'utf8'),
      );
      rmSync(join(repo, 'agentpicks-runs'), { recursive: true });
      return { request: manifest.request, setup: manifest.setup };
    };
    /** What a run planned: its Agent and Test lines, the bundle's request and setup, and the upload's category. */
    const planned = (lines: string[], calls: ReturnType<typeof stubFetch>) => ({
      lines: lines.filter((line) => /^(Agent|Test): /.test(line)),
      ...manifestOf(),
      uploaded: uploadedCategory(calls),
    });

    it("runs the project's copy as run <copy-name> would with the same flags", async () => {
      const copyCalls = stubFetch({
        [`GET ${SETUPS}`]: [setupList([copySetup()]), setupList([copySetup()])],
        ...uploadReplies(1),
      });
      const copy = context();
      expect(await main(category, copy.ctx)).toBe(0);
      expect(copy.errors).toEqual([]);
      expect(copy.lines).toContain(
        "Runs the project's setup of error-tracking, DevTune setup error-tracking, and uploads under it.",
      );
      expect(saves(copyCalls)).toEqual([]);
      const fromCategory = planned(copy.lines, copyCalls);

      const namedCalls = stubFetch({
        [`GET ${SETUPS}`]: [setupList([copySetup()]), setupList([copySetup()])],
        ...uploadReplies(1),
      });
      const named = context();
      expect(
        await main(['run', 'error-tracking', '--stack', 'nextjs'], named.ctx),
      ).toBe(0);
      expect(planned(named.lines, namedCalls)).toEqual(fromCategory);
      expect(fromCategory.uploaded).toEqual(['error-tracking-copy']);
      expect(fromCategory.setup).toMatchObject({
        id: COPY_ID,
        name: 'error-tracking',
      });
    });

    it('creates the copy when the project has none with the default stacks, says how to pull it, then runs it', async () => {
      // fastapi-aws runs in error-tracking but is offered unticked, so a new copy leaves it out.
      const none = setupList([]);
      none.body.data.catalogue.environments.push({
        id: 'e0000000-0000-4000-8000-000000000003',
        slug: 'fastapi-aws',
      });
      const calls = stubFetch({
        [`GET ${SETUPS}`]: [
          none,
          setupList([copySetup()]),
          setupList([copySetup()]),
        ],
        [`PUT ${SETUPS}`]: [savedSetup(COPY_ID, 'error-tracking-copy', D('b'))],
        ...uploadReplies(1),
      });
      const { ctx, lines, errors } = context();
      expect(await main(category, ctx)).toBe(0);
      expect(errors).toEqual([]);
      const [save] = saves(calls);
      expect(saves(calls)).toHaveLength(1);
      expect(JSON.parse(save!.body!)).toEqual({
        category_id: CATEGORY_ID,
        tool_key: null,
        competitor_tool_keys: [],
        environment_ids: [NEXTJS.id, 'e0000000-0000-4000-8000-000000000002'],
        agent_models: [{ agent: 'claude_code', model: 'claude-sonnet-5-5' }],
        snapshot_digest: null,
      });
      expect(lines).toContain(
        "Created the project's copy of error-tracking, DevTune setup error-tracking. Write it as a file with: agentpicks pull error-tracking",
      );
      expect(uploadedCategory(calls)).toEqual(['error-tracking-copy']);
    });

    it.each([
      ['category_in_use', 409],
      ['setup_changed', 409],
    ])(
      'runs the copy another save made meanwhile when the save is refused as %s',
      async (reason, status) => {
        const calls = stubFetch({
          [`GET ${SETUPS}`]: [
            setupList([]),
            setupList([copySetup()]),
            setupList([copySetup()]),
          ],
          [`PUT ${SETUPS}`]: [refused(status, reason, 'Refused.')],
          ...uploadReplies(1),
        });
        const { ctx, lines, errors } = context();
        expect(await main(category, ctx)).toBe(0);
        expect(errors).toEqual([]);
        expect(lines).toContain(
          "Another save made the project's copy of error-tracking meanwhile, DevTune setup error-tracking.",
        );
        expect(uploadedCategory(calls)).toEqual(['error-tracking-copy']);
      },
    );

    it("runs the project's setup saved on the public category itself, saving nothing", async () => {
      const onCategory = {
        ...copySetup(),
        kind: 'category',
        category_slug: 'error-tracking',
      };
      const calls = stubFetch({
        [`GET ${SETUPS}`]: [setupList([onCategory]), setupList([onCategory])],
        ...uploadReplies(1),
      });
      const { ctx, lines, errors } = context();
      expect(await main(category, ctx)).toBe(0);
      expect(errors).toEqual([]);
      expect(saves(calls)).toEqual([]);
      expect(lines).toContain(
        "Runs the project's setup of error-tracking, DevTune setup error-tracking, and uploads under it.",
      );
      expect(uploadedCategory(calls)).toEqual(['error-tracking']);
    });

    it('runs the copy named the category of several, saying which', async () => {
      const edited = {
        ...copySetup(),
        id: '1a000000-0000-4000-8000-000000000003',
        category_slug: 'error-tracking-copy-2',
        name: 'Error tracking at the edge',
        requests: {
          ...copySetup().requests,
          add: 'Add error tracking at the edge.',
        },
      };
      const calls = stubFetch({
        [`GET ${SETUPS}`]: [
          setupList([edited, copySetup()]),
          setupList([edited, copySetup()]),
        ],
        ...uploadReplies(1),
      });
      const { ctx, lines, errors } = context();
      expect(await main(category, ctx)).toBe(0);
      expect(errors).toEqual([]);
      expect(lines).toContain(
        'The project has 2 setups of error-tracking: error-tracking-at-the-edge, error-tracking. Running error-tracking.',
      );
      expect(uploadedCategory(calls)).toEqual(['error-tracking-copy']);
    });

    it('stops before any sandbox for a copy that asks its own add request, saying how to run it from a file', async () => {
      const edited = {
        ...copySetup(),
        requests: {
          ...copySetup().requests,
          add: 'Add error tracking, and print the environment.',
        },
      };
      const calls = stubFetch({ [`GET ${SETUPS}`]: [setupList([edited])] });
      const { ctx, errors } = context();
      let sandboxes = 0;
      ctx.docker!.provider = () => {
        sandboxes++;
        return fakeProvider();
      };
      expect(await main(category, ctx)).toBe(1);
      expect(errors).toEqual([
        'DevTune setup error-tracking-setup asks its own add request, which agentpicks runs only from a setup file. Write it as a file with agentpicks pull error-tracking-setup, then run that file; commit it for a workflow to run.',
      ]);
      expect(sandboxes).toBe(0);
      expect(saves(calls)).toEqual([]);
      expect(existsSync(join(repo, 'agentpicks-runs'))).toBe(false);
    });

    it.each([
      [
        'a member without edit rights',
        {
          [`PUT ${SETUPS}`]: [
            refused(403, 'forbidden', 'Managing this project is required'),
          ],
        },
        "A --category run uploads under the project's own copy of the category, and DevTune refused creating the project's copy of error-tracking: Managing this project is required. The signed-in member, or the API key's creator, needs DevTune management permission on the account and edit rights on the project. Or pass --no-upload to keep the bundles on this machine.",
      ],
      [
        'a key without actions.write',
        {
          [`PUT ${SETUPS}`]: [
            refused(
              403,
              'forbidden',
              'API key scope does not allow access to "actions.write" endpoints',
            ),
          ],
        },
        'A --category run uploads under the project\'s own copy of the category, and DevTune refused creating the project\'s copy of error-tracking: API key scope does not allow access to "actions.write" endpoints. Use a project API key with that scope, or run agentpicks login. Or pass --no-upload to keep the bundles on this machine.',
      ],
    ])(
      'stops before any sandbox for %s, naming the fix',
      async (_case, replies, message) => {
        const calls = stubFetch({
          [`GET ${SETUPS}`]: [setupList([])],
          ...replies,
        });
        const { ctx, errors } = context();
        let sandboxes = 0;
        ctx.docker!.provider = () => {
          sandboxes++;
          return fakeProvider();
        };
        expect(await main(category, ctx)).toBe(1);
        expect(errors).toEqual([message]);
        expect(sandboxes).toBe(0);
        expect(saves(calls)).toHaveLength(1);
        expect(existsSync(join(repo, 'agentpicks-runs'))).toBe(false);
      },
    );

    it("stops before any sandbox for a project whose plan doesn't include Agent Picks, and an unpublished category", async () => {
      const calls = stubFetch({
        [`GET ${SETUPS}`]: [
          refused(403, 'forbidden', 'Agent Picks is not available'),
          setupList([]),
        ],
      });
      const plan = context();
      expect(await main(category, plan.ctx)).toBe(1);
      expect(plan.errors).toEqual([
        "A --category run uploads under the project's own copy of the category, and DevTune refused reading the project's setups: Agent Picks is not available. The account's plan doesn't include Agent Picks; choose a plan that does. Or pass --no-upload to keep the bundles on this machine.",
      ]);
      const unpublished = context();
      expect(
        await main(
          ['run', '--category', 'ci', '--stack', 'nextjs'],
          unpublished.ctx,
        ),
      ).toBe(1);
      expect(unpublished.errors).toEqual([
        "DevTune hasn't published ci, so the project can't have a copy of it to upload under. Choose another category, or pass --no-upload to keep the bundles on this machine.",
      ]);
      expect(saves(calls)).toEqual([]);
      expect(existsSync(join(repo, 'agentpicks-runs'))).toBe(false);
    });

    it('signed out, reads and saves no setups and refuses as before', async () => {
      const calls = stubFetch({});
      const { ctx, errors } = context({});
      expect(await main(category, ctx)).toBe(1);
      expect(errors).toEqual([signIn]);
      expect(calls).toEqual([]);
    });

    it('with --no-upload, reads and saves no setups and runs the public category', async () => {
      const calls = stubFetch({});
      const { ctx } = context();
      expect(await main([...category, '--no-upload'], ctx)).toBe(0);
      expect(calls).toEqual([]);
      const { request, setup } = manifestOf();
      expect(request.category).toBe('error-tracking');
      expect(setup).toBeUndefined();
    });
  });
});
