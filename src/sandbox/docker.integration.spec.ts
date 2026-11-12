/**
 * ABOUTME: Runs the Docker sandbox provider end to end against the local Docker daemon:
 * builds the pinned image for the host's platform, then creates, execs, writes, reads, spawns under a timeout and
 * destroys. Skips, printing why, when `docker info` fails. Run it with `pnpm test:integration`;
 * the default `test:run` leaves it out so CI never builds the image.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DOCKER_SANDBOX_DISK_POLL_MS,
  DOCKER_SANDBOX_IMAGE,
  DOCKER_SANDBOX_MIN_FREE_BYTES,
  DockerDiskSpaceError,
  type DockerSandbox,
  DockerSandboxProvider,
} from './docker';

const DOCKERFILE_DIR = resolve(__dirname, '../../docker');

function dockerUnavailable(): string | null {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (r.error) return r.error.message;
  if (r.status !== 0)
    return r.stderr.trim().split('\n')[0] ?? `exit ${r.status}`;
  return null;
}

function containerStatus(id: string): string {
  return spawnSync(
    'docker',
    ['inspect', '--type', 'container', '--format', '{{.State.Status}}', id],
    { encoding: 'utf8' },
  ).stdout.trim();
}

function sandboxCount(): number {
  return spawnSync(
    'docker',
    [
      'ps',
      '--all',
      '--quiet',
      '--filter',
      'label=dev.devtune.agentpicks=sandbox',
    ],
    { encoding: 'utf8' },
  )
    .stdout.split('\n')
    .filter(Boolean).length;
}

const skipReason = dockerUnavailable();
// Straight to stderr: vitest drops console output from a file whose tests all skip.
if (skipReason) {
  process.stderr.write(
    `Skipping the Docker sandbox integration spec: docker info failed (${skipReason})\n`,
  );
}

describe.skipIf(skipReason !== null)(
  'DockerSandboxProvider against Docker',
  () => {
    const provider = new DockerSandboxProvider();
    let box: DockerSandbox;

    beforeAll(async () => {
      const build = spawnSync(
        'docker',
        [
          'build',
          '--platform',
          await provider.platform(),
          '--tag',
          DOCKER_SANDBOX_IMAGE,
          DOCKERFILE_DIR,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
      );
      expect(build.status).toBe(0);
      box = await provider.create({ timeoutMin: 5 });
    }, 15 * 60_000);

    afterAll(async () => {
      await box?.destroy();
    });

    it('runs commands as root with env, and returns their exit code', async () => {
      expect(
        await box.exec(`echo "$(id -u) $GREETING"; echo err >&2; exit 3`, {
          env: { GREETING: `it's "here"` },
        }),
      ).toEqual({ exitCode: 3, stdout: `0 it's "here"\n`, stderr: 'err\n' });
    });

    it('stops a command at its timeout', async () => {
      const r = await box.exec('sleep 30', { timeoutSec: 2 });
      expect(r.exitCode).toBe(124);
    });

    // The image runs coreutils as one binary, which rewrites argv[0], so each process is found
    // by a sleep length no other test uses; `[s]` keeps pgrep off the shell running it.
    it('stops what a timed-out command moved into its own session, which would hold its output open', async () => {
      const started = Date.now();
      // The descendant keeps the exec's stdout open, so without the stop the client waited
      // out its grace and returned -1.
      const r = await box.exec('setsid sleep 3001 & sleep 30', {
        timeoutSec: 2,
      });
      expect(r.exitCode).toBe(124);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect((await box.exec('pgrep -f "[s]leep 3001$"')).exitCode).toBe(1);
    }, 30_000);

    it('leaves a finished command’s setsid descendants alone', async () => {
      await box.exec('setsid sleep 3002 >/dev/null 2>&1 < /dev/null &', {
        timeoutSec: 10,
      });
      expect((await box.exec('pgrep -f "[s]leep 3002$"')).exitCode).toBe(0);
      await box.exec('pkill -f "[s]leep 3002$"');
    });

    it('writes and reads files, creating parents; a missing file reads as null', async () => {
      await box.writeFile(
        '/opt/agent-picks/nested/dir/a.txt',
        'one\ntwo "$(x)"\n',
      );
      expect(await box.readFile('/opt/agent-picks/nested/dir/a.txt')).toBe(
        'one\ntwo "$(x)"\n',
      );
      expect(await box.readFile('/opt/agent-picks/missing.txt')).toBeNull();
    });

    it('spawns a detached command and stops it at its timeout', async () => {
      await box.spawn(
        'echo started > /tmp/started; sleep 30; echo late > /tmp/late',
        { timeoutSec: 3 },
      );
      await vi.waitFor(
        async () =>
          expect(await box.readFile('/tmp/started')).toBe('started\n'),
        { timeout: 10_000, interval: 250 },
      );
      await vi.waitFor(
        async () =>
          // `[s]leep` keeps pgrep off the bash -lc running it, and `$` off the
          // container's PID 1 `sleep 300`.
          expect((await box.exec('pgrep -f "[s]leep 30$"')).exitCode).not.toBe(
            0,
          ),
        { timeout: 20_000, interval: 500 },
      );
      expect(await box.readFile('/tmp/late')).toBeNull();
    }, 30_000);

    it('runs the image natively, built for the host’s own architecture', async () => {
      const arch = { 'linux/amd64': 'x86_64', 'linux/arm64': 'aarch64' }[
        await provider.platform()
      ];
      expect((await box.exec('uname -m')).stdout.trim()).toBe(arch);
    });

    it('records the image digest and reattaches by id', async () => {
      expect(await box.imageDigest()).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect((await provider.get(box.id))?.id).toBe(box.id);
    });

    it('caps the container at the hosted size, with no swap or log, removes it when it ends, and labels its expiry', () => {
      const inspect = spawnSync(
        'docker',
        [
          'inspect',
          '--format',
          '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.HostConfig.LogConfig.Type}} {{.HostConfig.AutoRemove}} {{index .Config.Labels "dev.devtune.agentpicks.expires"}}',
          box.id,
        ],
        { encoding: 'utf8' },
      );
      const [cpus, memory, swap, pids, logDriver, autoRemove, expires] =
        inspect.stdout.trim().split(' ');
      expect([cpus, memory, swap, pids, logDriver, autoRemove]).toEqual([
        '2000000000',
        '4294967296',
        '4294967296',
        '4096',
        'none',
        'true',
      ]);
      expect(Number(expires)).toBeGreaterThan(Date.now() / 1000);
    });

    it('keeps PID 1, the lifetime timer, out of a root workload’s reach', async () => {
      await box.exec('kill -STOP 1; kill -KILL 1; kill -TERM 1; true');
      const state = await box.exec("awk '/^State:/ {print $2}' /proc/1/status");
      expect(state.stdout.trim()).toBe('S');
      expect(containerStatus(box.id)).toBe('running');
    });

    it('stops and removes a container at its deadline whatever the workload signals', async () => {
      const short = await provider.create({ timeoutMin: 0.1 });
      try {
        // Stops every other process (under `--init`, that includes the timer), then tries PID 1.
        await short.exec(
          'sleep 1000 & for p in /proc/[0-9]*; do [ "${p#/proc/}" = $$ ] || kill -STOP "${p#/proc/}"; done; kill -KILL 1; kill -TERM 1; true',
        );
        expect(containerStatus(short.id)).toBe('running');
        await vi.waitFor(
          // `--rm`: gone, so `docker inspect` prints nothing.
          () => expect(containerStatus(short.id)).toBe(''),
          { timeout: 30_000, interval: 500 },
        );
      } finally {
        await short.destroy();
      }
    }, 45_000);

    it('passes the free-space preflight on this host, and refuses below the minimum', async () => {
      const free = await box.exec('df -B1 --output=avail / | tail -1');
      expect(Number(free.stdout.trim())).toBeGreaterThanOrEqual(
        DOCKER_SANDBOX_MIN_FREE_BYTES,
      );
      const before = sandboxCount();
      await expect(
        new DockerSandboxProvider({
          minFreeBytes: Number.MAX_SAFE_INTEGER,
        }).create({ timeoutMin: 1 }),
      ).rejects.toBeInstanceOf(DockerDiskSpaceError);
      expect(sandboxCount()).toBe(before);
    });

    it('removes a sandbox that writes past the disk cap, and names the cap', async () => {
      const capped = await new DockerSandboxProvider({
        diskCapBytes: 1e9,
      }).create({ timeoutMin: 5 });
      try {
        // The watchdog may remove the container mid-write, which fails the exec.
        await capped
          .exec('dd if=/dev/zero of=/fill bs=1M count=1500 status=none')
          .catch(() => undefined);
        await vi.waitFor(() => expect(containerStatus(capped.id)).toBe(''), {
          timeout: DOCKER_SANDBOX_DISK_POLL_MS + 5_000,
          interval: 250,
        });
        await expect(capped.exec('true')).rejects.toThrow(
          `sandbox ${capped.id} was removed after writing more than 1 GB`,
        );
      } finally {
        await capped.destroy();
      }
    }, 60_000);

    it('destroys idempotently, after which the container is gone', async () => {
      await box.destroy();
      await box.destroy();
      expect(await provider.get(box.id)).toBeNull();
      await expect(box.exec('true')).rejects.toThrow(/no longer exists/);
    });
  },
);
