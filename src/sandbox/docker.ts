/**
 * ABOUTME: Docker implementation of the sandbox provider, for self-runs on the customer's
 * machine. Drives the `docker` CLI with argument arrays (never a shell string built from
 * input): each sandbox is a fresh, labelled container from the pinned image, capped at the
 * hosted sandbox's size, whose PID 1 is a sleep that ends it at the run's time limit, when
 * Docker removes it (the next `create` or `get` removes any the daemon missed), with commands run as root
 * through `bash -lc`. Docker has no portable per-container disk cap, so a host-side watchdog
 * removes a container whose writes pass the disk cap. The cap is not exact: a fast writer can
 * overshoot it by one poll interval of writes, and it holds only while the runner is alive.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { script } from '../assets/script';
import { type SandboxPlatform, sandboxPlatform } from './platform';
import type { Sandbox, SandboxExecOptions, SandboxProvider } from './provider';

/** The local tag `docker build` gives the image from packages/agentpicks/docker. */
export const DOCKER_SANDBOX_IMAGE = 'agentpicks-sandbox:el9';

/** Marks the containers this provider creates, so the runner can find its own. */
export const DOCKER_SANDBOX_LABEL = 'dev.devtune.agentpicks';
const LABEL_VALUE = 'sandbox';
/** The unix second after which a container is past its run's time limit. */
export const DOCKER_SANDBOX_EXPIRES_LABEL = `${DOCKER_SANDBOX_LABEL}.expires`;

/** 2 vCPUs, the size the runner asks Vercel Sandbox for (vercel.ts) and E2B's template gets (e2b-template.ts). */
export const DOCKER_SANDBOX_CPUS = 2;
/** 4 GB, what Vercel Sandbox gives 2 vCPUs and E2B's template is built with (e2b-template.ts); no swap beyond it. */
export const DOCKER_SANDBOX_MEMORY = '4g';
/**
 * Processes and threads in the container. Neither hosted provider documents a limit, so this
 * is room for the agent CLI, its MCP and language servers, and the starters' npm, pip and
 * bundler installs with their worker threads, well under a host's default pid_max.
 */
export const DOCKER_SANDBOX_PIDS_LIMIT = 4096;

/**
 * Free space Docker's data filesystem must have before a sandbox is handed out: room for the
 * disk cap with headroom left for the rest of the machine.
 */
export const DOCKER_SANDBOX_MIN_FREE_BYTES = 20e9;
/**
 * Most a sandbox may write to its container layer before the watchdog removes it. A real
 * `nextjs` setup writes 2.2 GB, so this leaves room for the agent's installs and builds.
 */
export const DOCKER_SANDBOX_DISK_CAP_BYTES = 15e9;
/**
 * How often the watchdog reads the container's size. One `docker container inspect --size`
 * walks the writable layer: 180 ms after a `nextjs` setup (43k files), 710 ms with 243k files.
 */
export const DOCKER_SANDBOX_DISK_POLL_MS = 5000;

/** Seconds `timeout` waits after its signal before it kills the command outright. */
const KILL_AFTER_SEC = 10;

/** Marks every process a limited command starts, so its `setsid` descendants can be found. */
const EXEC_MARK_ENV = 'AGENTPICKS_EXEC_ID';

/**
 * `bash -c <this> agentpicks-timeout <kill-after> <limit> <command>`: runs the command under
 * `timeout`, which stops only the command's own process group. When the limit ends it (124, or
 * 137 once the kill follows), every process still carrying this exec's mark is killed: the
 * descendants that `setsid` moved to a session of their own, which would otherwise outlive the
 * command and hold its output open. The mark is in each process's starting environment, read
 * from /proc with builtins so the scan starts no marked process itself; up to three passes
 * catch what a dying process started.
 */
export const TIMEOUT_WRAPPER_SH = script`timeout -k "$1" "$2" bash -lc "$3"
code=$?
if [ "$code" = 124 ] || [ "$code" = 137 ]; then
  mark="AGENTPICKS_EXEC_ID=$AGENTPICKS_EXEC_ID"
  for pass in 1 2 3; do
    found=
    for d in /proc/[0-9]*; do
      p=$\{d#/proc/}
      [ "$p" = "$$" ] && continue
      mapfile -d '' -t vars 2>/dev/null < "$d/environ" || continue
      for v in "$\{vars[@]}"; do
        if [ "$v" = "$mark" ]; then kill -KILL "$p" 2>/dev/null && found=1; break; fi
      done
    done
    [ -z "$found" ] && break
  done
fi
exit "$code"`;

/** Refuses a sandbox because Docker's data filesystem has too little free space. */
export class DockerDiskSpaceError extends Error {
  override readonly name = 'DockerDiskSpaceError';
}

/** Refuses a self-run because Docker is missing or not running. */
export class DockerRequiredError extends Error {
  override readonly name = 'DockerRequiredError';
}

export interface DockerSandbox extends Sandbox {
  /** The id (`sha256:…`) of the image the container runs, for the run manifest. */
  imageDigest(): Promise<string>;
}

export interface DockerSandboxProviderOptions {
  /** Defaults to `DOCKER_SANDBOX_IMAGE`, which must already be built or pulled. */
  image?: string;
  /**
   * How long past `timeoutSec` an exec's `docker` client may run before it is killed and
   * the exec returns -1. `timeout` stops the command within `KILL_AFTER_SEC` of the limit,
   * so after that only output a detached descendant still holds open keeps the client waiting.
   */
  timeoutGraceSec?: number;
  /** Defaults to `DOCKER_SANDBOX_MIN_FREE_BYTES`. */
  minFreeBytes?: number;
  /** Defaults to `DOCKER_SANDBOX_DISK_CAP_BYTES`. */
  diskCapBytes?: number;
  /** Defaults to `DOCKER_SANDBOX_DISK_POLL_MS`. */
  diskPollMs?: number;
  /** More labels for every container, such as one naming the runner invocation that made it. */
  labels?: Record<string, string>;
}

export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = 'docker';

  constructor(private readonly options: DockerSandboxProviderOptions = {}) {}

  /**
   * Starts a sandbox once Docker's disk has `minFreeBytes` free, and watches its writes
   * against `diskCapBytes` from the host. The cap is not exact: a fast writer can overshoot
   * it by up to one poll interval of writes, and only while the runner is alive. If the runner
   * dies, the container still stops at its deadline, and Docker removes it and its disk then.
   */
  async create({ timeoutMin }: { timeoutMin: number }): Promise<DockerSandbox> {
    await this.dockerVersion();
    await removeExpired();
    const image = this.options.image ?? DOCKER_SANDBOX_IMAGE;
    const platform = await this.platform();
    const lifetimeSec = Math.ceil(timeoutMin * 60);
    // `sleep` is PID 1, so it is the timer: the kernel delivers a signal from inside the
    // container to its init only if init handles it, and sleep handles none (SIGKILL and
    // SIGSTOP can have no handler), so a root workload cannot stop, kill or end it and the
    // container exits at the deadline. `--init` would make tini PID 1 and the sleep an
    // ordinary process that a workload can SIGSTOP to keep the container alive. The cost:
    // nothing reaps orphans, which stay zombies until the container ends, each holding a
    // slot under the PID limit. `--rm` has Docker remove the container, and its disk, when the
    // sleep ends, with no runner alive. `--log-driver none` keeps no log: a root workload can
    // write to PID 1's stdout (`/proc/1/fd/1`), and a log file is outside the layer the disk
    // watchdog measures.
    const r = await docker([
      'run',
      '--detach',
      '--rm',
      '--log-driver',
      'none',
      '--pull',
      'never',
      '--platform',
      platform,
      '--label',
      `${DOCKER_SANDBOX_LABEL}=${LABEL_VALUE}`,
      '--label',
      `${DOCKER_SANDBOX_EXPIRES_LABEL}=${nowSec() + lifetimeSec}`,
      ...Object.entries(this.options.labels ?? {}).flatMap(([key, value]) => [
        '--label',
        `${key}=${value}`,
      ]),
      '--cpus',
      String(DOCKER_SANDBOX_CPUS),
      '--memory',
      DOCKER_SANDBOX_MEMORY,
      '--memory-swap',
      DOCKER_SANDBOX_MEMORY,
      '--pids-limit',
      String(DOCKER_SANDBOX_PIDS_LIMIT),
      image,
      'sleep',
      String(lifetimeSec),
    ]);
    if (r.exitCode !== 0) {
      throw new Error(
        `starting a sandbox from ${image} failed: ${r.stderr.trim()}`,
      );
    }
    const id = r.stdout.trim();
    // Read inside the container before any workload runs, so `df` is ours and measures
    // Docker's data filesystem, which on Docker Desktop is not the host's.
    const df = await docker(['exec', id, 'df', '-B1', '--output=avail', '/']);
    const free = df.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    const minFree = this.options.minFreeBytes ?? DOCKER_SANDBOX_MIN_FREE_BYTES;
    if (df.exitCode !== 0 || !/^\d+$/.test(free)) {
      await docker(['rm', '--force', id]);
      throw new Error(
        `reading free disk space in sandbox ${id} failed: ${df.stderr.trim()}`,
      );
    }
    if (Number(free) < minFree) {
      await docker(['rm', '--force', id]);
      throw new DockerDiskSpaceError(
        `Docker's disk has ${gb(Number(free))} free, and a sandbox needs ${gb(minFree)}. Free up space and try again.`,
      );
    }
    return this.wrap(id);
  }

  async get(id: string): Promise<DockerSandbox | null> {
    await removeExpired();
    const r = await docker([
      'inspect',
      '--type',
      'container',
      '--format',
      `{{.State.Status}} {{index .Config.Labels "${DOCKER_SANDBOX_LABEL}"}}`,
      id,
    ]);
    if (r.exitCode !== 0) {
      if (isNoSuchContainer(r.stderr)) return null;
      throw new Error(`inspecting sandbox ${id} failed: ${r.stderr.trim()}`);
    }
    return r.stdout.trim() === `running ${LABEL_VALUE}` ? this.wrap(id) : null;
  }

  /** The Docker Engine version; refuses with `DockerRequiredError` when the daemon is unreachable. */
  async dockerVersion(): Promise<string> {
    const r = await docker(['version', '--format', '{{.Server.Version}}']);
    if (r.exitCode !== 0) {
      throw new DockerRequiredError(
        `Docker is required to run Agent Picks, and the Docker daemon is not reachable. Start Docker and try again. (${firstLine(r.stderr)})`,
      );
    }
    return r.stdout.trim();
  }

  /**
   * The host's own platform, which the image is built for and the sandbox runs as, so nothing
   * is emulated; `UnsupportedArchitectureError` for an architecture with no sandbox build.
   * An image built for the other platform is not reused: `docker run` refuses it.
   */
  async platform(): Promise<SandboxPlatform> {
    const r = await docker(['info', '--format', '{{.Architecture}}']);
    if (r.exitCode !== 0) {
      throw new Error(
        `reading Docker's architecture failed: ${firstLine(r.stderr)}`,
      );
    }
    return sandboxPlatform(r.stdout.trim());
  }

  private wrap(id: string): DockerSandbox {
    const graceSec = this.options.timeoutGraceSec ?? KILL_AFTER_SEC + 20;
    const watchdog = watchDisk(
      id,
      this.options.diskCapBytes ?? DOCKER_SANDBOX_DISK_CAP_BYTES,
      this.options.diskPollMs ?? DOCKER_SANDBOX_DISK_POLL_MS,
    );
    /** Throws the watchdog's reason, or `assertRunning`'s, when the container is gone. */
    const assertRunning = async () => {
      if (watchdog.removedReason) throw new Error(watchdog.removedReason);
      try {
        await assertContainerRunning(id);
      } catch (error) {
        throw watchdog.removedReason
          ? new Error(watchdog.removedReason)
          : error;
      }
    };
    const assertNotRemoved = () => {
      if (watchdog.removedReason) throw new Error(watchdog.removedReason);
    };
    return {
      id,
      async exec(command, options = {}) {
        assertNotRemoved();
        const r = await docker(
          ['exec', ...execFlags(options), id, ...bashLc(command, options)],
          {
            env: options.env,
            timeoutMs:
              options.timeoutSec === undefined
                ? undefined
                : (options.timeoutSec + graceSec) * 1000,
          },
        );
        // -1 is a client killed at the deadline: return it without asking a daemon that may be hung.
        if (r.exitCode > 0) await assertRunning();
        return r;
      },
      async spawn(command, options = {}) {
        assertNotRemoved();
        const r = await docker(
          [
            'exec',
            '--detach',
            ...execFlags(options),
            id,
            ...bashLc(command, options),
          ],
          { env: options.env },
        );
        if (r.exitCode !== 0) {
          await assertRunning();
          throw new Error(
            `starting a command in sandbox ${id} failed: ${r.stderr.trim()}`,
          );
        }
      },
      async writeFile(path, content) {
        assertNotRemoved();
        // The path is an argument to a fixed script, never part of it.
        const r = await docker(
          [
            'exec',
            '--interactive',
            '--user',
            'root',
            id,
            'bash',
            '-c',
            'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
            'bash',
            path,
          ],
          { input: content },
        );
        if (r.exitCode !== 0) {
          await assertRunning();
          throw new Error(`writing ${path} failed: ${r.stderr.trim()}`);
        }
      },
      async readFile(path) {
        assertNotRemoved();
        const r = await docker([
          'exec',
          '--user',
          'root',
          id,
          'cat',
          '--',
          path,
        ]);
        if (r.exitCode === 0) return r.stdout;
        await assertRunning();
        return null;
      },
      async destroy() {
        watchdog.stop();
        const r = await docker(['rm', '--force', id]);
        if (r.exitCode !== 0 && !isNoSuchContainer(r.stderr)) {
          throw new Error(`removing sandbox ${id} failed: ${r.stderr.trim()}`);
        }
      },
      async imageDigest() {
        const r = await docker([
          'inspect',
          '--type',
          'container',
          '--format',
          '{{.Image}}',
          id,
        ]);
        if (r.exitCode !== 0) {
          throw new Error(
            `inspecting sandbox ${id} failed: ${r.stderr.trim()}`,
          );
        }
        return r.stdout.trim();
      },
    };
  }
}

/**
 * Runs as root, forwarding each env var by name: the value travels in the `docker`
 * client's own environment, so it never appears in a process listing. A limited command
 * also gets a fresh mark (see `TIMEOUT_WRAPPER_SH`), which is no secret.
 */
function execFlags(options: SandboxExecOptions): string[] {
  return [
    '--user',
    'root',
    ...Object.keys(options.env ?? {}).flatMap((key) => ['--env', key]),
    ...(options.timeoutSec === undefined
      ? []
      : ['--env', `${EXEC_MARK_ENV}=${randomUUID()}`]),
  ];
}

/**
 * `bash -lc <command>`, under `timeout` when limited: it stops the command's process group,
 * and `TIMEOUT_WRAPPER_SH` then stops what the command moved out of it with `setsid`.
 */
function bashLc(command: string, options: SandboxExecOptions): string[] {
  return options.timeoutSec === undefined
    ? ['bash', '-lc', command]
    : [
        'bash',
        '-c',
        TIMEOUT_WRAPPER_SH,
        'agentpicks-timeout',
        String(KILL_AFTER_SEC),
        String(options.timeoutSec),
        command,
      ];
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Removes every sandbox container past its expiry label, running or not. The PID 1 sleep
 * ends a sandbox on time unless its clock was frozen (a host suspend) or the daemon
 * restarted; this is the host's backstop, on the next `create` or `get`.
 */
async function removeExpired(): Promise<void> {
  const r = await docker([
    'ps',
    '--all',
    '--filter',
    `label=${DOCKER_SANDBOX_LABEL}=${LABEL_VALUE}`,
    '--format',
    `{{.ID}} {{.Label "${DOCKER_SANDBOX_EXPIRES_LABEL}"}}`,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`listing sandboxes failed: ${r.stderr.trim()}`);
  }
  const now = nowSec();
  const expired = r.stdout
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter(([, expires]) => expires && Number(expires) <= now)
    .map(([id]) => id!);
  if (expired.length === 0) return;
  const rm = await docker(['rm', '--force', ...expired]);
  // Another runner may remove the same containers first.
  if (rm.exitCode !== 0 && !isNoSuchContainer(rm.stderr)) {
    throw new Error(`removing expired sandboxes failed: ${rm.stderr.trim()}`);
  }
}

function gb(bytes: number): string {
  return `${Number((bytes / 1e9).toFixed(1))} GB`;
}

/**
 * Polls the container's writable-layer size from the host, out of the workload's reach, with
 * non-overlapping, unref'd timers. Past `capBytes` it removes the container, which frees the
 * disk at once, and records why. Stops on `stop()` and once the container is gone or exited.
 */
function watchDisk(id: string, capBytes: number, pollMs: number) {
  const state = {
    removedReason: null as string | null,
    stopped: false,
    timer: undefined as NodeJS.Timeout | undefined,
    stop() {
      state.stopped = true;
      clearTimeout(state.timer);
    },
  };
  const poll = async () => {
    const r = await docker([
      'container',
      'inspect',
      '--size',
      '--format',
      '{{.State.Status}} {{.SizeRw}}',
      id,
    ]);
    if (state.stopped) return;
    const [status, size] = r.stdout.trim().split(' ');
    // A failed read retries at the next tick; only a gone or exited container ends the watch.
    if (r.exitCode !== 0 && !isNoSuchContainer(r.stderr)) return schedule();
    if (r.exitCode !== 0 || status !== 'running') return state.stop();
    if (Number(size) > capBytes) {
      const rm = await docker(['rm', '--force', id]);
      if (rm.exitCode === 0 || isNoSuchContainer(rm.stderr)) {
        state.removedReason = `sandbox ${id} was removed after writing more than ${gb(capBytes)}`;
        return state.stop();
      }
    }
    schedule();
  };
  const schedule = () => {
    if (state.stopped) return;
    // A failed read is retried at the next tick rather than ending the watch.
    state.timer = setTimeout(() => void poll().catch(schedule), pollMs);
    state.timer.unref();
  };
  schedule();
  return state;
}

/** Throws, naming the container, when it has stopped or no longer exists. */
async function assertContainerRunning(id: string): Promise<void> {
  const r = await docker([
    'inspect',
    '--type',
    'container',
    '--format',
    '{{.State.Status}}',
    id,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`sandbox ${id} no longer exists`);
  }
  const status = r.stdout.trim();
  if (status !== 'running') {
    throw new Error(`sandbox ${id} is ${status}, not running`);
  }
}

function isNoSuchContainer(stderr: string): boolean {
  return /no such (?:container|object)/i.test(stderr);
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Most bytes one `docker` call may print on each of stdout and stderr; past it the client
 * is killed and the call throws. The largest reads a run makes are `collectArtifacts` in
 * agent-picks run-one.ts: diff.patch is cut to 400 KB by RUN_AGENT_SH and source-files.json
 * to SOURCE_ARTIFACT_BYTES, but transcript.jsonl, requests.jsonl, mitm.log and agent.err
 * have no bound at source. The largest bound a reader applies to them is trace.ts's
 * MAX_TRACE_BYTES (16 MiB of transcript kept), so the cap is four times that.
 */
export const DOCKER_OUTPUT_CAP_BYTES = 64 * 1024 * 1024;

/**
 * Runs `docker` with an argument array. A missing executable refuses the run with
 * `DockerRequiredError`; a client still running at `timeoutMs` is killed and reports -1;
 * one printing past `DOCKER_OUTPUT_CAP_BYTES` on a stream is killed and the call throws.
 * The client runs in a process group of its own, so a Ctrl-C at the terminal reaches only the
 * runner: a `docker run` it would cut off mid-request finishes and returns the container's id,
 * and the runner removes the container itself.
 */
export function docker(
  args: string[],
  options: {
    input?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('docker', args, {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const bytes = { stdout: 0, stderr: 0 };
    let overflowed: 'stdout' | 'stderr' | null = null;
    const capture =
      (stream: 'stdout' | 'stderr', chunks: Buffer[]) => (chunk: Buffer) => {
        if (overflowed) return;
        bytes[stream] += chunk.length;
        if (bytes[stream] > DOCKER_OUTPUT_CAP_BYTES) {
          overflowed = stream;
          chunks.length = 0;
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      };
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs);
    child.stdout.on('data', capture('stdout', stdout));
    child.stderr.on('data', capture('stderr', stderr));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new DockerRequiredError(
              'Docker is required to run Agent Picks, and no docker command is on PATH. Install Docker and try again.',
            )
          : error,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (overflowed) {
        reject(
          new Error(
            `docker ${args[0]} printed more than ${DOCKER_OUTPUT_CAP_BYTES / 1024 / 1024} MiB on ${overflowed}, the cap per stream, so it was stopped`,
          ),
        );
        return;
      }
      resolve({
        exitCode: timedOut ? -1 : (code ?? -1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    // A client that exits before reading its input closes the pipe; the exit code reports it.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
