/**
 * ABOUTME: The Linux platform a self-run's sandbox runs on, which is the Docker host's own
 * architecture so nothing is emulated; the sandbox assets are built for it
 * (`sandboxArchitecture`). Hosted sandboxes are x86_64.
 */
export type SandboxPlatform = 'linux/amd64' | 'linux/arm64';

/** The platform for each name `docker info` gives the host's architecture. */
const PLATFORMS: Record<string, SandboxPlatform> = {
  x86_64: 'linux/amd64',
  amd64: 'linux/amd64',
  aarch64: 'linux/arm64',
  arm64: 'linux/arm64',
};

/** Refuses a self-run on a Docker host whose architecture has no sandbox build. */
export class UnsupportedArchitectureError extends Error {
  override readonly name = 'UnsupportedArchitectureError';
}

/** The sandbox platform for the architecture `docker info --format {{.Architecture}}` reports. */
export function sandboxPlatform(architecture: string): SandboxPlatform {
  const platform = Object.hasOwn(PLATFORMS, architecture)
    ? PLATFORMS[architecture]
    : undefined;
  if (!platform) {
    throw new UnsupportedArchitectureError(
      `Agent Picks runs on x86_64 or arm64 machines, and Docker reports ${architecture || 'no architecture'}.`,
    );
  }
  return platform;
}
