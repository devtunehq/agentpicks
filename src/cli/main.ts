/**
 * ABOUTME: The `agentpicks` command. `run` tests a coding agent installed on this machine against
 * a committed starter, or the customer's own repository at one commit, in fresh Docker containers, one run after another, and writes a bundle per
 * completed run; `cleanup` removes every container and image agentpicks made. Everything is
 * checked, and what a run copies and needs is printed, before the first container starts.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import packageJson from '../../package.json';
import { DockerSandboxProvider } from '../sandbox/docker';
import type { SandboxPlatform } from '../sandbox/platform';
import type { Sandbox, SandboxProvider } from '../sandbox/provider';
import { planAgent } from './agent-plan';
import {
  assertRepositoryRuns,
  assertStackRuns,
  parseRunArgs,
  resolveTest,
} from './args';
import { resolveCredentials } from './credentials';
import { chooseAgent } from './discover';
import { hostIo, type HostIo } from './host';
import {
  cleanupDocker,
  ensureSandboxImage,
  removeSessionContainers,
  runRequirements,
  SESSION_LABEL,
  type DockerBuild,
  type DockerRun,
} from './image';
import { describeRepository, readRepository } from './repository';
import { selfRun } from './self-run';

export const RUNNER = {
  name: '@devtune/agentpicks',
  version: packageJson.version,
} as const;

export const USAGE = `Usage:
  agentpicks run --category <category> (--stack <stack> | --repo <path> [--ref <commit>])
                 [--runs <n>] [--agent claude-code|codex|opencode|pi] [--model <model>]
                 [--out <dir>]
  agentpicks cleanup
  agentpicks --version

run      Tests the coding agent installed here in a fresh Docker container per run, and writes
         one bundle per completed run to --out (default ./agentpicks-runs). --repo tests your
         repository's committed files at HEAD, or at --ref; uncommitted changes aren't included.
cleanup  Removes every container and image agentpicks made.
`;

export interface CliContext {
  io: HostIo;
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  /** The directory holding the sandbox Dockerfile shipped with the package. */
  dockerfileDir: string;
  /** Docker access; tests replace it. */
  docker?: {
    version(): Promise<string>;
    platform(): Promise<SandboxPlatform>;
    run?: DockerRun;
    build?: DockerBuild;
    provider(image: string, labels: Record<string, string>): SandboxProvider;
  };
}

export function defaultContext(dockerfileDir: string): CliContext {
  return {
    io: hostIo(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    cwd: process.cwd(),
    dockerfileDir,
  };
}

/**
 * The line without terminal controls (escape sequences, carriage returns, C1 codes), keeping tabs
 * and newlines. Container output reaches the CLI's lines, so nothing it prints may drive the
 * host's terminal or clipboard.
 */
export function printable(line: string): string {
  return Array.from(line)
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return (
        code === 9 ||
        code === 10 ||
        (code >= 0x20 && code < 0x7f) ||
        code > 0x9f
      );
    })
    .join('');
}

/** Runs one command and resolves to the process's exit code; refusals print their message alone. */
export async function main(argv: string[], given: CliContext): Promise<number> {
  const ctx: CliContext = {
    ...given,
    out: (line) => given.out(printable(line)),
    err: (line) => given.err(printable(line)),
  };
  const [command, ...rest] = argv;
  try {
    if (command === '--version' || command === '-v') {
      ctx.out(RUNNER.version);
      return 0;
    }
    if (
      !command ||
      command === 'help' ||
      command === '--help' ||
      command === '-h'
    ) {
      ctx.out(USAGE);
      return command ? 0 : 1;
    }
    if (command === 'run') return await runCommand(rest, ctx);
    if (command === 'cleanup') return await cleanupCommand(ctx);
    ctx.err(`agentpicks has no ${command} command.\n\n${USAGE}`);
    return 1;
  } catch (error) {
    ctx.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function docker(ctx: CliContext) {
  const real = new DockerSandboxProvider();
  return (
    ctx.docker ?? {
      version: () => real.dockerVersion(),
      platform: () => real.platform(),
      provider: (image: string, labels: Record<string, string>) =>
        new DockerSandboxProvider({ image, labels }),
    }
  );
}

async function runCommand(argv: string[], ctx: CliContext): Promise<number> {
  const args = parseRunArgs(argv);
  const test = resolveTest(args);
  // Read once, so every run tests the same commit whatever happens to the checkout meanwhile.
  const repository =
    args.repo === undefined
      ? undefined
      : readRepository(resolve(ctx.cwd, args.repo), args.ref);
  const plan = planAgent(chooseAgent(ctx.io, args));
  const credentials = resolveCredentials(plan, ctx.io);
  const dockerAccess = docker(ctx);
  const dockerVersion = await dockerAccess.version();
  const platform = await dockerAccess.platform();
  assertStackRuns(test.environment, platform);
  if (repository) assertRepositoryRuns(repository.install, platform);
  const outDir = resolve(ctx.cwd, args.out);
  const { agent } = plan;

  ctx.out(`agentpicks ${RUNNER.version}, Docker ${dockerVersion}`);
  ctx.out(
    `Agent: ${agent.name} ${agent.version} at ${agent.path}, model ${agent.model} (from ${agent.modelSource})`,
  );
  if (repository)
    for (const line of describeRepository(repository)) ctx.out(line);
  ctx.out(
    `Test: the ${test.category.slug} ${test.intent} request on ${repository ? 'your repository' : test.environment.slug}, ${args.runs} run${args.runs === 1 ? '' : 's'}, one after another`,
  );
  for (const line of credentials.summary) ctx.out(line);
  ctx.out(runRequirements());

  const image = await ensureSandboxImage({
    version: RUNNER.version,
    platform,
    dockerfileDir: ctx.dockerfileDir,
    run: dockerAccess.run,
    build: dockerAccess.build,
  });
  if (image.built) ctx.out(`Built the sandbox image ${image.tag}.`);
  if (image.removed.length > 0)
    ctx.out(`Removed older sandbox images: ${image.removed.join(', ')}.`);

  // Every container this invocation makes carries its session, so an interrupt can find one
  // whose `docker run` it cut off before the container's id came back.
  const session = randomUUID();
  const tracked = trackSandboxes(
    dockerAccess.provider(image.tag, { [SESSION_LABEL]: session }),
  );
  const interrupt = () => {
    ctx.err(
      'Stopping: removing the run’s container. No bundle is written for it.',
    );
    void cancelSandboxes(tracked, session, dockerAccess.run).finally(() =>
      process.exit(130),
    );
  };
  process.once('SIGINT', interrupt);
  let written = 0;
  try {
    for (let i = 1; i <= args.runs; i++) {
      ctx.out('');
      ctx.out(`Run ${i} of ${args.runs}`);
      // A sign-in can lapse between runs; each run checks its own.
      const runCredentials =
        i === 1 ? credentials : resolveCredentials(plan, ctx.io);
      const outcome = await selfRun({
        test,
        plan,
        credentials: runCredentials,
        repository,
        provider: tracked.provider,
        outDir,
        runner: RUNNER,
        host: { os: ctx.io.platform, arch: ctx.io.arch },
        platform,
        log: ctx.out,
      });
      for (const line of describeOutcome(outcome)) ctx.out(line);
      if (outcome.bundle) written++;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
  ctx.out('');
  ctx.out(
    `${written} of ${args.runs} run${args.runs === 1 ? '' : 's'} written to ${outDir}`,
  );
  return written === args.runs ? 0 : 1;
}

async function cleanupCommand(ctx: CliContext): Promise<number> {
  const dockerAccess = docker(ctx);
  await dockerAccess.version();
  const removed = await cleanupDocker(dockerAccess.run);
  ctx.out(
    `Removed ${removed.containers.length} container${removed.containers.length === 1 ? '' : 's'} and ${removed.images.length} image${removed.images.length === 1 ? '' : 's'}${removed.images.length ? `: ${removed.images.join(', ')}` : ''}.`,
  );
  return 0;
}

/** The lines printed for one run: how it ended, and for a written bundle its files, sizes and redactions. */
export function describeOutcome(
  outcome: Awaited<ReturnType<typeof selfRun>>,
): string[] {
  const { run, bundle } = outcome;
  const seconds = Math.round(run.timing.totalMs / 1000);
  if (!bundle)
    return [
      `  Failed at ${run.failedStage ?? 'an unknown stage'} after ${seconds} s: ${run.error ?? 'no error recorded'}`,
      '  No bundle was written for this run.',
    ];
  const meta = parseJsonObject(run.artifacts['meta.json']);
  const early = parseJsonObject(run.artifacts['earlystop.json']);
  const width = Math.max(...bundle.files.map((f) => f.path.length));
  const { redactions } = bundle;
  return [
    `  Finished in ${seconds} s. The agent exited ${String(meta?.exitCode ?? 'unknown')}${early?.killed === true ? `; it was stopped ${String(early.graceSec)} s after a pick landed` : ''}.`,
    `  Bundle: ${bundle.dir}`,
    ...bundle.files.map(
      (f) => `    ${f.path.padEnd(width)}  ${formatBytes(f.bytes)}`,
    ),
    `  Redactions: ${redactions.total}${
      redactions.total
        ? ` (${Object.entries(redactions.byArtifact)
            .map(([name, n]) => `${name} ${n}`)
            .join(', ')})`
        : ''
    }`,
  ];
}

function parseJsonObject(
  text: string | undefined,
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text ?? '');
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * Removes every sandbox an interrupted invocation made: the ones it tracked (waiting for any
 * still being created), then any other container carrying its session label.
 */
export async function cancelSandboxes(
  tracked: ReturnType<typeof trackSandboxes>,
  session: string,
  run?: DockerRun,
): Promise<void> {
  await tracked.destroyAll();
  await removeSessionContainers(session, run);
}

/**
 * The provider, recording every sandbox from the moment its creation starts until its destroy
 * succeeds, so an interrupt can remove it: `destroyAll` waits for creations in flight, then
 * destroys every sandbox still recorded, including one whose own destroy failed or is running.
 */
export function trackSandboxes(inner: SandboxProvider) {
  const creating = new Set<Promise<Sandbox>>();
  const live = new Set<Sandbox>();
  const provider: SandboxProvider = {
    name: inner.name,
    create(options) {
      const created = inner.create(options).then((box) => {
        const tracked: Sandbox = {
          ...box,
          async destroy() {
            await box.destroy();
            live.delete(tracked);
          },
        };
        live.add(tracked);
        return tracked;
      });
      creating.add(created);
      void Promise.allSettled([created]).then(() => creating.delete(created));
      return created;
    },
    get: (id) => inner.get(id),
  };
  return {
    provider,
    async destroyAll() {
      await Promise.allSettled([...creating]);
      return Promise.allSettled([...live].map((box) => box.destroy()));
    },
  };
}
