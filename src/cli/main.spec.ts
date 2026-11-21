/**
 * ABOUTME: Drives the `agentpicks` command end to end against a fake machine and a fake sandbox:
 * a completed run's bundle and printed summary, a failed run leaving no bundle, and the named
 * refusals (unknown category or stack, Cursor, Keychain-only sign-in, missing Docker, Rails on an
 * arm64 host, no DevTune login, a repository with no remote) before any container starts; and,
 * against a stubbed `fetch`, the upload after a run, `upload` and `login`.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import packageJson from '../../package.json';
import { bundleManifestSchema } from '../bundle/schema';
import { findCategoryRequests } from '../catalogue/categories';
import { CATEGORY_EARLY_STOP } from '../catalogue/early-stop.generated';
import { parsePackedEntries } from '../locks/locked-files';
import { WRITTEN_SECRETS_LIMIT } from '../run/artifact-redaction';
import type { SandboxPlatform } from '../sandbox/platform';
import type {
  Sandbox,
  SandboxExecOptions,
  SandboxProvider,
} from '../sandbox/provider';
import {
  completed,
  created,
  refused,
  SETUPS,
  setupList,
  stubFetch,
  TARGET,
  UPLOADS,
} from './fake-devtune';
import { FAKE_HOME, fakeHost, fakeImageDocker } from './fake-host';
import {
  CONNECTION,
  connection as signedInConnection,
  consentBrowser,
  issued,
  savedSession,
  signInReplies,
  TOKEN,
} from './fake-oauth';
import type { HostIo } from './host';
import {
  cancelSandboxes,
  main,
  RUNNER,
  INTRO,
  USAGE,
  trackSandboxes,
  type CliContext,
} from './main';
import { SETUP_SCHEMA_URL } from './setup-write';

const KEY = 'sk-ant-api03-secret-value-000000';
const DEVTUNE_ENV = {
  DEVTUNE_API_KEY: TARGET.apiKey,
  DEVTUNE_PROJECT_ID: TARGET.projectId,
  DEVTUNE_API_BASE_URL: TARGET.baseUrl,
};
const DIGEST = `sha256:${'c'.repeat(64)}`;

interface FakeRun {
  setupExit?: number;
  artifacts?: Record<string, string>;
  /** The egress lookup's exec rejects, as a docker error does. */
  egressRejects?: boolean;
  /** The egress lookup's curl exits with this code, as `curl -f` does on a 404. */
  egressExit?: number;
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
      if (command.includes('/api/public/egress-ip')) {
        if (run.egressRejects) throw new Error('docker exec failed');
        if (run.egressExit)
          return {
            exitCode: run.egressExit,
            stdout: '',
            stderr: 'curl: (22) The requested URL returned error: 404',
          };
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
    stdinIsTerminal: true,
    lines,
    errors,
    dockerCalls,
    labels,
    docker: {
      version: async () => (dockerCalls.push('version'), '29.9.2'),
      platform: async () => (dockerCalls.push('platform'), platform),
      ...fakeImageDocker(platform, (args) => dockerCalls.push(args.join(' '))),
      provider: (_image, given) => (labels.push(given), provider),
    },
  };
}

const LOGO = '<the DevTune mark>';

/** The context with a logo that records where it played among the printed lines. */
function playsLogo<T extends CliContext & { lines: string[] }>(ctx: T): T {
  return { ...ctx, logo: async () => void ctx.lines.push(LOGO) };
}

const CLAUDE = { claude: '2.1.322 (Claude Code)' };
const ARTIFACTS = {
  'meta.json': '{"exitCode":0,"wallSec":12.5}',
  'transcript.jsonl': `{"type":"result","note":"used ${KEY}"}\n`,
  'diff.patch': '+Sentry.init()\n',
  'earlystop.json':
    '{"reason":"pick","triggerSec":40,"graceSec":60,"killed":true,"agentFound":true}',
};

/** The project's unedited copy of ci, which a signed-in --category ci run uploads under. */
function ciCopy() {
  return {
    id: '1a000000-0000-4000-8000-0000000000c1',
    category_slug: 'ci-copy',
    name: 'CI',
    kind: 'copy',
    source_category_slug: 'ci',
    snapshot_digest: 'b'.repeat(64),
    requests: Object.fromEntries(
      findCategoryRequests('ci')!.prompts.map((p) => [p.intent, p.text]),
    ),
    tools: [],
    own_tool_key: null,
    competitor_tool_keys: [],
    environments: [
      { id: 'e0000000-0000-4000-8000-000000000001', slug: 'nextjs' },
    ],
    agent_models: [{ agent: 'claude_code', model: 'claude-sonnet-5-5' }],
    building_blocks: null,
  };
}

/** The setup reads of a signed-in --category ci run: finding the project's copy, then linking its uploads. */
const ciCopyReplies = () => ({
  [`GET ${SETUPS}`]: [setupList([ciCopy()]), setupList([ciCopy()])],
});

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
      [
        'run',
        '--no-upload',
        '--category',
        'error-tracking',
        '--stack',
        'nextjs',
      ],
      ctx,
    );
    expect(ctx.errors).toEqual([]);
    expect(code).toBe(0);

    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    const bundle = join(cwd, 'agentpicks-runs', runId!);
    const written = JSON.parse(
      readFileSync(join(bundle, 'manifest.json'), 'utf8'),
    );
    // A category run records the early stop it watched for, which the bundle format drops.
    expect(written.earlyStop).toEqual(CATEGORY_EARLY_STOP['error-tracking']);
    const manifest = bundleManifestSchema.parse(written);
    expect(manifest).not.toHaveProperty('earlyStop');
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
        `agentpicks ${packageJson.version}, Docker 29.9.2`,
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
        [
          'run',
          '--no-upload',
          '--category',
          'ci',
          '--stack',
          'nextjs',
          '--out',
          'b',
        ],
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
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        ctx,
      ),
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

  it('records no egress IP when DevTune answers the lookup with an error status', async () => {
    const io = fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } });
    const fake = fakeProvider({ artifacts: ARTIFACTS, egressExit: 22 });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        ctx,
      ),
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

  it('records no egress IP, and still completes a local run, when DEVTUNE_API_BASE_URL is unusable', async () => {
    const io = fakeHost({
      commands: CLAUDE,
      env: { ANTHROPIC_API_KEY: KEY, DEVTUNE_API_BASE_URL: 'not-a-url' },
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(io, fake.provider, cwd);
    expect(
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        ctx,
      ),
    ).toBe(0);
    expect(ctx.errors).toEqual([]);
    expect(
      fake.execs.filter((exec) => exec.command.includes('egress-ip')),
    ).toEqual([]);
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

  it('reads the egress IP from DevTune at the API root’s origin, which DEVTUNE_API_BASE_URL moves', async () => {
    const lookups = async (env: Record<string, string>) => {
      const fake = fakeProvider({ artifacts: ARTIFACTS });
      const io = fakeHost({
        commands: CLAUDE,
        env: { ANTHROPIC_API_KEY: KEY, ...env },
      });
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        context(io, fake.provider, cwd),
      );
      return fake.execs
        .map((exec) => exec.command)
        .filter((command) => command.includes('egress-ip'));
    };
    expect(await lookups({})).toEqual([
      "curl -fsS --max-time 10 'https://devtune.ai/api/public/egress-ip'",
    ]);
    expect(await lookups({ DEVTUNE_API_BASE_URL: TARGET.baseUrl })).toEqual([
      "curl -fsS --max-time 10 'https://devtune.test/api/public/egress-ip'",
    ]);
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
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        ctx,
      ),
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
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        ctx,
      ),
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
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        ctx,
      );
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
    await main(
      ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
      ctx,
    );
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
        [
          'run',
          '--no-upload',
          '--category',
          'ci',
          '--stack',
          'nextjs',
          '--runs',
          '2',
        ],
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
        await main(
          ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
          ctx,
        ),
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

    it('prints why a failed agent stopped: the error its transcript names, else its stderr, else its last event', async () => {
      const failed = (artifacts: Record<string, string>) =>
        fakeProvider({
          artifacts: {
            ...ARTIFACTS,
            ...artifacts,
            'meta.json': JSON.stringify({ exitCode: 1, wallSec: 12.5 }),
            'earlystop.json':
              '{"reason":"none","triggerSec":0,"graceSec":0,"killed":false}',
          },
        }).provider;
      const runOnce = async (artifacts: Record<string, string>) => {
        const io = fakeHost({
          commands: CLAUDE,
          env: { ANTHROPIC_API_KEY: KEY },
        });
        const ctx = context(io, failed(artifacts), cwd);
        await main(
          ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
          ctx,
        );
        const at = ctx.lines.findIndex((line) =>
          line.startsWith('  Failed at agent'),
        );
        const end = ctx.lines.indexOf('  No bundle was written for this run.');
        return ctx.lines.slice(at + 1, end);
      };
      expect(
        await runOnce({
          'agent.err': [
            'one',
            'two',
            '',
            'three',
            'four',
            'five',
            `six ${'x'.repeat(400)}`,
          ].join('\n'),
        }),
      ).toEqual([
        '  The agent’s last error output:',
        '    two',
        '    three',
        '    four',
        '    five',
        `    six ${'x'.repeat(296)}…`,
      ]);
      expect(
        await runOnce({
          'agent.err': '\n',
          'transcript.jsonl': `{"type":"init"}\n{"type":"result","is_error":true,"result":"API Error: 529 overloaded ${KEY}"}\n`,
        }),
      ).toEqual([
        '  The agent’s last error:',
        '    API Error: 529 overloaded [redacted]',
      ]);
      const unicodeEscaped = Array.from(
        KEY,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ).join('');
      expect(
        await runOnce({
          'transcript.jsonl': `{"type":"result","is_error":true,"result":"rejected ${unicodeEscaped}"}\n`,
        }),
      ).toEqual(['  The agent’s last error:', '    rejected [redacted]']);
      expect(
        await runOnce({
          'transcript.jsonl':
            '{"type":"turn.failed","error":{"message":"stream disconnected"}}\n',
        }),
      ).toEqual(['  The agent’s last error:', '    stream disconnected']);
      expect(
        await runOnce({
          'transcript.jsonl':
            '{"type":"result","is_error":false,"result":"done"}\n',
        }),
      ).toEqual([
        '  The agent’s last transcript event:',
        '    {"type":"result","is_error":false,"result":"done"}',
      ]);
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
          await main(
            ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
            ctx,
          ),
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
        [
          'run',
          '--no-upload',
          '--category',
          'ci',
          '--stack',
          'nextjs',
          '--runs',
          '2',
        ],
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
      expect(await main(['run', '--no-upload', ...argv], ctx)).toBe(1);
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
        [
          'run',
          '--no-upload',
          '--category',
          'error-tracking',
          '--stack',
          'rails',
        ],
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
        await main(
          ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
          ctx,
        ),
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
      await main(
        ['run', '--no-upload', '--category', 'error-tracking', '--repo', 'app'],
        ctx,
      ),
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
    expect(
      await main(
        ['run', '--no-upload', '--category', 'ci', '--repo', 'app'],
        ctx,
      ),
    ).toBe(0);
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
        [
          'run',
          '--no-upload',
          '--category',
          'ci',
          '--repo',
          repo,
          '--ref',
          first.slice(0, 8),
        ],
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
      expect(
        await main(['run', '--no-upload', '--category', 'ci', ...argv], ctx),
      ).toBe(1);
      expect(ctx.errors).toEqual([expect.stringMatching(message)]);
      expect(ctx.dockerCalls).toEqual([]);
      expect(fake.execs).toEqual([]);
    },
  );

  it('refuses to upload a repository with no remote before Docker is touched, and runs it with --no-upload', async () => {
    git('remote', 'remove', 'origin');
    const calls = stubFetch({});
    const host = () =>
      fakeHost({
        commands: CLAUDE,
        env: { ...DEVTUNE_ENV, ANTHROPIC_API_KEY: KEY },
      });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(host(), fake.provider, cwd);
    expect(await main(['run', '--category', 'ci', '--repo', 'app'], ctx)).toBe(
      1,
    );
    expect(ctx.errors).toEqual([
      `DevTune groups a repository's runs by its remote, and ${repo} has none agentpicks can record. Add an origin remote with a network address, or pass --no-upload to keep the bundles on this machine only.`,
    ]);
    expect(ctx.dockerCalls).toEqual([]);
    expect(fake.execs).toEqual([]);

    const local = context(host(), fake.provider, cwd);
    expect(
      await main(
        ['run', '--no-upload', '--category', 'ci', '--repo', 'app'],
        local,
      ),
    ).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('agentpicks run, uploading', () => {
  afterEach(() => vi.unstubAllGlobals());
  const BUNDLE_NAMES = Object.keys(ARTIFACTS);
  const RUN_ID = '0f9d5a8e-5d1c-4b8e-9a43-3c1f0e6b7a21';
  const savedLogin = (env: Record<string, string> = {}) =>
    fakeHost({
      commands: CLAUDE,
      env: {
        ANTHROPIC_API_KEY: KEY,
        DEVTUNE_API_BASE_URL: TARGET.baseUrl,
        ...env,
      },
      files: {
        [`${FAKE_HOME}/.config/agentpicks/credentials.json`]: JSON.stringify({
          projectId: TARGET.projectId,
          apiKey: TARGET.apiKey,
        }),
      },
    });

  it('uploads the bundle once it is written and listed, with the saved login, and prints where it went', async () => {
    const fetched = stubFetch({
      ...ciCopyReplies(),
      [`POST ${UPLOADS}`]: [
        created(RUN_ID, BUNDLE_NAMES, {
          'meta.json': 'https://storage.test/meta',
          'transcript.jsonl': 'https://storage.test/transcript',
          'diff.patch': 'https://storage.test/diff',
          'earlystop.json': 'https://storage.test/earlystop',
        }),
      ],
      [`POST ${UPLOADS}/${RUN_ID}/complete`]: [completed(RUN_ID)],
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(savedLogin(), fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(0);
    expect(ctx.errors).toEqual([]);

    const calls = fetched.filter((c) => c.url !== SETUPS);
    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    const bundle = join(cwd, 'agentpicks-runs', runId!);
    expect(JSON.parse(calls[0]!.body!).runId).toBe(runId);
    expect(calls.map((c) => c.method)).toEqual([
      'POST',
      'PUT',
      'PUT',
      'PUT',
      'PUT',
      'POST',
    ]);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TARGET.apiKey}`);

    const listed = ctx.lines.indexOf('  Redactions: 1 (transcript.jsonl 1)');
    expect(ctx.lines.slice(listed + 1)).toEqual([
      `  Uploaded run ${RUN_ID} to DevTune; analysis pending.`,
      `  Upload status: ${UPLOADS}/${RUN_ID}`,
      '',
      `1 of 1 run written to ${join(cwd, 'agentpicks-runs')}`,
      '1 uploaded to DevTune.',
    ]);
    expect(ctx.lines).toContain(`  Bundle: ${bundle}`);
    expect(
      ctx.lines.indexOf(
        `Uploads each bundle to DevTune project ${TARGET.projectId} once it is written.`,
      ),
    ).toBeLessThan(ctx.lines.indexOf('Run 1 of 1'));
    expect([...ctx.lines, ...ctx.errors].join('\n')).not.toContain(
      TARGET.apiKey,
    );
  });

  it('refuses without a login before Docker is touched, naming login and --no-upload', async () => {
    const calls = stubFetch({});
    const fake = fakeProvider();
    const ctx = context(
      fakeHost({ commands: CLAUDE, env: { ANTHROPIC_API_KEY: KEY } }),
      fake.provider,
      cwd,
    );
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    expect(ctx.errors).toEqual([
      'Uploading needs a DevTune sign-in or project API key. Run agentpicks login, or set DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID. To keep bundles on this machine only, pass --no-upload, or set AGENTPICKS_NO_UPLOAD=1 for every run.',
    ]);
    expect(ctx.dockerCalls).toEqual([]);
    expect(fake.execs).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('keeps every bundle on this machine under AGENTPICKS_NO_UPLOAD, signed out or in, and says how to send them later', async () => {
    for (const [env, out, shown] of [
      [{}, './agentpicks-runs', './agentpicks-runs'],
      [DEVTUNE_ENV, 'my runs', "'my runs'"],
    ] as const) {
      const calls = stubFetch({});
      const ctx = context(
        fakeHost({
          commands: CLAUDE,
          env: { ...env, ANTHROPIC_API_KEY: KEY, AGENTPICKS_NO_UPLOAD: '1' },
        }),
        fakeProvider({ artifacts: ARTIFACTS }).provider,
        cwd,
      );
      expect(
        await main(
          ['run', '--category', 'ci', '--stack', 'nextjs', '--out', out],
          ctx,
        ),
      ).toBe(0);
      expect(ctx.lines).toContain(
        `Keeps each bundle on this machine only. agentpicks upload ${shown} sends them to DevTune later.`,
      );
      expect(ctx.lines.at(-1)).toBe(`1 of 1 run written to ${join(cwd, out)}`);
      expect(calls).toEqual([]);
    }
  });

  it('prints a refusal and how to send the bundle later, and starts no further runs', async () => {
    const message =
      'Uploading self-runs needs an Agent Picks Local Runner, Cloud or Enterprise plan.';
    stubFetch({
      ...ciCopyReplies(),
      [`POST ${UPLOADS}`]: [refused(403, 'plan_excludes_uploads', message)],
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(
      fakeHost({
        commands: CLAUDE,
        env: { ...DEVTUNE_ENV, ANTHROPIC_API_KEY: KEY },
      }),
      fake.provider,
      cwd,
    );
    expect(
      await main(
        ['run', '--category', 'ci', '--stack', 'nextjs', '--runs', '2'],
        ctx,
      ),
    ).toBe(1);
    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    const bundle = join(cwd, 'agentpicks-runs', runId!);
    expect(ctx.errors).toEqual([
      message,
      `The bundle stays in ${bundle}. Send it with: agentpicks upload ${bundle}`,
    ]);
    expect(ctx.lines).not.toContain('Run 2 of 2');
    expect(ctx.lines.slice(-2)).toEqual([
      `1 of 2 runs written to ${join(cwd, 'agentpicks-runs')}`,
      '0 uploaded to DevTune.',
    ]);
  });
});

describe('agentpicks upload', () => {
  afterEach(() => vi.unstubAllGlobals());
  const host = () =>
    fakeHost({
      commands: CLAUDE,
      env: { ...DEVTUNE_ENV, ANTHROPIC_API_KEY: KEY },
    });

  it('lists and uploads every bundle in the --out directory of a --no-upload run', async () => {
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    expect(
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        context(host(), fake.provider, cwd),
      ),
    ).toBe(0);
    const [runId] = readdirSync(join(cwd, 'agentpicks-runs'));
    const bundle = join(cwd, 'agentpicks-runs', runId!);
    const calls = stubFetch({
      [`POST ${UPLOADS}`]: [
        created(runId!, Object.keys(ARTIFACTS), {
          'diff.patch': 'https://storage.test/diff',
        }),
      ],
      [`POST ${UPLOADS}/${runId}/complete`]: [completed(runId!)],
    });
    const ctx = context(host(), fake.provider, cwd);
    expect(await main(['upload', 'agentpicks-runs'], ctx)).toBe(0);
    expect(ctx.errors).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${UPLOADS}`,
      'PUT https://storage.test/diff',
      `POST ${UPLOADS}/${runId}/complete`,
    ]);
    expect(ctx.lines).toEqual([
      `  Bundle: ${bundle}`,
      expect.stringMatching(/^ {4}manifest\.json +\d+(\.\d)? K?B$/),
      expect.stringMatching(/^ {4}artifacts\/meta\.json +\d+ B$/),
      expect.stringMatching(/^ {4}artifacts\/transcript\.jsonl +\d+ B$/),
      expect.stringMatching(/^ {4}artifacts\/diff\.patch +\d+ B$/),
      expect.stringMatching(/^ {4}artifacts\/earlystop\.json +\d+ B$/),
      '  Redactions: 1 (transcript.jsonl 1)',
      `  Uploaded run ${runId} to DevTune; analysis pending.`,
      `  Upload status: ${UPLOADS}/${runId}`,
    ]);
  });

  it('reports a bundle that fails its checks and still uploads the rest of the directory', async () => {
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    expect(
      await main(
        [
          'run',
          '--no-upload',
          '--runs',
          '2',
          '--category',
          'ci',
          '--stack',
          'nextjs',
        ],
        context(host(), fake.provider, cwd),
      ),
    ).toBe(0);
    const [broken, good] = readdirSync(join(cwd, 'agentpicks-runs')).sort();
    writeFileSync(join(cwd, 'agentpicks-runs', broken!, 'manifest.json'), '{}');
    const calls = stubFetch({
      [`POST ${UPLOADS}`]: [created(good!, Object.keys(ARTIFACTS), {})],
      [`POST ${UPLOADS}/${good}/complete`]: [completed(good!)],
    });
    const ctx = context(host(), fake.provider, cwd);
    expect(await main(['upload', 'agentpicks-runs'], ctx)).toBe(1);
    expect(ctx.errors).toEqual([
      expect.stringContaining(`${broken} is not a bundle agentpicks wrote`),
    ]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${UPLOADS}`,
      `POST ${UPLOADS}/${good}/complete`,
    ]);
    expect(ctx.lines.at(-1)).toBe('1 of 2 bundles uploaded to DevTune.');
  });

  it('refuses without a login', async () => {
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    await main(
      ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
      context(host(), fake.provider, cwd),
    );
    const ctx = context(fakeHost(), fake.provider, cwd);
    expect(await main(['upload', 'agentpicks-runs'], ctx)).toBe(1);
    expect(ctx.errors[0]).toMatch(
      /^Uploading needs a DevTune sign-in or project API key/,
    );
  });
});

describe('agentpicks login', () => {
  afterEach(() => vi.unstubAllGlobals());
  const host = (env: Record<string, string> = {}) =>
    fakeHost({
      env: {
        XDG_CONFIG_HOME: join(cwd, 'config'),
        DEVTUNE_API_BASE_URL: TARGET.baseUrl,
        ...env,
      },
    });
  const path = () => join(cwd, 'config', 'agentpicks', 'credentials.json');
  const connection = (scopes: string[]) => ({
    status: 200,
    body: {
      data: {
        project: {
          id: TARGET.projectId,
          name: 'Acme',
          paused: false,
          domains: [],
        },
        credential: { type: 'api_key' },
        scopes,
        features: {},
        checkedAt: '2026-11-11T12:00:00Z',
      },
    },
  });

  it('saves the key and the project it belongs to, readable by this user only, and never prints the key', async () => {
    const calls = stubFetch({
      [`GET ${TARGET.baseUrl}/connection`]: [
        connection(['agent_picks.run', 'project.read']),
      ],
    });
    const ctx = {
      ...playsLogo(context(host(), fakeProvider().provider, cwd)),
      readSecret: async () => `${TARGET.apiKey}\n`,
    };
    expect(await main(['login', '--api-key'], ctx)).toBe(0);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TARGET.apiKey}`);
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual({
      projectId: TARGET.projectId,
      apiKey: TARGET.apiKey,
    });
    expect(statSync(path()).mode & 0o777).toBe(0o600);
    expect(ctx.lines).toEqual([
      `The key belongs to Acme (${TARGET.projectId}).`,
      LOGO,
      `Saved to ${path()}. run and upload send bundles to this project.`,
    ]);
    expect([...ctx.lines, ...ctx.errors].join('\n')).not.toContain(
      TARGET.apiKey,
    );
  });

  it('saves the key for --project without checking it', async () => {
    const calls = stubFetch({});
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      readSecret: async () => TARGET.apiKey,
    };
    expect(
      await main(['login', '--api-key', '--project', TARGET.projectId], ctx),
    ).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(path(), 'utf8')).projectId).toBe(
      TARGET.projectId,
    );
  });

  it('refuses a key holding a character a header cannot carry by name, without echoing it or saving it', async () => {
    const calls = stubFetch({});
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      readSecret: async () => `${TARGET.apiKey}\0`,
    };
    expect(
      await main(['login', '--api-key', '--project', TARGET.projectId], ctx),
    ).toBe(1);
    expect(ctx.errors).toEqual([
      "The key read from standard input isn't a DevTune API key: a key is dtk_live_ followed by letters and digits. Copy it again from API Keys in DevTune.",
    ]);
    expect(existsSync(path())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("saves a key where the lock's native addon cannot load", async () => {
    vi.doMock('fs-native-extensions', () => {
      throw new Error('No native build was found for platform=linux libc=musl');
    });
    try {
      stubFetch({});
      const ctx = {
        ...context(host(), fakeProvider().provider, cwd),
        readSecret: async () => TARGET.apiKey,
      };
      expect(
        await main(['login', '--api-key', '--project', TARGET.projectId], ctx),
      ).toBe(0);
      expect(JSON.parse(readFileSync(path(), 'utf8')).apiKey).toBe(
        TARGET.apiKey,
      );
    } finally {
      vi.doUnmock('fs-native-extensions');
    }
  });

  it('refuses a key without the Agent Picks Run scope, saving nothing', async () => {
    stubFetch({
      [`GET ${TARGET.baseUrl}/connection`]: [connection(['project.read'])],
    });
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      readSecret: async () => TARGET.apiKey,
    };
    expect(await main(['login', '--api-key'], ctx)).toBe(1);
    expect(ctx.errors).toEqual([
      "This key can't upload runs to Acme: it needs the Agent Picks Run scope.",
    ]);
    expect(existsSync(path())).toBe(false);
  });
});

describe('agentpicks login, in the browser', () => {
  afterEach(() => vi.unstubAllGlobals());
  const host = (env: Record<string, string> = {}) =>
    fakeHost({
      env: {
        XDG_CONFIG_HOME: join(cwd, 'config'),
        DEVTUNE_API_BASE_URL: TARGET.baseUrl,
        ...env,
      },
    });
  const path = () => join(cwd, 'config', 'agentpicks', 'credentials.json');

  it('signs in by default, saving the session for the chosen project readable by this user only, and prints no token', async () => {
    stubFetch(signInReplies());
    const browser = consentBrowser();
    const ctx = {
      ...playsLogo(context(host(), fakeProvider().provider, cwd)),
      openBrowser: browser.open,
    };
    expect(await main(['login'], ctx)).toBe(0);
    const { authorize } = await browser.visit;
    expect(ctx.lines).toEqual([
      `Open this address in a browser to sign in and choose your project:\n${authorize.href}\nNo DevTune project yet? Sign up at ${new URL('/auth/sign-up', TARGET.baseUrl).href} and create one, or have your coding agent set one up (https://docs.devtune.ai/getting-started/agent-setup), then run agentpicks login again.`,
      LOGO,
      `Signed in to Acme (${TARGET.projectId}).`,
      'Granted: actions.write, agent_picks.run, project.read, visibility.read.',
      `Saved to ${path()}. run and upload send bundles to this project.`,
    ]);
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toMatchObject({
      type: 'oauth',
      scopes: [
        'agent_picks.run',
        'visibility.read',
        'actions.write',
        'project.read',
      ],
      projectId: TARGET.projectId,
      baseUrl: TARGET.baseUrl,
      refreshToken: 'refresh-one',
    });
    expect(statSync(path()).mode & 0o777).toBe(0o600);
    // The lock is an empty file; nothing else is left beside the login.
    expect(readdirSync(join(cwd, 'config', 'agentpicks')).sort()).toEqual([
      'credentials.json',
      'credentials.json.lock',
    ]);
    expect(readFileSync(`${path()}.lock`, 'utf8')).toBe('');
    expect([...ctx.lines, ...ctx.errors].join('\n')).not.toMatch(
      /access-one|refresh-one|single-use-code/,
    );
  });

  it('replaces a saved key with the sign-in', async () => {
    mkdirSync(join(cwd, 'config', 'agentpicks'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      path(),
      JSON.stringify({ projectId: TARGET.projectId, apiKey: TARGET.apiKey }),
    );
    stubFetch(signInReplies());
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      openBrowser: consentBrowser().open,
    };
    expect(await main(['login'], ctx)).toBe(0);
    expect(readFileSync(path(), 'utf8')).not.toContain(TARGET.apiKey);
  });

  it('with --no-browser, prints the address without opening it', async () => {
    stubFetch(signInReplies());
    const browser = consentBrowser();
    const opened = vi.fn();
    const base = context(host(), fakeProvider().provider, cwd);
    // Someone opens the printed address by hand.
    const ctx = {
      ...base,
      openBrowser: opened,
      out: (line: string) => {
        base.lines.push(line);
        if (line.startsWith('Open this address'))
          void browser.open(line.split('\n')[1]!);
      },
    };
    expect(await main(['login', '--no-browser'], ctx)).toBe(0);
    expect(opened).not.toHaveBeenCalled();
    expect(base.lines[1]).toBe(`Signed in to Acme (${TARGET.projectId}).`);
  });

  it('says to open the address by hand when no browser opens', async () => {
    stubFetch(signInReplies());
    const browser = consentBrowser();
    const base = context(host(), fakeProvider().provider, cwd);
    const ctx = {
      ...base,
      openBrowser: async () => {
        throw new Error('xdg-open: not found');
      },
      out: (line: string) => {
        base.lines.push(line);
        if (line.startsWith("Couldn't open a browser"))
          void browser.open(base.lines[0]!.split('\n')[1]!);
      },
    };
    expect(await main(['login'], ctx)).toBe(0);
    expect(base.lines.slice(1, 3)).toEqual([
      "Couldn't open a browser. Open the address above in a browser on this machine.",
      `Signed in to Acme (${TARGET.projectId}).`,
    ]);
  });

  it('saves a sign-in with what the member could grant, naming the scopes it lacks', async () => {
    stubFetch(signInReplies(['project.read', 'visibility.read']));
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      openBrowser: consentBrowser().open,
    };
    expect(await main(['login'], ctx)).toBe(0);
    expect(ctx.lines.slice(1)).toEqual([
      `Signed in to Acme (${TARGET.projectId}).`,
      'Granted: project.read, visibility.read.',
      "Not granted: agent_picks.run, actions.write. Run agentpicks login again and keep them selected; if DevTune doesn't offer them, ask an account owner for access.",
      `Saved to ${path()}. Uploading needs agent_picks.run, so run and upload refuse until a sign-in holds it.`,
    ]);
    expect(JSON.parse(readFileSync(path(), 'utf8')).scopes).toEqual([
      'project.read',
      'visibility.read',
    ]);
  });

  it('names the variables that override or conflict with the sign-in', async () => {
    for (const [env, note] of [
      [
        { DEVTUNE_API_KEY: TARGET.apiKey },
        'DEVTUNE_API_KEY is set here, and overrides this sign-in.',
      ],
      [
        { DEVTUNE_PROJECT_ID: '11111111-1111-4111-8111-111111111111' },
        `DEVTUNE_PROJECT_ID is set here: run and upload refuse it unless it is ${TARGET.projectId}.`,
      ],
    ] as const) {
      stubFetch(signInReplies());
      const ctx = {
        ...context(host(env), fakeProvider().provider, cwd),
        openBrowser: consentBrowser().open,
      };
      expect(await main(['login'], ctx)).toBe(0);
      expect(ctx.lines.at(-1)).toBe(note);
    }
  });

  it('leaves the saved sign-in as it was when consent is denied', async () => {
    mkdirSync(join(cwd, 'config', 'agentpicks'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(path(), JSON.stringify(savedSession(0)), { mode: 0o600 });
    const before = readFileSync(path(), 'utf8');
    stubFetch(signInReplies());
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      openBrowser: consentBrowser({ deny: true }).open,
    };
    expect(await main(['login'], ctx)).toBe(1);
    expect(ctx.errors).toEqual([
      'Sign-in was not approved. Run agentpicks login to try again.',
    ]);
    expect(readFileSync(path(), 'utf8')).toBe(before);
  });

  it('refuses a project DevTune names with an id that is not a UUID, saving nothing', async () => {
    const replies = signInReplies();
    const answer = signedInConnection();
    answer.body.data.project.id = '../other';
    replies[`GET ${CONNECTION}`] = [answer];
    stubFetch(replies);
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      openBrowser: consentBrowser().open,
    };
    expect(await main(['login'], ctx)).toBe(1);
    expect(existsSync(path())).toBe(false);
  });

  it('signs in through the browser when standard input is not a terminal, naming --api-key for a piped key', async () => {
    stubFetch(signInReplies());
    const ctx = {
      ...context(host(), fakeProvider().provider, cwd),
      stdinIsTerminal: false,
      openBrowser: consentBrowser().open,
    };
    expect(await main(['login'], ctx)).toBe(0);
    expect(ctx.errors).toEqual([
      'To save a key from standard input, pass --api-key.',
    ]);
    expect(ctx.lines[1]).toBe(`Signed in to Acme (${TARGET.projectId}).`);
  });

  it.each([
    [
      ['login', '--project', TARGET.projectId],
      /^--project goes with --api-key/,
    ],
    [['login', '--api-key', '--no-browser'], /^--no-browser goes with/],
  ])('refuses %j', async (argv, message) => {
    const calls = stubFetch({});
    const ctx = context(host(), fakeProvider().provider, cwd);
    expect(await main(argv, ctx)).toBe(1);
    expect(ctx.errors[0]).toMatch(message);
    expect(calls).toEqual([]);
  });
});

/**
 * An unlinked setup file from ci, which uploads as ci with no setup read: the sign-in check's own
 * warning shows on its runs, where a --category run's setup read checks the sign-in instead.
 */
function ciSetupFile() {
  mkdirSync(join(cwd, 'agentpicks'));
  writeFileSync(
    join(cwd, 'agentpicks', 'ci.yaml'),
    'from: ci\nstacks: [nextjs]\n',
  );
}

describe('agentpicks run and upload, with a saved sign-in', () => {
  afterEach(() => vi.unstubAllGlobals());
  const RUN_ID = '0f9d5a8e-5d1c-4b8e-9a43-3c1f0e6b7a21';
  const path = () => join(cwd, 'config', 'agentpicks', 'credentials.json');
  /** This machine with the sign-in saved for real, since renewing it reads and writes the file. */
  const signedIn = (expiresAt: number) => {
    mkdirSync(join(cwd, 'config', 'agentpicks'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(path(), JSON.stringify(savedSession(expiresAt)), {
      mode: 0o600,
    });
    return {
      ...fakeHost({
        commands: CLAUDE,
        env: {
          ANTHROPIC_API_KEY: KEY,
          XDG_CONFIG_HOME: join(cwd, 'config'),
          DEVTUNE_API_BASE_URL: TARGET.baseUrl,
        },
      }),
      readFile: (file: string) =>
        existsSync(file) ? readFileSync(file, 'utf8') : null,
    };
  };
  const uploadReplies = () => ({
    ...ciCopyReplies(),
    [`GET ${CONNECTION}`]: [signedInConnection()],
    [`POST ${UPLOADS}`]: [
      created(RUN_ID, Object.keys(ARTIFACTS), {
        'diff.patch': 'https://storage.test/diff',
      }),
    ],
    [`POST ${UPLOADS}/${RUN_ID}/complete`]: [completed(RUN_ID)],
  });

  it('uploads with the access token while it is valid', async () => {
    const calls = stubFetch(uploadReplies());
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(signedIn(Date.now() + 3_600_000), fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(0);
    expect(calls.map((c) => c.url)).not.toContain(TOKEN);
    expect(
      calls
        .filter((c) => c.method === 'POST')
        .map((c) => c.headers.Authorization),
    ).toEqual(['Bearer access-one', 'Bearer access-one']);
    expect([...ctx.lines, ...ctx.errors].join('\n')).not.toMatch(
      /access-one|refresh-one/,
    );
  });

  it('renews an expired sign-in before Docker starts, saves it, and uploads with the new token', async () => {
    const calls = stubFetch({
      [`POST ${TOKEN}`]: [issued('access-two', 'refresh-two')],
      ...uploadReplies(),
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(signedIn(0), fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(0);
    expect(calls.slice(0, 2).map((c) => c.url)).toEqual([TOKEN, CONNECTION]);
    expect(calls[1]!.headers.Authorization).toBe('Bearer access-two');
    expect(calls.filter((c) => c.url === TOKEN)).toHaveLength(1);
    expect(calls.at(-1)!.headers.Authorization).toBe('Bearer access-two');
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toMatchObject({
      accessToken: 'access-two',
      refreshToken: 'refresh-two',
    });
  });

  it('stops before Docker or any upload when the sign-in cannot be renewed, saying to log in again', async () => {
    const calls = stubFetch({
      [`POST ${TOKEN}`]: [{ status: 400, body: { error: 'invalid_grant' } }],
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(signedIn(0), fake.provider, cwd);
    const before = readFileSync(path(), 'utf8');
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    expect(ctx.errors).toEqual([
      'Your DevTune sign-in has expired or was revoked. Run agentpicks login again.',
    ]);
    expect(ctx.dockerCalls).toEqual([]);
    expect(fake.execs).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([TOKEN]);
    expect(readFileSync(path(), 'utf8')).toBe(before);
  });

  it('upload refuses before sending anything when the sign-in cannot be renewed', async () => {
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const io = signedIn(0);
    expect(
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        context(io, fake.provider, cwd),
      ),
    ).toBe(0);
    const calls = stubFetch({
      [`POST ${TOKEN}`]: [{ status: 401, body: {} }],
    });
    const ctx = context(io, fake.provider, cwd);
    expect(await main(['upload', 'agentpicks-runs'], ctx)).toBe(1);
    expect(ctx.errors).toEqual([
      'Your DevTune sign-in has expired or was revoked. Run agentpicks login again.',
    ]);
    expect(calls.map((c) => c.url)).toEqual([TOKEN]);
  });

  it.each([
    [
      'revoked',
      { status: 401, body: {} },
      'DevTune refused the sign-in. Run agentpicks login again.',
    ],
    [
      'without agent_picks.run',
      signedInConnection(['project.read', 'visibility.read']),
      "This sign-in can't upload runs to Acme now: it lacks the agent_picks.run scope. Your role on the project doesn't allow it, the project is paused, or it was unselected when you signed in. Run agentpicks login again once it can be granted, or ask an account owner for access. To keep bundles on this machine only, pass --no-upload.",
    ],
  ])(
    'stops before Docker when DevTune says the sign-in is %s now',
    async (_state, answer, message) => {
      const calls = stubFetch({ [`GET ${CONNECTION}`]: [answer] });
      const fake = fakeProvider({ artifacts: ARTIFACTS });
      const ctx = context(signedIn(Date.now() + 3_600_000), fake.provider, cwd);
      expect(
        await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
      ).toBe(1);
      expect(ctx.errors).toEqual([message]);
      expect(ctx.dockerCalls).toEqual([]);
      expect(calls.map((c) => c.url)).toEqual([CONNECTION]);
    },
  );

  it.each([
    [
      'cannot be reached',
      new TypeError('fetch failed'),
      "Couldn't check the DevTune sign-in before starting; uploading checks it again. Couldn't reach DevTune at https://devtune.test/api/v2 (TypeError). Check the connection and try again.",
    ],
    [
      'fails',
      { status: 503, body: {} },
      "Couldn't check the DevTune sign-in before starting; uploading checks it again. DevTune answered 503.",
    ],
    [
      'limits the rate',
      { status: 429, body: { message: 'Too many requests. Try again later.' } },
      "Couldn't check the DevTune sign-in before starting; uploading checks it again. Too many requests. Try again later.",
    ],
  ])(
    'warns and runs when DevTune %s at the sign-in check, then uploads',
    async (_state, answer, warning) => {
      const replies = uploadReplies();
      stubFetch({ ...replies, [`GET ${CONNECTION}`]: [answer] });
      ciSetupFile();
      const fake = fakeProvider({ artifacts: ARTIFACTS });
      const ctx = context(signedIn(Date.now() + 3_600_000), fake.provider, cwd);
      expect(await main(['run', 'ci'], ctx)).toBe(0);
      expect(ctx.errors).toEqual([warning]);
      expect(fake.execs.length).toBeGreaterThan(0);
    },
  );

  it('warns and runs when renewing the sign-in fails with a 5xx, keeping the bundle when the upload fails too', async () => {
    stubFetch({
      [`POST ${TOKEN}`]: [
        { status: 503, body: {} },
        { status: 503, body: {} },
      ],
    });
    ciSetupFile();
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(signedIn(0), fake.provider, cwd);
    expect(await main(['run', 'ci'], ctx)).toBe(1);
    expect(ctx.errors[0]).toBe(
      "Couldn't check the DevTune sign-in before starting; uploading checks it again. A sign-in request to DevTune failed (503). Try again later.",
    );
    expect(fake.execs.length).toBeGreaterThan(0);
    expect(ctx.errors[1]).toBe(
      'A sign-in request to DevTune failed (503). Try again later.',
    );
    expect(ctx.errors[2]).toMatch(/^The bundle stays in /);
  });

  it("stops a --category run before Docker when renewing fails with a 5xx at the project's setup read", async () => {
    stubFetch({
      [`POST ${TOKEN}`]: [
        { status: 503, body: {} },
        { status: 503, body: {} },
      ],
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(signedIn(0), fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    // The setup read is the check, so the sign-in check's "checks it again" warning isn't printed.
    expect(ctx.errors).toEqual([
      'A sign-in request to DevTune failed (503). Try again later.',
    ]);
    expect(ctx.dockerCalls).toEqual([]);
    expect(fake.execs).toEqual([]);
  });

  it('stops before Docker when the renewal’s answer is lost, saying to sign in again', async () => {
    const calls = stubFetch({
      [`POST ${TOKEN}`]: [new DOMException('timed out', 'TimeoutError')],
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(signedIn(0), fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    expect(ctx.errors).toEqual([
      "DevTune's answer to renewing the sign-in didn't arrive, so whether it was renewed is unknown. Run agentpicks login.",
    ]);
    expect(ctx.dockerCalls).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([TOKEN]);
  });

  it('upload checks the sign-in with DevTune before sending anything', async () => {
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const io = signedIn(Date.now() + 3_600_000);
    expect(
      await main(
        ['run', '--no-upload', '--category', 'ci', '--stack', 'nextjs'],
        context(io, fake.provider, cwd),
      ),
    ).toBe(0);
    const calls = stubFetch({
      [`GET ${CONNECTION}`]: [signedInConnection(['project.read'])],
    });
    const ctx = context(io, fake.provider, cwd);
    expect(await main(['upload', 'agentpicks-runs'], ctx)).toBe(1);
    expect(ctx.errors[0]).toMatch(
      /^This sign-in can't upload runs to Acme now/,
    );
    expect(calls.map((c) => c.url)).toEqual([CONNECTION]);
  });

  it.each([
    [
      401,
      'Invalid or expired OAuth token. Run devtune login.',
      'Invalid or expired OAuth token. Run agentpicks login.',
    ],
    [
      401,
      'Run devtune login to reconnect and approve access.',
      'Run agentpicks login to reconnect and approve access.',
    ],
    [
      403,
      'This sign-in is for a different project. Run devtune login and select this project.',
      'This sign-in is for a different project. Run agentpicks login and select this project.',
    ],
    [
      403,
      'This sign-in does not allow access to "agent_picks.run" endpoints. Run devtune login again and approve agent_picks.run; if you already did, ask an account owner for access.',
      'This sign-in does not allow access to "agent_picks.run" endpoints. Run agentpicks login again and approve agent_picks.run; if you already did, ask an account owner for access.',
    ],
  ])(
    'names agentpicks login, not devtune login, when DevTune refuses the token at upload (%i)',
    async (status, said, shown) => {
      stubFetch({
        ...ciCopyReplies(),
        [`GET ${CONNECTION}`]: [signedInConnection()],
        [`POST ${UPLOADS}`]: [
          { status, body: { error: 'refused', message: said } },
        ],
      });
      const fake = fakeProvider({ artifacts: ARTIFACTS });
      const ctx = context(signedIn(Date.now() + 3_600_000), fake.provider, cwd);
      expect(
        await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
      ).toBe(1);
      expect(ctx.errors[0]).toBe(shown);
      expect(ctx.errors[1]).toMatch(/^The bundle stays in /);
    },
  );

  it('says to log in again when DevTune refuses the token without a reason', async () => {
    stubFetch({
      ...ciCopyReplies(),
      [`GET ${CONNECTION}`]: [signedInConnection()],
      [`POST ${UPLOADS}`]: [
        {
          status: 401,
          body: 'not json',
        },
      ],
    });
    const fake = fakeProvider({ artifacts: ARTIFACTS });
    const ctx = context(signedIn(Date.now() + 3_600_000), fake.provider, cwd);
    expect(
      await main(['run', '--category', 'ci', '--stack', 'nextjs'], ctx),
    ).toBe(1);
    expect(ctx.errors[0]).toBe(
      'DevTune refused the sign-in. Run agentpicks login again.',
    );
    expect(ctx.errors[1]).toMatch(/^The bundle stays in /);
  });
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
  it.each([
    'init',
    'run',
    'upload',
    'login',
    'cleanup',
    'list',
    'pull',
    'push',
    'validate',
    'results',
  ])(
    'prints usage and exits successfully for %s --help before doing any work',
    async (command) => {
      const ctx = playsLogo(context(fakeHost(), fakeProvider().provider, cwd));
      expect(await main([command, '--help'], ctx)).toBe(0);
      expect(ctx.lines).toEqual([LOGO, USAGE]);
      expect(ctx.errors).toEqual([]);
    },
  );

  it('plays the logo and prints the commands to start with when run on its own', async () => {
    const ctx = playsLogo(context(fakeHost(), fakeProvider().provider, cwd));
    expect(await main([], ctx)).toBe(0);
    expect(ctx.lines).toEqual([LOGO, INTRO]);
    expect(ctx.errors).toEqual([]);
    for (const command of ['login', 'init', 'run', 'results', 'list'])
      expect(USAGE).toContain(`agentpicks ${command}`);
  });

  it('prints the setup schema the package publishes, at the address init points editors to', async () => {
    const ctx = context(fakeHost(), fakeProvider().provider, cwd);
    expect(await main(['schema'], ctx)).toBe(0);
    expect(JSON.parse(ctx.lines.join('\n'))).toEqual(
      JSON.parse(
        readFileSync(join(__dirname, '../../schema/setup.v1.json'), 'utf8'),
      ),
    );
    expect(SETUP_SCHEMA_URL).toBe(
      `https://raw.githubusercontent.com/devtunehq/agentpicks/v${packageJson.version}/schema/setup.v1.json`,
    );
    expect(await main(['schema', '--json'], ctx)).toBe(1);
    expect(ctx.errors).toEqual([
      'agentpicks schema takes no arguments, not --json.',
    ]);
  });

  it('prints its version, and its usage for an unknown command, without the logo', async () => {
    const ctx = playsLogo(context(fakeHost(), fakeProvider().provider, cwd));
    expect(await main(['--version'], ctx)).toBe(0);
    expect(ctx.lines).toEqual([RUNNER.version]);
    expect(await main(['publish'], ctx)).toBe(1);
    expect(ctx.errors[0]).toMatch(
      /^agentpicks has no publish command\.\n\nUsage:/,
    );
    expect(ctx.lines).toEqual([RUNNER.version]);
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
