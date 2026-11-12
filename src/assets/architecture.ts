/**
 * ABOUTME: The aarch64 variant of the sandbox assets, for a self-run on an arm64 Docker host.
 * The scripts are written for x86_64, which is what managed runs upload, byte for byte; an
 * aarch64 sandbox gets the same scripts with each pinned x86_64 download swapped for the
 * aarch64 build of the same version, checksum-pinned the same way.
 */
import type { SandboxPlatform } from '../sandbox/platform';

/** The CPU a sandbox runs on, as its `uname -m` names it. */
export type SandboxArchitecture = 'x86_64' | 'aarch64';

export function sandboxArchitecture(
  platform: SandboxPlatform,
): SandboxArchitecture {
  return platform === 'linux/arm64' ? 'aarch64' : 'x86_64';
}

/**
 * Each pinned x86_64 download in the scripts, as written, and its aarch64 counterpart: Node
 * and Python with their checksums (RUNTIMES_SH), mitmproxy (SETUP_SH), which publishes none,
 * and OpenCode's locked platform binary (INSTALL_OPENCODE_SH).
 */
export const AARCH64_BUILDS: readonly (readonly [string, string])[] = [
  [
    'node-v$NODE_VERSION-linux-x64.tar.gz" /tmp/node.tgz \\\n  eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
    'node-v$NODE_VERSION-linux-arm64.tar.gz" /tmp/node.tgz \\\n  33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
  ],
  [
    'cpython-3.13.16+20261001-x86_64-unknown-linux-gnu-install_only.tar.gz" /tmp/python.tgz \\\n  b55f90dfb060e998a47e4a811dae46aaa27b923244044bbcf88de5e57a5fa4c7',
    'cpython-3.13.16+20261001-aarch64-unknown-linux-gnu-install_only.tar.gz" /tmp/python.tgz \\\n  e662f77a0c908d8f9555af85fb7fe636a7c34b0c86adc141f0f7b571bbaea6fd',
  ],
  [
    'mitmproxy-12.2.3-linux-x86_64.tar.gz',
    'mitmproxy-12.2.3-linux-aarch64.tar.gz',
  ],
  [
    'node_modules/opencode-linux-x64-baseline/bin/opencode',
    'node_modules/opencode-linux-arm64/bin/opencode',
  ],
];

/** `text` for a sandbox on `architecture`: unchanged for x86_64. */
export function forArchitecture(
  text: string,
  architecture: SandboxArchitecture,
): string {
  if (architecture === 'x86_64') return text;
  return AARCH64_BUILDS.reduce(
    (out, [x86_64, aarch64]) => out.replaceAll(x86_64, aarch64),
    text,
  );
}
