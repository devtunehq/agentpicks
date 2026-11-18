/**
 * ABOUTME: Exercises endpoint refusal and sandbox reachability through the CLI, before the
 * agent starts, with the same fake host and sandbox boundaries as other self-run tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
} from '../sandbox/provider';
import { FAKE_HOME, fakeHost, fakeImageDocker } from './fake-host';
import { detectRepository } from './init-detect';
import { main, type CliContext } from './main';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agentpicks-endpoint-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function fixture(
  url?: string,
  result: SandboxExecResult = { exitCode: 0, stdout: '', stderr: '' },
) {
  const commands: string[] = [];
  const probe = vi.fn(
    async (_command: string, _options?: SandboxExecOptions) => result,
  );
  const destroy = vi.fn(async () => {});
  const box: Sandbox & { imageDigest(): Promise<string> } = {
    id: 'endpoint-test',
    imageDigest: async () => `sha256:${'c'.repeat(64)}`,
    async exec(command, options) {
      commands.push(command);
      if (command.includes('--noproxy')) return probe(command, options);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    spawn: async () => {},
    writeFile: async () => {},
    readFile: async (path) =>
      path.endsWith('meta.json') ? '{"exitCode":0}' : null,
    destroy,
  };
  const create = vi.fn(async () => box);
  const imageDocker = fakeImageDocker('linux/amd64');
  const build = vi.fn(imageDocker.build);
  const lines: string[] = [];
  const errors: string[] = [];
  const source = `${FAKE_HOME}/.claude/settings.json`;
  const io = fakeHost({
    commands: { claude: '2.1.322 (Claude Code)' },
    env: { ANTHROPIC_API_KEY: 'sk-ant-test-secret-value' },
    files: { [source]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }) },
  });
  const ctx: CliContext = {
    io,
    cwd,
    dockerfileDir: '/pkg/docker',
    stdinIsTerminal: false,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    docker: {
      version: async () => '29.9.2',
      platform: async () => 'linux/amd64',
      ...imageDocker,
      build,
      provider: () => ({ name: 'fake', create, get: async () => box }),
    },
  };
  const run = () =>
    main(
      [
        'run',
        '--category',
        'error-tracking',
        '--stack',
        'empty',
        '--agent',
        'claude-code',
        '--no-upload',
      ],
      ctx,
    );
  return {
    run,
    probe,
    create,
    build,
    lines,
    errors,
    commands,
    destroy,
    io,
    source,
  };
}

it.each([
  'http://localhost:8317',
  'http://[::ffff:7f10:1234]:8317',
  'http://[::ffff:0:0]:8317',
  'not-a-url',
])('refuses %s before building or creating a sandbox', async (url) => {
  const f = fixture(url);
  expect(await f.run()).toBe(1);
  expect(f.errors.join('\n')).toContain(
    `ANTHROPIC_BASE_URL in ${f.source} is ${url}`,
  );
  expect(f.build).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it.each([
  {
    exitCode: 6,
    stderr: 'curl: (6) Could not resolve host: no-such-host.invalid',
    reason: 'could not resolve no-such-host.invalid',
  },
  {
    exitCode: 7,
    stderr: 'curl: (7) Connection refused',
    reason: 'could not connect',
  },
  {
    exitCode: 28,
    stderr: 'curl: (28) Operation timed out',
    reason: 'no answer in 10 s',
  },
  {
    exitCode: 35,
    stderr: 'curl: (35) SSL connect error',
    reason: 'TLS handshake failed',
  },
  {
    exitCode: 60,
    stderr: 'curl: (60) SSL certificate problem',
    reason: 'TLS certificate verification failed',
  },
  {
    exitCode: 52,
    stderr: 'curl: (52) Empty reply from server',
    reason: 'Empty reply from server',
  },
])(
  'reports an unreachable endpoint before setup or agent invocation: $exitCode',
  async ({ exitCode, stderr, reason }) => {
    const url = 'http://no-such-host.invalid:8317';
    const f = fixture(url, { exitCode, stderr, stdout: '' });
    expect(await f.run()).toBe(1);
    expect(f.lines.join('\n')).toContain(`Failed at upload`);
    expect(f.lines.join('\n')).toContain(
      `Claude Code's ANTHROPIC_BASE_URL (${f.source}) is ${url}, and the sandbox can't reach it: ${reason}.`,
    );
    if (exitCode === 6) {
      expect(f.lines.join('\n')).toContain('use its IP address instead');
    } else {
      expect(f.lines.join('\n')).not.toContain('Names only your network knows');
      expect(f.lines.join('\n')).not.toContain('use its IP address');
      expect(f.lines.join('\n')).toContain(
        exitCode === 35 || exitCode === 60
          ? 'Use a certificate from a publicly trusted CA, or plain HTTP on your network'
          : 'Check that the server is running, listens on an address other than 127.0.0.1, and that no firewall blocks the sandbox',
      );
    }
    expect(f.commands.some((command) => command.includes('setup.sh'))).toBe(
      false,
    );
    expect(
      f.commands.findIndex((command) => command.includes('api.ipify.org')),
    ).toBeLessThan(
      f.commands.findIndex((command) => command.includes('--noproxy')),
    );
    expect(f.commands.some((command) => command.includes('run-agent.sh'))).toBe(
      false,
    );
    expect(f.destroy).toHaveBeenCalledOnce();
  },
);

it('probes a reachable endpoint without credentials or captured proxy traffic, then starts the agent', async () => {
  const f = fixture('http://192.168.1.2:8317/v1');
  expect(await f.run(), f.errors.join('\n')).toBe(0);
  expect(f.probe).toHaveBeenCalledExactlyOnceWith(
    "curl --noproxy '*' --globoff --head --silent --show-error --output /dev/null --max-time 10 --url 'http://192.168.1.2:8317'",
    { timeoutSec: 15 },
  );
  expect(f.commands.some((command) => command.includes('run-agent.sh'))).toBe(
    true,
  );
});

it('does not probe when no base URL is carried', async () => {
  const f = fixture();
  expect(await f.run(), f.errors.join('\n')).toBe(0);
  expect(f.probe).not.toHaveBeenCalled();
});

it.each([
  'http://localhost:8317',
  'http://[::ffff:7f10:1234]:8317',
  'http://[::ffff:0:0]:8317',
])('init excludes an agent with a sandbox-local endpoint: %s', (url) => {
  const f = fixture(url);
  expect(detectRepository(cwd, f.io).agents).toEqual([]);
});

it('redacts URL credentials from an endpoint failure and probes only its origin', async () => {
  const f = fixture(
    'http://user:private-url-password@no-such-host.invalid:8317/v1',
    {
      exitCode: 6,
      stdout: '',
      stderr: 'Could not resolve host',
    },
  );
  expect(await f.run()).toBe(1);
  expect(f.lines.join('\n')).not.toContain('private-url-password');
  expect(f.lines.join('\n')).toContain('no-such-host.invalid:8317/v1');
  expect(f.probe.mock.calls[0]?.[0]).toContain(
    "--url 'http://no-such-host.invalid:8317'",
  );
});
