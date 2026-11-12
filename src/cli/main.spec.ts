/**
 * ABOUTME: Drives the `agentpicks` command end to end against a fake machine and a fake sandbox:
 * a completed run's bundle and printed summary, a failed run leaving no bundle, and the named
 * refusals (unknown category or stack, Cursor, Keychain-only sign-in, missing Docker, Rails on an
 * arm64 host) before any container starts.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bundleManifestSchema } from '../bundle/schema';
import { parsePackedEntries } from '../locks/locked-files';
import { WRITTEN_SECRETS_LIMIT } from '../run/artifact-redaction';
import type { SandboxPlatform } from '../sandbox/platform';
import type {
  Sandbox,
  SandboxExecOptions,
  SandboxProvider,
} from '../sandbox/provider';
import { FAKE_HOME, fakeHost } from './fake-host';
import type { HostIo } from './host';
import {
  cancelSandboxes,
  main,
  RUNNER,
  trackSandboxes,
  type CliContext,
} from './main';

const KEY = 'sk-ant-api03-secret-value-000000';
const DIGEST = `sha256:${'c'.repeat(64)}`;

interface FakeRun {
  setupExit?: number;
  artifacts?: Record<string, string>;
  /** The egress lookup's exec rejects, as a docker error does. */
  egressRejects?: boolean;
  /** The agent's exec rejects with this message. */
  agentRejects?: string;
}

function fakeProvider(run: FakeRun = {}) {
  const execs: { command: string; options?: SandboxExecOptions }[] = [];
  const writes: string[] = [];
  const written = new Map<string, string>();
  let destroyed = 0;
  const box: Sandbox & { imageDigest(): Promise<string> } = {
    id: 'fake-container',
    async exec(command, options) {
      execs.push({ command, options });
      if (command.includes('api.ipify.org')) {
        if (run.egressRejects) throw new Error('docker exec failed');
        return { exitCode: 0, stdout: '203.0.113.7\n', stderr: '' };
      }
      if (command.includes('run-agent.sh') && run.agentRejects)
        throw new Error(run.agentRejects);
      if (command.includes('setup.sh'))
        return {
          exitCode: run.setupExit ?? 0,
          stdout: 'setup log',
          stderr: '',
        };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async spawn() {},
    async writeFile(path, content) {
      writes.push(path);
      written.set(path, content);
    },
    async readFile(path) {
      return run.artifacts?.[path.split('/').at(-1)!] ?? null;
    },
    async destroy() {
      destroyed++;
    },
    imageDigest: async () => DIGEST,
  };
  const provider: SandboxProvider = {
    name: 'fake',
    create: async () => box,
    get: async () => box,
  };
  return { provider, execs, writes, written, destroyed: () => destroyed };
}

function context(
  io: HostIo,
  provider: SandboxProvider,
  cwd: string,
  platform: SandboxPlatform = 'linux/amd64',
): CliContext & {
  lines: string[];
  errors: string[];
  dockerCalls: string[];
  labels: Record<string, string>[];
} {
  const lines: string[] = [];
  const errors: string[] = [];
  const dockerCalls: string[] = [];
  const labels: Record<string, string>[] = [];
  return {
    io,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    cwd,
    dockerfileDir: '/pkg/docker',
    lines,
    errors,
    dockerCalls,
    labels,
    docker: {
      version: async () => (dockerCalls.push('version'), '29.9.2'),
      platform: async () => (dockerCalls.push('platform'), platform),
      run: async (args) => {
        dockerCalls.push(args.join(' '));
        return { exitCode: 0, stdout: 'sha256:image\n', stderr: '' };
      },
      build: async () => 0,
      provider: (_image, given) => (labels.push(given), provider),
    },
  };
}

const CLAUDE = { claude: '2.1.322 (Claude Code)' };
const ARTIFACTS = {
  'meta.json': '{"exitCode":0,"wallSec":12.5}',
  'transcript.jsonl': `{"type":"result","note":"used ${KEY}"}\n`,
  'diff.patch': '+Sentry.init()\n',
  'earlystop.json':
    '{"reason":"pick","triggerSec":40,"graceSec":60,"killed":true,"agentFound":true}',
};

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agentpicks-cli-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe('agentpicks run', () => {
  it('runs the host agent in a sandbox and writes a redacted, self-describing bundle', async () => {
    const io = fakeHost({
      commands: CLAUDE,
      env: { ANTHROPIC_API_KEY: KEY },
      files: {
        [`${FAKE_HOME}/.claude/settings.json`]: JSON.stringify({
          model: 'opus',
        }),
      },
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(io, fake.provider, cwd);
    const code = await main(
      ['run', '--category', 'error-tracking', '--stack', 'nextjs'],
      ctx,
    );
    expect(ctx.errors).toEqual([]);
    expect(code).toBe(0);

    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    const bundle = join(cwd, 'agentpicks-runs', runId!);
    const manifest = bundleManifestSchema.parse(
      JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')),
    );
    expect(manifest).toMatchObject({
      bundleVersion: 1,
      runId,
      runner: RUNNER,
      agent: { kind: 'claude_code', version: '2.1.322', model: 'opus' },
      host: { os: 'linux', arch: 'x64' },
      sandbox: {
        provider: 'docker',
        imageDigest: DIGEST,
        egressIp: '203.0.113.7',
      },
      stack: {
        slug: 'nextjs',
        starter: 'nextjs',
        lockDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      request: {
        category: 'error-tracking',
        intent: 'add',
        prompt: expect.stringContaining('Add error tracking to this app'),
      },
    });
    expect(manifest.artifacts.map((a) => a.name)).toEqual([
      'meta.json',
      'transcript.jsonl',
      'diff.patch',
      'earlystop.json',
    ]);
    expect(
      readFileSync(join(bundle, 'artifacts/transcript.jsonl'), 'utf8'),
    ).not.toContain(KEY);
    expect(
      JSON.parse(readFileSync(join(bundle, 'redactions.json'), 'utf8')),
    ).toEqual({
      bundleVersion: 1,
      total: 1,
      byArtifact: { 'transcript.jsonl': 1 },
    });

    // The host's version is installed, and the key reaches only the agent's command.
    const agent = fake.execs.find((e) => e.command.includes('run-agent.sh'))!;
    expect(agent.command).toBe(
      "bash /opt/agent-picks/run-agent.sh claude 'opus' /opt/agent-picks/prompt.txt 900",
    );
    expect(agent.options?.env).toEqual({
      ANTHROPIC_API_KEY: KEY,
      EARLY_STOP_GRACE: '60',
      MAX_TURNS: '100',
    });
    expect(
      fake.execs.find((e) => e.command.includes('setup.sh'))?.options?.env,
    ).toBeUndefined();
    expect(fake.writes).toContain('/opt/agent-picks/install-agent-version.sh');
    expect(fake.destroyed()).toBe(1);

    expect(ctx.lines).toEqual(
      expect.arrayContaining([
        'agentpicks 0.1.0, Docker 29.9.2',
        `Agent: Claude Code 2.1.322 at /usr/local/bin/claude, model opus (from ${FAKE_HOME}/.claude/settings.json)`,
        'Passes ANTHROPIC_API_KEY from your environment to Claude Code, for each run only.',
        "Each run needs Docker with 2 CPUs, 4 GB of memory and 20 GB free on Docker's disk, and may write up to 15 GB there while it runs.",
        expect.stringMatching(
          /^ {2}Finished in \d+ s\. The agent exited 0; it was stopped 60 s after a pick landed\.$/,
        ),
        `  Bundle: ${bundle}`,
        expect.stringMatching(/^ {4}artifacts\/transcript\.jsonl +\d+ B$/),
        '  Redactions: 1 (transcript.jsonl 1)',
        `1 of 1 run written to ${join(cwd, 'agentpicks-runs')}`,
      ]),
    );
    // What is passed is stated before the run starts.
    expect(
      ctx.lines.indexOf(
        'Passes ANTHROPIC_API_KEY from your environment to Claude Code, for each run only.',
      ),
    ).toBeLessThan(ctx.lines.indexOf('Run 1 of 1'));
  });

  it('writes the sign-in file only after setup, just before the agent', async () => {
    const io = fakeHost({
      commands: CLAUDE,
      files: {
        [`${FAKE_HOME}/.claude/.credentials.json`]: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-0000000000',
            refreshToken: 'r',
          },
        }),
      },
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(
        ['run', '--category', 'ci', '--stack', 'nextjs', '--out', 'b'],
        ctx,
      ),
    ).toBe(0);
    const at = (match: string) =>
      fake.execs.findIndex((e) => e.command.includes(match));
    const [setupAt, chmodAt, agentAt] = [
      at('setup.sh'),
      at('chmod 600'),
      at('run-agent.sh'),
    ];
    expect(setupAt).toBeGreaterThan(-1);
    expect(setupAt).toBeLessThan(chmodAt);
    expect(chmodAt).toBeLessThan(agentAt);
    expect(fake.writes.at(-1)).toBe('/root/.claude/.credentials.json');
  });

  it('records no egress IP, and still writes the bundle, when the lookup itself fails', async () => {
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const fake = fakeProvider({ artifacts: ARTIFACTS, egressRejects: true });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(0);
    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    const manifest = bundleManifestSchema.parse(
      JSON.parse(
        readFileSync(
          join(cwd, 'agentpicks-runs', runId!, 'manifest.json'),
          'utf8',
        ),
      ),
    );
    expect(manifest.sandbox.egressIp).toBeNull();
  });

  it('masks a secret the agent wrote in a failed run’s error, before its artifacts are dropped', async () => {
    const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF';
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const fake = fakeProvider({
      agentRejects: `docker exec failed: AUTH_SECRET=${secret} was printed`,
      artifacts: {
        'transcript.jsonl': JSON.stringify({
          type: 'tool_use',
          input: { content: `AUTH_SECRET=${secret}\n` },
        }),
      },
    });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    expect(ctx.lines).toContainEqual(
      expect.stringMatching(
        /^ {2}Failed at agent after \d+ s: docker exec failed: AUTH_SECRET=\[redacted\] was printed$/,
      ),
    );
    expect(ctx.lines.join('\n')).not.toContain(secret);
  });

  it('strips terminal controls from what a container prints', async () => {
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const fake = fakeProvider({
      agentRejects: 'exit\u001b]52;c;aGk=\u0007 \u009b2Jdone\r',
    });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    expect(ctx.lines).toContainEqual(
      expect.stringMatching(
        /^ {2}Failed at agent after \d+ s: exit\]52;c;aGk= 2Jdone$/,
      ),
    );
  });

  it.each([
    ['linux/amd64', 'node-v$NODE_VERSION-linux-x64.tar.gz'],
    ['linux/arm64', 'node-v$NODE_VERSION-linux-arm64.tar.gz'],
  ] as const)(
    'uploads the setup built for the Docker host’s platform (%s)',
    async (platform, node) => {
      const io = fakeHost({
        commands: CLAUDE,
        env: { ANTHROPIC_API_KEY: KEY },
      });
      const fake = fakeProvider({ artifacts: ARTIFACTS });
      const ctx = context(io, fake.provider, cwd, platform);
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx);
      expect(fake.written.get('/opt/agent-picks/setup.sh')).toContain(node);
    },
  );

  it('labels every container with this invocation’s session', async () => {
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const ctx = context(
      io,
      fakeProvider({ artifacts: ARTIFACTS }).provider,
      cwd,
    );
    await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx);
    expect(ctx.labels).toEqual([
      {
        'dev.devtune.agentpicks.session':
          expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    ]);
  });

  it('writes no bundle for a run that failed, and exits non-zero', async () => {
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const fake = fakeProvider({ setupExit: 1 });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(
        ['run', '--category', 'ci', '--stack', 'nextjs', '--runs', '2'],
        ctx,
      ),
    ).toBe(1);
    expect(ctx.lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^ {2}Failed at setup after \d+ s: setup exit 1: setup log$/,
        ),
        '  No bundle was written for this run.',
        `0 of 2 runs written to ${join(cwd, 'agentpicks-runs')}`,
      ]),
    );
    expect(readdirSync(cwd)).toEqual([]);
    expect(fake.destroyed()).toBe(2);
  });

  describe('the agent’s exit', () => {
    const exited = (exitCode: number, killed: boolean) =>
      fakeProvider({
        artifacts: {
          ...ARTIFACTS,
          'meta.json': JSON.stringify({ exitCode, wallSec: 12.5 }),
          'earlystop.json': JSON.stringify({
            reason: killed ? 'pick' : 'none',
            triggerSec: 40,
            graceSec: 60,
            killed,
            agentFound: true,
          }),
        },
      });

    it.each([
      [1, 'a failed agent'],
      [124, 'an agent its time limit stopped'],
    ])('refuses exit %i, from %s, and writes no bundle', async (exitCode) => {
      const io = fakeHost({
        commands: CLAUDE,
        env: { ANTHROPIC_API_KEY: KEY },
      });
      const ctx = context(io, exited(exitCode, false).provider, cwd);
      expect(
        await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
      ).toBe(1);
      expect(ctx.lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^ {2}Failed at agent after \\d+ s: agent exit ${exitCode}$`,
            ),
          ),
          '  No bundle was written for this run.',
          `0 of 1 run written to ${join(cwd, 'agentpicks-runs')}`,
        ]),
      );
      expect(readdirSync(cwd)).toEqual([]);
    });

    it.each([
      [0, false, 'an agent that finished'],
      [143, true, 'an agent the early stop killed'],
    ])(
      'accepts exit %i, killed %s, from %s, and writes its bundle',
      async (exitCode, killed) => {
        const io = fakeHost({
          commands: CLAUDE,
          env: { ANTHROPIC_API_KEY: KEY },
        });
        const ctx = context(io, exited(exitCode, killed).provider, cwd);
        expect(
          await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
        ).toBe(0);
        expect(readdirSync(join(cwd, 'agentpicks-runs'))).toHaveLength(1);
      },
    );
  });

  it('writes no bundle, and starts no further run, when the run wrote more secrets than the limit', async () => {
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const count = WRITTEN_SECRETS_LIMIT + 1;
    const fake = fakeProvider({
      artifacts: {
        ...ARTIFACTS,
        'diff.patch': `+++ b/.env\n${Array.from(
          { length: count },
          (_, i) =>
            `+API_KEY_${i}=${i.toString(36).padStart(4, '0')}x8XvN2pLr7Tk4WbY9mZc\n`,
        ).join('')}`,
      },
    });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(
        ['run', '--category', 'ci', '--stack', 'nextjs', '--runs', '2'],
        ctx,
      ),
    ).toBe(1);
    expect(ctx.errors).toEqual([
      `The run wrote ${count} secrets, more than the ${WRITTEN_SECRETS_LIMIT} agentpicks redacts. No bundle is written for it, and no further runs start.`,
    ]);
    expect(readdirSync(cwd)).toEqual([]);
    expect(fake.destroyed()).toBe(1);
  });

  it.each([
    [
      'an unknown category',
      ['--category', 'logging', '--stack', 'nextjs'],
      fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } }),
      /^There is no category logging\. Choose one of: authentication, /,
    ],
    [
      'an unknown stack',
      ['--category', 'ci', '--stack', 'django'],
      fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } }),
      /^There is no stack django for ci\. Choose one of: empty, nextjs, /,
    ],
    [
      'Cursor',
      ['--category', 'ci', '--stack', 'nextjs', '--agent', 'cursor'],
      fakeHost({ commands: { 'cursor-agent': '1.0.0' } }),
      /^Cursor can't be tested: agentpicks has no capture for Cursor runs yet\./,
    ],
    [
      'a Keychain-only sign-in',
      ['--category', 'ci', '--stack', 'nextjs'],
      fakeHost({ commands: CLAUDE, platform: 'darwin' }),
      /^Claude Code on macOS keeps its sign-in in the Keychain, which agentpicks doesn't read\. Run `claude setup-token`/,
    ],
  ])(
    'refuses %s by name before Docker is touched',
    async (_case, argv, io, message) => {
      const fake = fakeProvider();
      const ctx = context(io, fake.provider, cwd);
      expect(await main(['run', ...argv], ctx)).toBe(1);
      expect(ctx.errors).toEqual([expect.stringMatching(message)]);
      expect(ctx.dockerCalls).toEqual([]);
      expect(fake.execs).toEqual([]);
    },
  );

  it('refuses a Rails stack on an arm64 Docker host by name, before building or starting anything', async () => {
    const fake = fakeProvider();
    const ctx = context(
      fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } }),
      fake.provider,
      cwd,
      'linux/arm64',
    );
    expect(
      await main(
        ['run', '--category', 'error-tracking', '--stack', 'rails'],
        ctx,
      ),
    ).toBe(1);
    expect(ctx.errors).toEqual([
      "Rails isn't available on arm64 machines yet, so --stack rails can't run here. Choose another stack.",
    ]);
    expect(ctx.dockerCalls).toEqual(['version', 'platform']);
    expect(ctx.labels).toEqual([]);
    expect(fake.execs).toEqual([]);
  });

  it('refuses to start without Docker, naming it', async () => {
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const ctx = context(io, fakeProvider().provider, cwd);
    delete ctx.docker;
    const path = process.env.PATH;
    process.env.PATH = join(cwd, 'no-docker-here');
    try {
      expect(
        await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
      ).toBe(1);
    } finally {
      process.env.PATH = path;
    }
    expect(ctx.errors).toEqual([
      'Docker is required to run Agent Picks, and no docker command is on PATH. Install Docker and try again.',
    ]);
  });
});

describe('agentpicks run --repo', () => {
  const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  let repo: string;
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Dev',
        GIT_AUTHOR_EMAIL: 'dev@example.com',
        GIT_COMMITTER_NAME: 'Dev',
        GIT_COMMITTER_EMAIL: 'dev@example.com',
      },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (path: string, content: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const io = () =>
    fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });

  beforeEach(() => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    repo = join(cwd, 'app');
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    write('package.json', '{"name":"app","private":true}\n');
    write('package-lock.json', '{"lockfileVersion":3}\n');
    write('src/index.js', 'console.log("hi")\n');
    git('add', '-A');
    git('commit', '-qm', 'first');
    git(
      'remote',
      'add',
      'origin',
      `https://dev:${TOKEN}@github.com/acme/app.git`,
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it('copies the commit into the sandbox in place of a starter, and records the remote without its token and the commit', async () => {
    const head = git('rev-parse', 'HEAD');
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(io(), fake.provider, cwd);
    expect(
      await main(['run', '--category', 'error-tracking', '--repo', 'app'], ctx),
    ).toBe(0);
    expect(ctx.errors).toEqual([]);

    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    const text = readFileSync(
      join(cwd, 'agentpicks-runs', runId!, 'manifest.json'),
      'utf8',
    );
    expect(text).not.toContain(TOKEN);
    const manifest = bundleManifestSchema.parse(JSON.parse(text));
    expect(manifest.repository).toEqual({
      remoteUrl: 'https://github.com/acme/app.git',
      commit: head,
    });
    expect(manifest.stack).toBeUndefined();
    // No environment prefix: the request is asked as written.
    expect(manifest.request.prompt).toMatch(/^Add error tracking to this app/);

    expect(fake.writes).toContain('/opt/agent-picks/repository.tsv');
    expect(fake.writes).not.toContain('/opt/agent-picks/starter.tsv');
    expect(
      parsePackedEntries(fake.written.get('/opt/agent-picks/repository.tsv')!)
        .map((e) => e.path)
        .sort(),
    ).toEqual(['package-lock.json', 'package.json', 'src/index.js']);
    const makeEnv = fake.written.get('/opt/agent-picks/make-env.sh')!;
    expect(makeEnv).toContain('unpack /work/app $S/repository.tsv');
    expect(makeEnv).toContain('npm ci --no-audit --no-fund');
    expect(
      fake.execs.find((e) => e.command.includes('setup.sh'))?.command,
    ).toBe("bash /opt/agent-picks/setup.sh 'customer_repository'");

    expect(ctx.lines).toEqual(
      expect.arrayContaining([
        `Testing commit ${head.slice(0, 12)} of app. Uncommitted changes aren't included.`,
        'Repository: 3 files, remote https://github.com/acme/app.git, installed with npm',
        'Test: the error-tracking add request on your repository, 1 run, one after another',
      ]),
    );
  });

  it('tests HEAD as committed when the checkout has uncommitted and untracked changes, and says so before the first run', async () => {
    const head = git('rev-parse', 'HEAD');
    write('src/index.js', 'changed\n');
    write('notes.md', 'draft\n');
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(io(), fake.provider, cwd);
    expect(await main(['run', '--category', 'ci', '--repo', 'app'], ctx)).toBe(
      0,
    );
    const notice = `Testing commit ${head.slice(0, 12)} of app. Uncommitted changes aren't included.`;
    expect(ctx.lines.indexOf(notice)).toBeGreaterThan(-1);
    expect(ctx.lines.indexOf(notice)).toBeLessThan(
      ctx.lines.indexOf('Run 1 of 1'),
    );
    const entries = parsePackedEntries(
      fake.written.get('/opt/agent-picks/repository.tsv')!,
    );
    expect(entries.find((e) => e.path === 'src/index.js')).toMatchObject({
      text: 'console.log("hi")\n',
    });
    expect(entries.map((e) => e.path)).not.toContain('notes.md');
  });

  it('tests the --ref commit with uncommitted changes in the checkout', async () => {
    const first = git('rev-parse', 'HEAD');
    write('src/index.js', 'second\n');
    git('commit', '-qam', 'second');
    write('src/index.js', 'uncommitted\n');
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(io(), fake.provider, cwd);
    expect(
      await main(
        ['run', '--category', 'ci', '--repo', repo, '--ref', first.slice(0, 8)],
        ctx,
      ),
    ).toBe(0);
    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    expect(
      JSON.parse(
        readFileSync(
          join(cwd, 'agentpicks-runs', runId!, 'manifest.json'),
          'utf8',
        ),
      ).repository.commit,
    ).toBe(first);
    expect(
      parsePackedEntries(
        fake.written.get('/opt/agent-picks/repository.tsv')!,
      ).find((e) => e.path === 'src/index.js'),
    ).toMatchObject({ text: 'console.log("hi")\n' });
  });

  it.each([
    [
      'an unknown --ref',
      () => {},
      ['--repo', 'app', '--ref', 'deadbeef'],
      /^There is no commit deadbeef in /,
    ],
    [
      'a path outside any repository',
      () => mkdirSync(join(cwd, 'plain')),
      ['--repo', 'plain'],
      /plain is not in a git repository \(.*\)\. Pass --repo/,
    ],
    [
      'an unsupported package manager',
      () => {
        write('bun.lock', '{}\n');
        git('add', '-A');
        git('commit', '-qm', 'bun');
      },
      ['--repo', 'app'],
      /^This repository uses Bun \(bun\.lock\)/,
    ],
  ])(
    'refuses %s by name before Docker is touched',
    async (_case, arrange, argv, message) => {
      arrange();
      const fake = fakeProvider();
      const ctx = context(io(), fake.provider, cwd);
      expect(await main(['run', '--category', 'ci', ...argv], ctx)).toBe(1);
      expect(ctx.errors).toEqual([expect.stringMatching(message)]);
      expect(ctx.dockerCalls).toEqual([]);
      expect(fake.execs).toEqual([]);
    },
  );
});

describe('agentpicks cleanup', () => {
  it('removes labelled containers and images, and says what went', async () => {
    const ctx = context(fakeHost(), fakeProvider().provider, cwd);
    ctx.docker!.run = async (args) => {
      ctx.dockerCalls.push(args.join(' '));
      if (args[0] === 'ps') return { exitCode: 0, stdout: 'c1\n', stderr: '' };
      if (args[1] === 'ls')
        return {
          exitCode: 0,
          stdout: 'sha256:x agentpicks-sandbox:0.1.0\n',
          stderr: '',
        };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    expect(await main(['cleanup'], ctx)).toBe(0);
    expect(ctx.lines).toEqual([
      'Removed 1 container and 1 image: agentpicks-sandbox:0.1.0.',
    ]);
  });
});

describe('agentpicks', () => {
  it('prints its version, and its usage for an unknown command', async () => {
    const ctx = context(fakeHost(), fakeProvider().provider, cwd);
    expect(await main(['--version'], ctx)).toBe(0);
    expect(ctx.lines).toEqual([RUNNER.version]);
    expect(await main(['upload'], ctx)).toBe(1);
    expect(ctx.errors[0]).toMatch(
      /^agentpicks has no upload command\.\n\nUsage:/,
    );
  });
});

describe('trackSandboxes', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function box(destroy: () => Promise<void>): Sandbox {
    return {
      id: 'c1',
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      spawn: async () => {},
      writeFile: async () => {},
      readFile: async () => null,
      destroy,
    };
  }

  it('waits for a sandbox still being created when cancelled, then destroys it', async () => {
    const creating = deferred<Sandbox>();
    let destroyed = 0;
    const tracked = trackSandboxes({
      name: 'fake',
      create: () => creating.promise,
      get: async () => null,
    });
    const created = tracked.provider.create({ timeoutMin: 1 });
    let cancelled = false;
    const cancel = tracked.destroyAll().then(() => (cancelled = true));
    await Promise.resolve();
    expect(cancelled).toBe(false);
    creating.resolve(box(async () => void destroyed++));
    await cancel;
    await created;
    expect(destroyed).toBe(1);
  });

  it('settles a cancel when the creation it waits for fails', async () => {
    const creating = deferred<Sandbox>();
    const tracked = trackSandboxes({
      name: 'fake',
      create: () => creating.promise,
      get: async () => null,
    });
    const created = tracked.provider.create({ timeoutMin: 1 });
    const cancel = tracked.destroyAll();
    creating.reject(new Error('docker run failed'));
    await expect(created).rejects.toThrow('docker run failed');
    await expect(cancel).resolves.toEqual([]);
  });

  it('keeps a sandbox tracked until its destroy succeeds, so a cancel destroys it again', async () => {
    const first = deferred<void>();
    let calls = 0;
    const tracked = trackSandboxes({
      name: 'fake',
      create: async () =>
        box(() => (++calls === 1 ? first.promise : Promise.resolve())),
      get: async () => null,
    });
    const sandbox = await tracked.provider.create({ timeoutMin: 1 });
    // The run's own destroy is still in flight when the cancel comes.
    const own = sandbox.destroy();
    await tracked.destroyAll();
    expect(calls).toBe(2);
    first.reject(new Error('docker rm failed'));
    await expect(own).rejects.toThrow('docker rm failed');
    // Destroyed by the cancel, it is no longer tracked.
    await tracked.destroyAll();
    expect(calls).toBe(2);
  });

  it('keeps a sandbox whose destroy failed, and destroys it on cancel', async () => {
    let calls = 0;
    const tracked = trackSandboxes({
      name: 'fake',
      create: async () =>
        box(async () => {
          if (++calls === 1) throw new Error('docker rm failed');
        }),
      get: async () => null,
    });
    const sandbox = await tracked.provider.create({ timeoutMin: 1 });
    await expect(sandbox.destroy()).rejects.toThrow('docker rm failed');
    await tracked.destroyAll();
    expect(calls).toBe(2);
  });
});

describe('cancelSandboxes', () => {
  it('destroys the tracked sandboxes, then removes every container with the session label', async () => {
    const order: string[] = [];
    const tracked = trackSandboxes({
      name: 'fake',
      create: async () => ({
        id: 'tracked',
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        spawn: async () => {},
        writeFile: async () => {},
        readFile: async () => null,
        destroy: async () => void order.push('destroy tracked'),
      }),
      get: async () => null,
    });
    await tracked.provider.create({ timeoutMin: 1 });
    await cancelSandboxes(tracked, 'session-1', async (args) => {
      order.push(args.join(' '));
      return {
        exitCode: 0,
        // A container whose `docker run` was cut off before its id came back.
        stdout: args[0] === 'ps' ? 'untracked\n' : '',
        stderr: '',
      };
    });
    expect(order).toEqual([
      'destroy tracked',
      'ps --all --quiet --filter label=dev.devtune.agentpicks.session=session-1',
      'rm --force untracked',
    ]);
  });
});
