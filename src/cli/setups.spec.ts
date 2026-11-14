/**
 * ABOUTME: Drives `agentpicks run <setup>`, `list` and `validate` against setup files in a temporary
 * repository, a fake machine and a fake sandbox: the parity of a three-line setup with the matching
 * --category run, flag overrides, a custom setup's run and manifest, the upload refusal for a custom
 * setup in `run` and `upload`, the terminal picker, and the table and named problems.
 */
import {
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bundleManifestSchema } from '../bundle/schema';
import type { SandboxPlatform } from '../sandbox/platform';
import type { Sandbox, SandboxProvider } from '../sandbox/provider';
import { readSetupFile } from '../setup/files';
import {
  categoryPlan,
  parseRunArgs,
  parseRunCommand,
  setupPlan,
  type RunPlan,
} from './args';
import { TARGET } from './fake-devtune';
import { fakeHost } from './fake-host';
import type { HostIo } from './host';
import { main, type CliContext } from './main';

const ANTHROPIC_KEY = 'sk-ant-api03-secret-value-000000';
const OPENAI_KEY = 'sk-proj-secret-value-0000000000000';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const ARTIFACTS: Record<string, string> = {
  'meta.json': '{"exitCode":0,"wallSec":12.5}',
  'transcript.jsonl': '{"type":"result"}\n',
  'diff.patch': '+flags.init()\n',
};

const FLAGS_SETUP = `job: Add feature flags
requests:
  add: Add feature flags to this app, and put a new checkout page behind one.
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
`;

const ERRORS_SETUP = `job: Add error tracking
from: error-tracking
stacks: [nextjs]
`;

/** A sandbox that completes every run, recording each file written into it. */
function fakeProvider() {
  const written: { path: string; content: string }[] = [];
  const box: Sandbox & { imageDigest(): Promise<string> } = {
    id: 'fake-container',
    async exec(command) {
      if (command.includes('api.ipify.org'))
        return { exitCode: 0, stdout: '203.0.113.7\n', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async spawn() {},
    async writeFile(path, content) {
      written.push({ path, content: String(content) });
    },
    async readFile(path) {
      return ARTIFACTS[path.split('/').at(-1)!] ?? null;
    },
    async destroy() {},
    imageDigest: async () => DIGEST,
  };
  const provider: SandboxProvider = {
    name: 'fake',
    create: async () => box,
    get: async () => box,
  };
  return { provider, written };
}

function context(
  io: HostIo,
  provider: SandboxProvider,
  cwd: string,
  extra: Partial<CliContext> = {},
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const dockerCalls: string[] = [];
  const ctx: CliContext = {
    io,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    cwd,
    dockerfileDir: '/pkg/docker',
    stdinIsTerminal: true,
    docker: {
      version: async () => (dockerCalls.push('version'), '29.9.2'),
      platform: async (): Promise<SandboxPlatform> => (
        dockerCalls.push('platform'),
        'linux/amd64'
      ),
      run: async () => ({ exitCode: 0, stdout: 'sha256:image\n', stderr: '' }),
      build: async () => 0,
      provider: () => provider,
    },
    ...extra,
  };
  return { ctx, lines, errors, dockerCalls };
}

const CLAUDE_HOST = () =>
  fakeHost({
    commands: { claude: '2.1.322 (Claude Code)' },
    env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
  });

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentpicks-setups-'));
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'agentpicks'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function writeSetup(name: string, text: string): string {
  const path = join(repo, 'agentpicks', name);
  writeFileSync(path, text);
  return path;
}

function readSetup(name: string, text: string) {
  const file = readSetupFile(writeSetup(name, text));
  expect(file.problems).toEqual([]);
  return { ...file, setup: file.setup! };
}

function manifests(out: string) {
  return readdirSync(out).map((id) =>
    bundleManifestSchema.parse(
      JSON.parse(readFileSync(join(out, id, 'manifest.json'), 'utf8')),
    ),
  );
}

/** A plan without the setup it came from, which only a setup's plan records. */
const withoutSetup = ({ setup: _setup, ...plan }: RunPlan) => plan;

describe('run plans', () => {
  it('runs a three-line setup from a category exactly as the matching --category run', () => {
    const file = readSetup('errors.yaml', ERRORS_SETUP);
    const fromSetup = setupPlan(
      file,
      { out: './agentpicks-runs', upload: true },
      repo,
    );
    const fromCategory = categoryPlan(
      parseRunArgs(['--category', 'error-tracking', '--stack', 'nextjs']),
      repo,
    );
    expect(withoutSetup(fromSetup)).toEqual(fromCategory);
    expect(fromSetup.setup).toEqual({
      record: {
        name: 'errors',
        from: 'error-tracking',
        id: null,
        job: 'Add error tracking',
      },
      path: file.path,
      customReason: null,
    });

    const repoSetup = setupPlan(
      readSetup('repo.yaml', 'from: error-tracking\nrepo: .\nruns: 3\n'),
      { out: './agentpicks-runs', upload: true },
      join(repo, 'agentpicks'),
    );
    expect(withoutSetup(repoSetup)).toEqual(
      categoryPlan(
        parseRunArgs([
          '--category',
          'error-tracking',
          '--repo',
          '.',
          '--runs',
          '3',
        ]),
        repo,
      ),
    );
  });

  it('lets each flag override the file', () => {
    const file = readSetup(
      'flags.yaml',
      `${FLAGS_SETUP}agents: [claude-code, codex]\nruns: 2\n`,
    );
    const flags = { out: './runs', upload: false };
    const plan = setupPlan(file, flags, repo);
    expect(plan.tests.map((t) => t.environment.slug)).toEqual(['nextjs']);
    expect(plan.agents).toEqual([
      { agent: 'claude-code', model: undefined },
      { agent: 'codex', model: undefined },
    ]);
    expect(plan.runs).toBe(2);

    const overridden = setupPlan(
      file,
      {
        ...flags,
        stack: 'express',
        agent: 'pi',
        model: 'openai/gpt-6',
        runs: 5,
      },
      repo,
    );
    expect(overridden.tests.map((t) => t.environment.slug)).toEqual([
      'express',
    ]);
    expect(overridden.agents).toEqual([{ agent: 'pi', model: 'openai/gpt-6' }]);
    expect(overridden.runs).toBe(5);

    const onRepo = setupPlan(file, { ...flags, repo: '.', ref: 'v1' }, repo);
    expect(onRepo).toMatchObject({ repo, ref: 'v1' });
    expect(onRepo.tests.map((t) => t.environment.slug)).toEqual([
      'customer_repository',
    ]);

    expect(() => setupPlan(file, { ...flags, model: 'opus' }, repo)).toThrow(
      "--model sets one agent's model, and agentpicks/flags.yaml runs claude-code, codex. Pass --agent too.",
    );
    expect(() => setupPlan(file, { ...flags, ref: 'v1' }, repo)).toThrow(
      '--ref names a commit of --repo; pass --repo too.',
    );
    expect(() =>
      setupPlan(file, { ...flags, stack: 'rails-own-servers-eu' }, repo),
    ).toThrow(
      /^There is no stack rails-own-servers-eu for flags\. Choose one of: /,
    );
    expect(() =>
      setupPlan(readSetup('bare.yaml', 'from: error-tracking\n'), flags, repo),
    ).toThrow(
      'agentpicks/bare.yaml names no stacks or repo. Add stacks: or repo: to it, or pass --stack <stack> or --repo <path>.',
    );
  });

  it('reads a setup, the picker or --category from the command line', () => {
    expect(
      parseRunCommand(['errors', '--runs', '2'], { picker: false }),
    ).toEqual({
      kind: 'setup',
      setup: 'errors',
      flags: expect.objectContaining({ runs: 2, upload: true }),
    });
    expect(parseRunCommand(['--no-upload'], { picker: true })).toMatchObject({
      kind: 'setup',
      setup: null,
    });
    expect(
      parseRunCommand(['--category', 'ci', '--stack', 'nextjs'], {
        picker: true,
      }),
    ).toMatchObject({ kind: 'category', args: { category: 'ci' } });
    expect(() => parseRunCommand([], { picker: false })).toThrow(
      /^Choose a category with --category: .*\. Or name a setup: agentpicks run <setup>\.$/,
    );
    expect(() =>
      parseRunCommand(['errors', '--category', 'ci'], { picker: false }),
    ).toThrow(
      'Pass a setup or --category, not both: errors already says what to test.',
    );
  });
});

describe('agentpicks run <setup>', () => {
  it('runs a custom setup with --no-upload, stopping early on its tools, under a category DevTune has none of', async () => {
    writeSetup('flags.yaml', FLAGS_SETUP);
    const fake = fakeProvider();
    const { ctx, lines, errors } = context(CLAUDE_HOST(), fake.provider, repo);
    expect(await main(['run', 'flags', '--no-upload'], ctx)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toContain(
      "Test: the flags setup's add request on nextjs, 1 run, one after another",
    );

    const [manifest] = manifests(join(repo, 'agentpicks-runs'));
    // The bundle format's schema, which DevTune parses an upload with, drops the setup record.
    expect(manifest).not.toHaveProperty('setup');
    const [id] = readdirSync(join(repo, 'agentpicks-runs'));
    const written = JSON.parse(
      readFileSync(join(repo, 'agentpicks-runs', id!, 'manifest.json'), 'utf8'),
    );
    expect(written.setup).toEqual({
      name: 'flags',
      from: null,
      id: null,
      job: 'Add feature flags',
    });
    // The early stop it ran with, which `agentpicks results` reads the run's pick with.
    expect(written.earlyStop).toEqual({
      installPattern: '"@acme/flags"',
      codePattern: 'ACME_FLAGS_KEY',
    });
    expect(manifest).not.toHaveProperty('earlyStop');
    expect(manifest).toMatchObject({
      stack: { slug: 'nextjs' },
      request: {
        category: 'setup:flags',
        intent: 'add',
        prompt: expect.stringContaining(
          'Add feature flags to this app, and put a new checkout page behind one.',
        ),
      },
    });
    const prompt = fake.written.find((f) => f.path.endsWith('/prompt.txt'));
    expect(prompt?.content).toBe(manifest!.request.prompt);
    const watcher = fake.written.find((f) =>
      f.content.includes('PICKPKG='),
    )?.content;
    expect(watcher).toContain(`PICKPKG='"@acme/flags"'`);
    expect(watcher).toContain(`PICKCODE='ACME_FLAGS_KEY'`);
  });

  it('runs each agent on each stack, the number of runs the file says', async () => {
    writeSetup(
      'errors.yaml',
      'from: error-tracking\nstacks: [nextjs, express]\nagents: [claude-code, codex]\nruns: 2\n',
    );
    const io = fakeHost({
      commands: { claude: '2.1.322 (Claude Code)', codex: 'codex-cli 0.130.0' },
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY },
    });
    const { ctx, lines, errors } = context(io, fakeProvider().provider, repo);
    expect(await main(['run', 'errors', '--no-upload'], ctx)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toContain('Run 8 of 8');
    expect(lines).toContain('  Codex on express');
    const runs = manifests(join(repo, 'agentpicks-runs')).map(
      (m) => `${m.agent.kind} ${m.stack!.slug} ${m.request.category}`,
    );
    expect(runs.sort()).toEqual(
      [
        'claude_code nextjs error-tracking',
        'claude_code nextjs error-tracking',
        'claude_code express error-tracking',
        'claude_code express error-tracking',
        'codex nextjs error-tracking',
        'codex nextjs error-tracking',
        'codex express error-tracking',
        'codex express error-tracking',
      ].sort(),
    );
  });

  it("checks a later agent's credentials again at its first run, not only before Docker", async () => {
    writeSetup(
      'errors.yaml',
      'from: error-tracking\nstacks: [nextjs]\nagents: [claude-code, codex]\nruns: 1\n',
    );
    // Records which run each read of Codex's key happened in.
    const readsIn: string[] = [];
    let lines: string[] = [];
    const env = new Proxy(
      { ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENAI_API_KEY: OPENAI_KEY },
      {
        get(target, key: string) {
          if (key === 'OPENAI_API_KEY')
            readsIn.push(
              lines.findLast((l) => l.startsWith('Run ')) ?? 'before',
            );
          return target[key as keyof typeof target];
        },
      },
    );
    const io = fakeHost({
      commands: { claude: '2.1.322 (Claude Code)', codex: 'codex-cli 0.130.0' },
      env,
    });
    const run = context(io, fakeProvider().provider, repo);
    lines = run.lines;
    expect(await main(['run', 'errors', '--no-upload'], run.ctx)).toBe(0);
    expect(readsIn).toContain('Run 2 of 2');
  });

  it('refuses to upload an unlinked custom setup before Docker is touched, naming why and saying to push', async () => {
    writeSetup('flags.yaml', FLAGS_SETUP);
    writeSetup(
      'reworded.yaml',
      'from: error-tracking\nrequests:\n  add: Add Sentry.\nstacks: [nextjs]\n',
    );
    for (const [name, why] of [
      ['flags', 'it has its own job'],
      ['reworded', "its add request isn't error-tracking's"],
    ]) {
      const { ctx, errors, dockerCalls } = context(
        CLAUDE_HOST(),
        fakeProvider().provider,
        repo,
      );
      expect(await main(['run', name!], ctx)).toBe(1);
      expect(errors).toEqual([
        `agentpicks/${name}.yaml is a custom setup (${why}), so its runs have no DevTune setup to upload under. Run agentpicks push ${name} to save it to DevTune first, or pass --no-upload to keep the bundles on this machine.`,
      ]);
      expect(dockerCalls).toEqual([]);
    }
  });

  it('uploads a setup from a category as that category, so it needs a login like --category', async () => {
    writeSetup('errors.yaml', ERRORS_SETUP);
    const { ctx, errors, dockerCalls } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
    );
    expect(await main(['run', 'errors'], ctx)).toBe(1);
    expect(errors[0]).toMatch(/agentpicks login/);
    expect(errors[0]).not.toMatch(/custom setup/);
    expect(dockerCalls).toEqual([]);
  });

  it('prints every problem of an invalid setup, by file and field, and starts nothing', async () => {
    writeSetup('broken.yml', 'from: logging\nstacks: [nextjs]\nrun: 2\n');
    const { ctx, errors, dockerCalls } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
    );
    expect(await main(['run', 'agentpicks/broken.yml'], ctx)).toBe(1);
    expect(errors).toEqual([
      'agentpicks/broken.yml: from: Use a built-in category: authentication, payments, transactional-email, databases, error-tracking, ci.',
      "agentpicks/broken.yml: (file): run isn't a setup field here. Check the spelling, or remove it.",
      'Fix the setup file, then run it again.',
    ]);
    expect(dockerCalls).toEqual([]);
  });

  it('refuses a setup name that isn’t there, listing the ones that are', async () => {
    writeSetup('errors.yaml', ERRORS_SETUP);
    const { ctx, errors } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
    );
    expect(await main(['run', 'payments'], ctx)).toBe(1);
    expect(errors).toEqual([
      `There is no setup payments in ${join(repo, 'agentpicks')}. Choose one of: errors.`,
    ]);
  });

  it('offers the setups on a terminal when none is named, and runs the one chosen', async () => {
    writeSetup('errors.yaml', ERRORS_SETUP);
    writeSetup('flags.yaml', FLAGS_SETUP);
    const asked: string[] = [];
    const { ctx, lines, errors } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      join(repo, 'agentpicks'),
      {
        interactive: true,
        ask: async (question) => (asked.push(question), '2'),
      },
    );
    expect(await main(['run', '--no-upload'], ctx)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines.slice(0, 3)).toEqual([
      'Setups:',
      '   1  errors  Add error tracking',
      '   2  flags  Add feature flags',
    ]);
    expect(asked).toEqual(['Run which setup? (1-2) ']);
    expect(lines).toContain(
      "Test: the flags setup's add request on nextjs, 1 run, one after another",
    );
  });

  it('points to agentpicks init when a terminal run finds no setups', async () => {
    const { ctx, errors } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
      {
        interactive: true,
        ask: async () => '1',
      },
    );
    expect(await main(['run'], ctx)).toBe(1);
    expect(errors[0]).toMatch(
      /holds no setup files\. Write one with: agentpicks init\n\nOr run a built-in category: agentpicks run --category <category> --stack <stack>\.$/,
    );
  });
});

describe('agentpicks upload', () => {
  it('refuses an unlinked custom setup’s bundle by its category, with or without the setup record', async () => {
    writeSetup('flags.yaml', FLAGS_SETUP);
    const run = context(CLAUDE_HOST(), fakeProvider().provider, repo);
    expect(await main(['run', 'flags', '--no-upload'], run.ctx)).toBe(0);
    const [id] = readdirSync(join(repo, 'agentpicks-runs'));
    const dir = join(repo, 'agentpicks-runs', id!);

    const io = fakeHost({
      env: {
        DEVTUNE_API_KEY: TARGET.apiKey,
        DEVTUNE_PROJECT_ID: TARGET.projectId,
        DEVTUNE_API_BASE_URL: TARGET.baseUrl,
      },
    });
    const { ctx, errors } = context(io, fakeProvider().provider, repo);
    expect(await main(['upload', dir], ctx)).toBe(1);
    const refusal = `${dir} is a run of the custom setup flags, which isn't linked to a DevTune setup, so it can't upload. Run agentpicks push to save the setup to DevTune, then run it again.`;
    expect(errors).toEqual([refusal]);

    // As 0.2.0 or any reader of the bundle format would hold it: the record gone, the category kept.
    const path = join(dir, 'manifest.json');
    const { setup: _setup, ...stripped } = JSON.parse(
      readFileSync(path, 'utf8'),
    );
    writeFileSync(path, JSON.stringify(stripped));
    const again = context(io, fakeProvider().provider, repo);
    expect(await main(['upload', dir], again.ctx)).toBe(1);
    expect(again.errors).toEqual([refusal]);

    // Refused before a login is asked for, since logging in can't make it upload.
    const loggedOut = context(fakeHost(), fakeProvider().provider, repo);
    expect(await main(['upload', dir], loggedOut.ctx)).toBe(1);
    expect(loggedOut.errors).toEqual([refusal]);
  });
});

describe('agentpicks list', () => {
  it('shows every setup in a table, flagging one that fails its checks', async () => {
    writeSetup('errors.yaml', ERRORS_SETUP);
    writeSetup(
      'flags.yaml',
      `${FLAGS_SETUP.replace('stacks: [nextjs]\n', 'repo: {path: ., ref: main}\n')}agents: [codex]\nruns: 3\n`,
    );
    writeSetup('broken.yaml', 'job: [not, a, line]\n');
    writeSetup('notes.txt', 'not a setup');
    const { ctx, lines } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      join(repo, 'agentpicks'),
    );
    expect(await main(['list'], ctx)).toBe(0);
    expect(lines).toEqual([
      'NAME    JOB                 FROM            TESTS           AGENTS             RUNS',
      'broken  invalid: job: Write it as one line of text.',
      'errors  Add error tracking  error-tracking  nextjs          the installed one  1',
      'flags   Add feature flags   -               repo . at main  codex              3',
      '',
      '1 setup file fails its checks. agentpicks validate lists every problem.',
    ]);
  });

  it('says how to write a setup when there is none', async () => {
    const { ctx, lines } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
    );
    expect(await main(['list'], ctx)).toBe(0);
    expect(lines[0]).toMatch(/holds no setup files\. Write one/);
  });
});

describe('agentpicks validate', () => {
  it('checks every setup file and exits non-zero naming each failing file and field', async () => {
    writeSetup('errors.yaml', ERRORS_SETUP);
    writeSetup(
      'flags.yaml',
      FLAGS_SETUP.replace(
        "npm: ['@acme/flags']",
        "npm: ['@acme/flags it']",
      ).replace('stacks: [nextjs]', 'stacks: [nextjs]\nagents: [cursor]'),
    );
    writeSetup('dupe.yaml', 'from: ci\nfrom: payments\n');
    const { ctx, lines, errors } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
    );
    expect(await main(['validate'], ctx)).toBe(1);
    expect(lines).toEqual([
      'agentpicks/errors.yaml: valid',
      '1 of 3 setup files valid.',
    ]);
    expect(errors).toEqual([
      expect.stringMatching(
        /^agentpicks\/dupe\.yaml: line 2: Map keys must be unique\. Fix the YAML there\.$/,
      ),
      'agentpicks/flags.yaml: tools.own.signals.packages.npm[0]: A package name holds a letter or digit, and no spaces, quotes, $ or backticks. End it with / or * to match a prefix.',
      'agentpicks/flags.yaml: agents[0]: Use an agent: claude-code, codex, opencode, pi.',
    ]);
  });

  it('names the shapes repo takes when it is neither a path nor path and ref', async () => {
    writeSetup('mine.yaml', 'from: error-tracking\nrepo: {ref: main}\n');
    const { ctx, errors } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
    );
    expect(await main(['validate'], ctx)).toBe(1);
    expect(errors).toEqual([
      'agentpicks/mine.yaml: repo: Give a path, such as ., or path and optionally ref.',
    ]);
  });

  it('checks the setups named, by name or path, and passes when all are valid', async () => {
    writeSetup('errors.yaml', ERRORS_SETUP);
    writeSetup('flags.yaml', FLAGS_SETUP);
    writeSetup('broken.yaml', 'stacks: [nextjs]\n');
    const { ctx, lines, errors } = context(
      CLAUDE_HOST(),
      fakeProvider().provider,
      repo,
    );
    expect(
      await main(['validate', 'errors', 'agentpicks/flags.yaml'], ctx),
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      'agentpicks/errors.yaml: valid',
      'agentpicks/flags.yaml: valid',
      '2 of 2 setup files valid.',
    ]);

    const missing = context(CLAUDE_HOST(), fakeProvider().provider, repo);
    expect(await main(['validate', 'payments'], missing.ctx)).toBe(1);
    expect(missing.errors).toEqual([
      `There is no setup payments in ${join(repo, 'agentpicks')}. Choose one of: broken, errors, flags.`,
    ]);
  });
});

describe('setup discovery', () => {
  it('reports a dangling symlink and two files with one name, in list and validate, without stopping', async () => {
    writeSetup('errors.yaml', ERRORS_SETUP);
    writeSetup('flags.yaml', FLAGS_SETUP);
    writeSetup('flags.yml', FLAGS_SETUP);
    symlinkSync(
      join(repo, 'nowhere.yaml'),
      join(repo, 'agentpicks', 'gone.yaml'),
    );

    const list = context(CLAUDE_HOST(), fakeProvider().provider, repo);
    expect(await main(['list'], list.ctx)).toBe(0);
    expect(list.lines).toEqual([
      'NAME    JOB                 FROM            TESTS   AGENTS             RUNS',
      'errors  Add error tracking  error-tracking  nextjs  the installed one  1',
      'flags   invalid: (file): flags.yml is also named flags. Rename or remove one.',
      'flags   invalid: (file): flags.yaml is also named flags. Rename or remove one.',
      expect.stringMatching(
        /^gone {4}invalid: \(file\): Can't read it: ENOENT/,
      ),
      '',
      '3 setup files fail their checks. agentpicks validate lists every problem.',
    ]);

    const validate = context(CLAUDE_HOST(), fakeProvider().provider, repo);
    expect(await main(['validate'], validate.ctx)).toBe(1);
    expect(validate.errors).toEqual([
      'agentpicks/flags.yaml: (file): flags.yml is also named flags. Rename or remove one.',
      'agentpicks/flags.yml: (file): flags.yaml is also named flags. Rename or remove one.',
      expect.stringMatching(
        /^agentpicks\/gone\.yaml: \(file\): Can't read it: ENOENT/,
      ),
    ]);
    expect(validate.lines.at(-1)).toBe('1 of 4 setup files valid.');

    // Named by path, a twin is read alone, as run <path> reads it.
    const named = context(CLAUDE_HOST(), fakeProvider().provider, repo);
    await main(['validate', 'agentpicks/flags.yaml'], named.ctx);
    expect(named.errors.join('\n')).not.toContain('also named flags');
  });
});
