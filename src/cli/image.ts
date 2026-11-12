/**
 * ABOUTME: The sandbox image a self-run starts from: built for the Docker host's platform from the
 * Dockerfile shipped in the package when this version's tag is missing or was built for
 * another platform, labelled `dev.devtune.agentpicks` so the runner can
 * find its own, with older tags removed after a build. `cleanupDocker` removes every labelled
 * container and image. Also states what a run needs from Docker, from the provider's limits.
 */
import { spawn } from 'node:child_process';

import {
  DOCKER_SANDBOX_CPUS,
  DOCKER_SANDBOX_DISK_CAP_BYTES,
  DOCKER_SANDBOX_LABEL,
  DOCKER_SANDBOX_MEMORY,
  DOCKER_SANDBOX_MIN_FREE_BYTES,
  DockerRequiredError,
  docker,
  type DockerResult,
} from '../sandbox/docker';
import type { SandboxPlatform } from '../sandbox/platform';

export const SANDBOX_IMAGE_REPOSITORY = 'agentpicks-sandbox';

/** Runs `docker` with an argument array; injectable for tests. */
export type DockerRun = (args: string[]) => Promise<DockerResult>;

/** Builds an image, streaming Docker's output; resolves to the exit code. Injectable for tests. */
export type DockerBuild = (args: string[]) => Promise<number>;

export function sandboxImageTag(version: string): string {
  return `${SANDBOX_IMAGE_REPOSITORY}:${version}`;
}

/** What one run needs from Docker, from the provider's limits. */
export function runRequirements(): string {
  return `Each run needs Docker with ${DOCKER_SANDBOX_CPUS} CPUs, ${DOCKER_SANDBOX_MEMORY.replace('g', ' GB')} of memory and ${DOCKER_SANDBOX_MIN_FREE_BYTES / 1e9} GB free on Docker's disk, and may write up to ${DOCKER_SANDBOX_DISK_CAP_BYTES / 1e9} GB there while it runs.`;
}

/**
 * The sandbox image for this runner version and `platform`: reused when its tag exists for that
 * platform, otherwise built for it from `dockerfileDir` (replacing a tag built for another
 * platform), after which every older labelled image is removed.
 */
export async function ensureSandboxImage({
  version,
  platform,
  dockerfileDir,
  run = docker,
  build = dockerBuild,
}: {
  version: string;
  platform: SandboxPlatform;
  dockerfileDir: string;
  run?: DockerRun;
  build?: DockerBuild;
}): Promise<{ tag: string; built: boolean; removed: string[] }> {
  const tag = sandboxImageTag(version);
  const inspect = await run([
    'image',
    'inspect',
    '--format',
    '{{.Os}}/{{.Architecture}}',
    tag,
  ]);
  if (inspect.exitCode === 0 && inspect.stdout.trim() === platform)
    return { tag, built: false, removed: [] };
  const code = await build([
    'build',
    '--platform',
    platform,
    '--label',
    `${DOCKER_SANDBOX_LABEL}=image`,
    '--label',
    `${DOCKER_SANDBOX_LABEL}.version=${version}`,
    '--tag',
    tag,
    dockerfileDir,
  ]);
  if (code !== 0)
    throw new Error(
      `Building the sandbox image ${tag} failed (docker build exit ${code}); Docker's output is above.`,
    );
  return { tag, built: true, removed: await removeOlderImages(tag, run) };
}

/** Removes every labelled image other than `keep` (older tags, and builds left untagged). */
export async function removeOlderImages(
  keep: string,
  run: DockerRun = docker,
): Promise<string[]> {
  const images = await labelledImages(run);
  const keepId = images.find((image) => image.ref === keep)?.id;
  const stale = images.filter((image) => image.id !== keepId);
  return removeImages(stale, run);
}

/** Removes every labelled container, running or not, then every labelled image. */
export async function cleanupDocker(
  run: DockerRun = docker,
): Promise<{ containers: string[]; images: string[] }> {
  const containers = await removeContainers(
    `label=${DOCKER_SANDBOX_LABEL}`,
    run,
  );
  return {
    containers,
    images: await removeImages(await labelledImages(run), run),
  };
}

/** The label that names the `agentpicks` invocation a container belongs to. */
export const SESSION_LABEL = `${DOCKER_SANDBOX_LABEL}.session`;

/**
 * Removes every container this invocation made, found by its session label, so one whose
 * `docker run` was interrupted before its id came back is removed too.
 */
export function removeSessionContainers(
  session: string,
  run: DockerRun = docker,
): Promise<string[]> {
  return removeContainers(`label=${SESSION_LABEL}=${session}`, run);
}

/** Removes every container matching a `docker ps` filter, running or not; returns their ids. */
async function removeContainers(
  filter: string,
  run: DockerRun,
): Promise<string[]> {
  const ps = await run(['ps', '--all', '--quiet', '--filter', filter]);
  if (ps.exitCode !== 0)
    throw new Error(
      `listing agentpicks containers failed: ${ps.stderr.trim()}`,
    );
  const containers = ps.stdout.split('\n').filter(Boolean);
  if (containers.length > 0) {
    const rm = await run(['rm', '--force', ...containers]);
    if (rm.exitCode !== 0 && !/no such container/i.test(rm.stderr))
      throw new Error(
        `removing agentpicks containers failed: ${rm.stderr.trim()}`,
      );
  }
  return containers;
}

async function labelledImages(
  run: DockerRun,
): Promise<{ id: string; ref: string }[]> {
  const r = await run([
    'image',
    'ls',
    '--all',
    '--no-trunc',
    '--filter',
    `label=${DOCKER_SANDBOX_LABEL}`,
    '--format',
    '{{.ID}} {{.Repository}}:{{.Tag}}',
  ]);
  if (r.exitCode !== 0)
    throw new Error(`listing agentpicks images failed: ${r.stderr.trim()}`);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, ref] = line.trim().split(' ');
      return { id: id!, ref: ref ?? '' };
    });
}

/** Removes images by tag where they have one, by id where they don't; reports what went. */
async function removeImages(
  images: { id: string; ref: string }[],
  run: DockerRun,
): Promise<string[]> {
  const refs = [
    ...new Set(
      images.map((image) =>
        image.ref.includes('<none>') ? image.id : image.ref,
      ),
    ),
  ];
  if (refs.length === 0) return [];
  const r = await run(['image', 'rm', '--force', ...refs]);
  if (r.exitCode !== 0 && !/no such image/i.test(r.stderr))
    throw new Error(`removing agentpicks images failed: ${r.stderr.trim()}`);
  return refs;
}

/** `docker <args>` with Docker's own output on this process's stderr. */
function dockerBuild(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', process.stderr, process.stderr],
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new DockerRequiredError(
              'Docker is required to run Agent Picks, and no docker command is on PATH. Install Docker and try again.',
            )
          : error,
      ),
    );
    child.on('close', (code) => resolve(code ?? 1));
  });
}
