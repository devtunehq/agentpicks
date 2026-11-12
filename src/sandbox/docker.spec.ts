/**
 * ABOUTME: Tests the Docker sandbox provider against a fake `docker` on PATH that records
 * each invocation's argv, stdin and forwarded env, and replies from per-test fixtures.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOCKER_OUTPUT_CAP_BYTES,
  DOCKER_SANDBOX_IMAGE,
  DockerRequiredError,
  type DockerSandbox,
  DockerDiskSpaceError,
  DockerSandboxProvider,
  type DockerSandboxProviderOptions,
  TIMEOUT_WRAPPER_SH,
} from './docker';
import { UnsupportedArchitectureError } from './platform';

/** The per-exec mark a limited command carries. */
const MARK = /^AGENTPICKS_EXEC_ID=[0-9a-f-]{36}$/;

interface Fixture {
  /** Every one of these must appear in argv for the fixture to answer. */
  match: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  /** Writes to this stream without end. */
  flood?: 'stdout' | 'stderr';
}

interface Call {
  argv: string[];
  stdin: string;
  /** The value, in the client's environment, of every `--env NAME` in argv. */
  env: Record<string, string | undefined>;
}

const FAKE_DOCKER = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DOCKER_DIR;
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const env = {};
  argv.forEach((a, i) => { if (a === '--env') env[argv[i + 1]] = process.env[argv[i + 1]]; });
  fs.appendFileSync(path.join(dir, 'calls.jsonl'),
    JSON.stringify({ argv, stdin: Buffer.concat(chunks).toString('utf8'), env }) + '\\n');
  const fixtures = JSON.parse(fs.readFileSync(path.join(dir, 'fixtures.json'), 'utf8'));
  const f = fixtures.find((x) => x.match.every((m) => argv.includes(m))) || {};
  if (f.flood) {
    const out = process[f.flood];
    const chunk = Buffer.alloc(1024 * 1024, 120);
    const write = () => { while (out.write(chunk)); out.once('drain', write); };
    return write();
  }
  setTimeout(() => {
    process.stdout.write(f.stdout || '');
    process.stderr.write(f.stderr || '');
    process.exitCode = f.exitCode || 0;
  }, f.delayMs || 0);
});
`;

const ID = 'c0ffee';
const FREE: Fixture = {
  match: ['df'],
  stdout: '        Avail\n1826334887936\n',
};

/** A provider whose disk watchdog does not poll unless a test asks it to. */
function provider(options: DockerSandboxProviderOptions = {}) {
  return new DockerSandboxProvider({ diskPollMs: 3_600_000, ...options });
}
/** `docker info`'s architecture on an x86_64 host. */
const AMD64: Fixture = { match: ['info'], stdout: 'x86_64\n' };
const NOW_SEC = 1_800_000_000;
const RUNNING: Fixture = {
  match: ['inspect', '{{.State.Status}}'],
  stdout: 'running\n',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(dir, 'calls.jsonl'), '');
  fixtures([]);
  vi.stubEnv('PATH', dir);
  vi.stubEnv('FAKE_DOCKER_DIR', dir);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function fixtures(list: Fixture[]) {
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify(list));
}

function calls(): Call[] {
  return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
}

/** A sandbox for the running container `ID`, reattached without a create call. */
async function sandbox(options: DockerSandboxProviderOptions = {}) {
  fixtures([
    {
      match: [
        'inspect',
        '{{.State.Status}} {{index .Config.Labels "dev.devtune.agentpicks"}}',
      ],
      stdout: 'running sandbox\n',
    },
  ]);
  const box = await provider(options).get(ID);
  if (!box) throw new Error('expected a sandbox');
  writeFileSync(join(dir, 'calls.jsonl'), '');
  return box;
}

describe('DockerSandboxProvider.create', () => {
  it('refuses, naming Docker, when no docker command is on PATH', async () => {
    vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'no-docker-')));
    const create = provider().create({ timeoutMin: 5 });
    await expect(create).rejects.toBeInstanceOf(DockerRequiredError);
    await expect(create).rejects.toThrow(/Docker is required/);
  });

  it('refuses, naming Docker, when the daemon is unreachable', async () => {
    fixtures([
      {
        match: ['version'],
        exitCode: 1,
        stderr:
          'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      },
    ]);
    const create = provider().create({ timeoutMin: 5 });
    await expect(create).rejects.toBeInstanceOf(DockerRequiredError);
    await expect(create).rejects.toThrow(
      /Docker is required.*Cannot connect to the Docker daemon/,
    );
    expect(calls().map((c) => c.argv[0])).toEqual(['version']);
  });

  it('starts a labelled, size-capped container from the pinned image that sleeps until the time limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW_SEC * 1000 });
    fixtures([
      { match: ['version'], stdout: '28.1.1\n' },
      AMD64,
      { match: ['run'], stdout: `${ID}\n` },
      FREE,
    ]);
    const box = await provider().create({ timeoutMin: 40 });
    expect(box.id).toBe(ID);
    expect(calls().find((c) => c.argv[0] === 'run')!.argv).toEqual([
      'run',
      '--detach',
      '--rm',
      '--log-driver',
      'none',
      '--pull',
      'never',
      '--platform',
      'linux/amd64',
      '--label',
      'dev.devtune.agentpicks=sandbox',
      '--label',
      `dev.devtune.agentpicks.expires=${NOW_SEC + 2400}`,
      '--cpus',
      '2',
      '--memory',
      '4g',
      '--memory-swap',
      '4g',
      '--pids-limit',
      '4096',
      DOCKER_SANDBOX_IMAGE,
      'sleep',
      '2400',
    ]);
  });

  it('adds the labels it is given to every container', async () => {
    fixtures([
      { match: ['version'], stdout: '28.1.1\n' },
      { match: ['info'], stdout: 'x86_64\n' },
      { match: ['run'], stdout: `${ID}\n` },
      FREE,
    ]);
    await provider({
      labels: { 'dev.devtune.agentpicks.session': 'run-1' },
    }).create({ timeoutMin: 1 });
    const argv = calls().find((c) => c.argv[0] === 'run')!.argv;
    expect(
      argv.slice(argv.indexOf('--cpus') - 2, argv.indexOf('--cpus')),
    ).toEqual(['--label', 'dev.devtune.agentpicks.session=run-1']);
  });

  it.each([
    ['x86_64', 'linux/amd64'],
    ['aarch64', 'linux/arm64'],
    ['arm64', 'linux/arm64'],
  ])(
    'runs the container natively: a Docker host reporting %s gets %s',
    async (architecture, platform) => {
      fixtures([
        { match: ['version'], stdout: '28.1.1\n' },
        { match: ['info'], stdout: `${architecture}\n` },
        { match: ['run'], stdout: `${ID}\n` },
        FREE,
      ]);
      await provider().create({ timeoutMin: 1 });
      expect(calls().find((c) => c.argv[0] === 'info')!.argv).toEqual([
        'info',
        '--format',
        '{{.Architecture}}',
      ]);
      const run = calls().find((c) => c.argv[0] === 'run')!.argv;
      expect(run[run.indexOf('--platform') + 1]).toBe(platform);
    },
  );

  it('refuses, naming the architecture, a Docker host it has no sandbox build for, before starting anything', async () => {
    fixtures([
      { match: ['version'], stdout: '28.1.1\n' },
      { match: ['info'], stdout: 'riscv64\n' },
    ]);
    const create = provider().create({ timeoutMin: 1 });
    await expect(create).rejects.toBeInstanceOf(UnsupportedArchitectureError);
    await expect(create).rejects.toThrow(
      'Agent Picks runs on x86_64 or arm64 machines, and Docker reports riscv64.',
    );
    expect(calls().some((c) => c.argv[0] === 'run')).toBe(false);
  });

  it('reports a container that will not start with docker’s reason', async () => {
    fixtures([
      { match: ['version'], stdout: '28.1.1\n' },
      AMD64,
      {
        match: ['run'],
        exitCode: 125,
        stderr: 'Unable to find image local:missing\n',
      },
    ]);
    await expect(
      provider({ image: 'local:missing' }).create({
        timeoutMin: 1,
      }),
    ).rejects.toThrow(
      'starting a sandbox from local:missing failed: Unable to find image',
    );
  });
});

describe('expired sandboxes', () => {
  const LISTING: Fixture = {
    match: ['ps'],
    stdout: [
      `expired1 ${NOW_SEC - 60}`,
      `due ${NOW_SEC}`,
      `live ${NOW_SEC + 60}`,
      'unlabelled ',
    ].join('\n'),
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW_SEC * 1000 });
  });

  function listingAndRemoval() {
    const all = calls();
    return [
      all.find((c) => c.argv[0] === 'ps')!.argv,
      all.find((c) => c.argv[0] === 'rm')?.argv,
    ];
  }

  it('are removed when a sandbox is created, and live ones are kept', async () => {
    fixtures([
      { match: ['version'], stdout: '28.1.1\n' },
      AMD64,
      LISTING,
      { match: ['run'], stdout: `${ID}\n` },
      FREE,
    ]);
    await provider().create({ timeoutMin: 1 });
    expect(listingAndRemoval()).toEqual([
      [
        'ps',
        '--all',
        '--filter',
        'label=dev.devtune.agentpicks=sandbox',
        '--format',
        '{{.ID}} {{.Label "dev.devtune.agentpicks.expires"}}',
      ],
      ['rm', '--force', 'expired1', 'due'],
    ]);
  });

  it('are removed when a sandbox is reattached, so an expired one reattaches as null', async () => {
    fixtures([
      LISTING,
      {
        match: ['inspect'],
        exitCode: 1,
        stderr: 'Error: No such container: due\n',
      },
    ]);
    expect(await provider().get('due')).toBeNull();
    expect(listingAndRemoval()[1]).toEqual([
      'rm',
      '--force',
      'expired1',
      'due',
    ]);
  });

  it('leave nothing to remove when every sandbox is live', async () => {
    fixtures([
      { match: ['ps'], stdout: `live ${NOW_SEC + 60}\n` },
      { match: ['inspect'], stdout: 'running sandbox\n' },
    ]);
    expect((await provider().get('live'))?.id).toBe('live');
    expect(listingAndRemoval()[1]).toBeUndefined();
  });

  it('tolerate another runner removing them first', async () => {
    fixtures([
      LISTING,
      {
        match: ['rm'],
        exitCode: 1,
        stderr: 'Error response from daemon: No such container: due\n',
      },
      { match: ['inspect'], stdout: 'running sandbox\n' },
    ]);
    expect((await provider().get(ID))?.id).toBe(ID);
  });
});

describe('DockerSandboxProvider.get', () => {
  it('reattaches to a running labelled container', async () => {
    expect((await sandbox()).id).toBe(ID);
  });

  it.each([
    ['stopped', { stdout: 'exited sandbox\n' }],
    ['not ours', { stdout: 'running <no value>\n' }],
    ['removed', { exitCode: 1, stderr: `Error: No such container: ${ID}\n` }],
  ])('returns null for a container that is %s', async (_state, reply) => {
    fixtures([{ match: ['inspect'], ...reply }]);
    expect(await provider().get(ID)).toBeNull();
  });
});

describe('DockerSandbox', () => {
  it('runs commands as root through bash -lc, forwarding env by name', async () => {
    const box = await sandbox();
    fixtures([{ match: ['exec'], stdout: 'hi\n', stderr: 'warn' }]);
    const r = await box.exec('echo hi', { env: { API_KEY: 's3cret' } });
    expect(r).toEqual({ exitCode: 0, stdout: 'hi\n', stderr: 'warn' });
    const [call] = calls();
    expect(call!.argv).toEqual([
      'exec',
      '--user',
      'root',
      '--env',
      'API_KEY',
      ID,
      'bash',
      '-lc',
      'echo hi',
    ]);
    expect(call!.env).toEqual({ API_KEY: 's3cret' });
    expect(call!.argv.join(' ')).not.toContain('s3cret');
  });

  it('passes a hostile command to the container verbatim', async () => {
    const box = await sandbox();
    const hostile = `echo "it's $(id -u)" \`whoami\`; rm -rf "$HOME"\nprintf '%s\\n' $PATH`;
    fixtures([{ match: ['exec'] }]);
    await box.exec(hostile);
    await box.spawn(hostile, { timeoutSec: 5 });
    const [exec, spawn] = calls();
    expect(exec!.argv.at(-1)).toBe(hostile);
    expect(spawn!.argv.at(-1)).toBe(hostile);
  });

  it('returns a non-zero exit like any other result', async () => {
    const box = await sandbox();
    fixtures([
      { match: ['exec', 'false'], exitCode: 3, stdout: 'o', stderr: 'e' },
      RUNNING,
    ]);
    expect(await box.exec('false')).toEqual({
      exitCode: 3,
      stdout: 'o',
      stderr: 'e',
    });
  });

  it('stops a command at its timeout and returns timeout’s non-zero exit', async () => {
    const box = await sandbox();
    fixtures([{ match: ['exec', 'sleep 99'], exitCode: 124 }, RUNNING]);
    const r = await box.exec('sleep 99', { timeoutSec: 30 });
    expect(r.exitCode).toBe(124);
    expect(calls()[0]!.argv).toEqual([
      'exec',
      '--user',
      'root',
      '--env',
      expect.stringMatching(MARK),
      ID,
      'bash',
      '-c',
      TIMEOUT_WRAPPER_SH,
      'agentpicks-timeout',
      '10',
      '30',
      'sleep 99',
    ]);
  });

  it('marks each limited command afresh, so a timeout stops only its own descendants', async () => {
    const box = await sandbox();
    fixtures([{ match: ['exec'] }]);
    await box.exec('a', { timeoutSec: 5 });
    await box.exec('b', { timeoutSec: 5 });
    const [a, b] = calls().map((call) => call.argv[4]);
    expect(a).toMatch(MARK);
    expect(b).toMatch(MARK);
    expect(a).not.toBe(b);
  });

  it('kills a client still waiting past the timeout and returns -1, even when the daemon hangs', async () => {
    const box = await sandbox({ timeoutGraceSec: 0 });
    fixtures([
      { match: ['exec', 'hang'], delayMs: 10_000 },
      { match: ['inspect'], delayMs: 10_000, stdout: 'running\n' },
    ]);
    const started = Date.now();
    const r = await box.exec('hang', { timeoutSec: 1 });
    expect(r.exitCode).toBe(-1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each([
    ['exec', 'stdout', (box: DockerSandbox) => box.exec('yes')],
    ['exec', 'stderr', (box: DockerSandbox) => box.exec('yes >&2')],
    ['readFile', 'stdout', (box: DockerSandbox) => box.readFile('/dev/zero')],
  ] as const)(
    'stops %s output that passes the cap on %s and throws, holding no more than the cap',
    async (_method, stream, call) => {
      const box = await sandbox();
      fixtures([{ match: ['exec'], flood: stream }, RUNNING]);
      const before = process.memoryUsage().arrayBuffers;
      let peak = before;
      const sample = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().arrayBuffers);
      }, 5);
      const started = Date.now();
      await expect(call(box)).rejects.toThrow(
        `docker exec printed more than 64 MiB on ${stream}, the cap per stream`,
      );
      clearInterval(sample);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(peak - before).toBeLessThan(DOCKER_OUTPUT_CAP_BYTES * 1.5);
    },
  );

  it('fails, naming the container, when it has stopped', async () => {
    const box = await sandbox();
    fixtures([
      {
        match: ['exec'],
        exitCode: 1,
        stderr: `Error response from daemon: container ${ID} is not running\n`,
      },
      { match: ['inspect'], stdout: 'exited\n' },
    ]);
    await expect(box.exec('true')).rejects.toThrow(
      `sandbox ${ID} is exited, not running`,
    );
    await expect(box.readFile('/x')).rejects.toThrow(`sandbox ${ID} is exited`);
    await expect(box.spawn('true')).rejects.toThrow(`sandbox ${ID} is exited`);
    await expect(box.writeFile('/x', 'y')).rejects.toThrow(
      `sandbox ${ID} is exited`,
    );
  });

  it('fails, naming the container, when it has been removed', async () => {
    const box = await sandbox();
    fixtures([
      {
        match: ['exec'],
        exitCode: 1,
        stderr: `Error: No such container: ${ID}\n`,
      },
      {
        match: ['inspect'],
        exitCode: 1,
        stderr: `Error: No such container: ${ID}\n`,
      },
    ]);
    await expect(box.exec('true')).rejects.toThrow(
      `sandbox ${ID} no longer exists`,
    );
  });

  it('starts detached commands under timeout, forwarding env', async () => {
    const box = await sandbox();
    fixtures([{ match: ['exec'] }]);
    await box.spawn('bash stage.sh setup', {
      env: { A: '1' },
      timeoutSec: 600,
    });
    await box.spawn('bash forever.sh');
    const [limited, unlimited] = calls();
    expect(limited!.argv).toEqual([
      'exec',
      '--detach',
      '--user',
      'root',
      '--env',
      'A',
      '--env',
      expect.stringMatching(MARK),
      ID,
      'bash',
      '-c',
      TIMEOUT_WRAPPER_SH,
      'agentpicks-timeout',
      '10',
      '600',
      'bash stage.sh setup',
    ]);
    expect(limited!.env).toEqual({ A: '1' });
    expect(unlimited!.argv).toEqual([
      'exec',
      '--detach',
      '--user',
      'root',
      ID,
      'bash',
      '-lc',
      'bash forever.sh',
    ]);
  });

  it('writes files through stdin, creating parent directories, with the path as an argument', async () => {
    const box = await sandbox();
    fixtures([{ match: ['exec'] }]);
    const path = "/opt/agent-picks/a dir/$(touch pwned)'.txt";
    await box.writeFile(path, 'line one\nit\'s "quoted"\n');
    const [call] = calls();
    expect(call!.argv).toEqual([
      'exec',
      '--interactive',
      '--user',
      'root',
      ID,
      'bash',
      '-c',
      'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
      'bash',
      path,
    ]);
    expect(call!.stdin).toBe('line one\nit\'s "quoted"\n');
  });

  it('reads files with cat as root; a missing file reads as null', async () => {
    const box = await sandbox();
    fixtures([
      {
        match: ['cat', '/opt/agent-picks/out/meta.json'],
        stdout: '{"exitCode":0}',
      },
      {
        match: ['cat', '/missing'],
        exitCode: 1,
        stderr: 'cat: /missing: No such file or directory\n',
      },
      RUNNING,
    ]);
    expect(await box.readFile('/opt/agent-picks/out/meta.json')).toBe(
      '{"exitCode":0}',
    );
    expect(await box.readFile('/missing')).toBeNull();
    expect(calls()[0]!.argv).toEqual([
      'exec',
      '--user',
      'root',
      ID,
      'cat',
      '--',
      '/opt/agent-picks/out/meta.json',
    ]);
  });

  it('destroys with docker rm --force, and destroying a removed container does not throw', async () => {
    const box = await sandbox();
    fixtures([{ match: ['rm'] }]);
    await box.destroy();
    expect(calls()[0]!.argv).toEqual(['rm', '--force', ID]);
    fixtures([
      {
        match: ['rm'],
        exitCode: 1,
        stderr: `Error response from daemon: No such container: ${ID}\n`,
      },
    ]);
    await box.destroy();
    await box.destroy();
  });

  it('surfaces any other failure to destroy', async () => {
    const box = await sandbox();
    fixtures([
      {
        match: ['rm'],
        exitCode: 1,
        stderr: 'Cannot connect to the Docker daemon\n',
      },
    ]);
    await expect(box.destroy()).rejects.toThrow(
      `removing sandbox ${ID} failed`,
    );
  });

  it('reads the image digest of the container', async () => {
    const box = await sandbox();
    fixtures([{ match: ['inspect', '{{.Image}}'], stdout: 'sha256:abc\n' }]);
    expect(await box.imageDigest()).toBe('sha256:abc');
  });
});

describe('disk limits', () => {
  const SIZE = (stdout: string): Fixture => ({ match: ['--size'], stdout });
  const sizeReads = () =>
    calls().filter((c) => c.argv.includes('--size')).length;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Each poll spawns the fake docker, which takes a while on a loaded machine.
  const WAIT = { timeout: 10_000 };

  it('refuses a sandbox when Docker’s disk has too little free space, and removes the container', async () => {
    fixtures([
      { match: ['version'], stdout: '29.9.2\n' },
      AMD64,
      { match: ['run'], stdout: `${ID}\n` },
      { match: ['df'], stdout: '        Avail\n12345678901\n' },
    ]);
    const create = provider().create({ timeoutMin: 1 });
    await expect(create).rejects.toBeInstanceOf(DockerDiskSpaceError);
    await expect(create).rejects.toThrow(
      "Docker's disk has 12.3 GB free, and a sandbox needs 20 GB.",
    );
    const df = calls().find((c) => c.argv.includes('df'))!;
    expect(df.argv).toEqual(['exec', ID, 'df', '-B1', '--output=avail', '/']);
    expect(
      calls()
        .filter((c) => c.argv[0] === 'rm')
        .map((c) => c.argv),
    ).toEqual([['rm', '--force', ID]]);
  });

  it('removes a sandbox whose writes pass the cap, and names the cap afterwards', async () => {
    const box = await sandbox({ diskCapBytes: 2e9, diskPollMs: 20 });
    fixtures([SIZE('running 1999999999\n'), RUNNING]);
    await vi.waitFor(() => expect(sizeReads()).toBeGreaterThanOrEqual(2), WAIT);
    expect(calls().some((c) => c.argv[0] === 'rm')).toBe(false);
    fixtures([SIZE('running 2000000001\n'), RUNNING]);
    await vi.waitFor(
      () =>
        expect(calls().find((c) => c.argv[0] === 'rm')?.argv).toEqual([
          'rm',
          '--force',
          ID,
        ]),
      WAIT,
    );
    const removed = `sandbox ${ID} was removed after writing more than 2 GB`;
    // The watch records the reason once `rm` returns, a tick after the call above is seen.
    await vi.waitFor(
      () => expect(box.exec('true')).rejects.toThrow(removed),
      WAIT,
    );
    const reads = sizeReads();
    await expect(box.spawn('true')).rejects.toThrow(removed);
    await expect(box.writeFile('/x', 'y')).rejects.toThrow(removed);
    await expect(box.readFile('/x')).rejects.toThrow(removed);
    await pause(100);
    expect(sizeReads()).toBe(reads);
  });

  it('names the cap when the removal lands during a command', async () => {
    const box = await sandbox({ diskCapBytes: 2e9, diskPollMs: 20 });
    fixtures([
      SIZE('running 3000000000\n'),
      { match: ['exec'], delayMs: 300, exitCode: 137 },
      {
        match: ['inspect'],
        exitCode: 1,
        stderr: `Error: No such container: ${ID}\n`,
      },
    ]);
    await expect(box.exec('dd if=/dev/zero of=/fill')).rejects.toThrow(
      'removed after writing more than 2 GB',
    );
  });

  it('stops polling on destroy', async () => {
    const box = await sandbox({ diskPollMs: 20 });
    fixtures([SIZE('running 1\n')]);
    await vi.waitFor(() => expect(sizeReads()).toBeGreaterThanOrEqual(1), WAIT);
    await box.destroy();
    const reads = sizeReads();
    await pause(100);
    expect(sizeReads()).toBe(reads);
  });

  it('keeps polling after a failed read', async () => {
    const box = await sandbox({ diskPollMs: 20 });
    fixtures([
      {
        match: ['--size'],
        exitCode: 1,
        stderr: 'Error response from daemon: context deadline exceeded\n',
      },
    ]);
    await vi.waitFor(() => expect(sizeReads()).toBeGreaterThanOrEqual(3), WAIT);
    await box.destroy();
  });

  it('stops polling once the container has exited', async () => {
    await sandbox({ diskPollMs: 20 });
    fixtures([SIZE('exited 0\n')]);
    await vi.waitFor(() => expect(sizeReads()).toBe(1), WAIT);
    await pause(100);
    expect(sizeReads()).toBe(1);
    expect(calls().some((c) => c.argv[0] === 'rm')).toBe(false);
  });
});
