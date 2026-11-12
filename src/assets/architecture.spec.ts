/**
 * ABOUTME: Holds the sandbox assets to x86_64 text unless a run asks for aarch64, and shows
 * the aarch64 variant swaps every pinned download for the aarch64 build: by the asset text,
 * and by running the runtime downloads under bash with `curl` and the commands after it stubbed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findEnvironment } from '../catalogue/environments';
import type { AgentKind } from '../run/agent-kind';
import {
  AARCH64_BUILDS,
  forArchitecture,
  sandboxArchitecture,
} from './architecture';
import { buildSandboxAssets } from './sandbox-assets';
import { RUNTIMES_SH } from './static-scripts';

const AGENTS: (AgentKind | undefined)[] = [
  undefined,
  'claude_code',
  'codex',
  'opencode',
  'pi',
];
const SIGNALS = { earlyStop: { installPattern: 'x', codePattern: 'x' } };
const nextjs = findEnvironment('nextjs')!;
const text = (agent: AgentKind | undefined, options = {}) =>
  buildSandboxAssets(nextjs, SIGNALS, agent, options)
    .map((asset) => asset.content)
    .join('\n');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'architecture-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs `script` under bash. Every external command it reaches after the download is a stub
 * that logs its argv (and sha256sum its stdin), and the profile script is written under the
 * temporary directory. `--norc`: Node's stdio pipes are sockets, which bash takes for an ssh
 * session and sources ~/.bashrc, and a .bashrc that prepends to PATH puts the real `curl`
 * ahead of the stubs.
 */
function run(script: string) {
  const bin = join(dir, 'bin');
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const stub = (body: string) =>
    `#!/bin/bash\necho "$(basename "$0") $*" >> ${log}\n${body}\n`;
  spawnSync('mkdir', ['-p', bin, join(dir, 'etc/profile.d')]);
  writeFileSync(join(bin, 'sha256sum'), stub(`cat >> ${log}`), {
    mode: 0o755,
  });
  for (const name of ['curl', 'tar', 'rm', 'ln'])
    writeFileSync(join(bin, name), stub(''), { mode: 0o755 });
  const r = spawnSync(
    '/bin/bash',
    [
      '--norc',
      '-c',
      `set -e\n${script.replaceAll('/etc/profile.d/', `${dir}/etc/profile.d/`)}`,
    ],
    {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, S: `${dir}/opt` },
      // Node's stdin pipe is a socket, and bash built with SSH_SOURCE_BASHRC (Arch, Debian)
      // then reads ~/.bashrc, which can put /bin ahead of the stubs.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return { status: r.status, log: readFileSync(log, 'utf8') };
}

describe('sandbox assets by architecture', () => {
  it.each(AGENTS)(
    'are the x86_64 text, byte for byte, unless aarch64 is asked for (%s)',
    (agent) => {
      expect(text(agent, { architecture: 'x86_64' })).toBe(text(agent));
      expect(forArchitecture(text(agent), 'x86_64')).toBe(text(agent));
    },
  );

  it('carry every pinned x86_64 download the aarch64 variant swaps', () => {
    for (const [x86_64] of AARCH64_BUILDS)
      expect(text('opencode')).toContain(x86_64);
  });

  it.each(AGENTS)(
    'swap every pinned download for its aarch64 build on aarch64 (%s)',
    (agent) => {
      const aarch64 = text(agent, { architecture: 'aarch64' });
      for (const [x86_64, arm64] of AARCH64_BUILDS) {
        expect(aarch64).not.toContain(x86_64);
        if (text(agent).includes(x86_64)) expect(aarch64).toContain(arm64);
      }
    },
  );

  it('map the Docker host platform to the sandbox CPU', () => {
    expect(sandboxArchitecture('linux/amd64')).toBe('x86_64');
    expect(sandboxArchitecture('linux/arm64')).toBe('aarch64');
  });
});

describe('pinned runtime downloads', () => {
  it('fetch the x86_64 builds as written, each checked against its checksum', () => {
    const r = run(RUNTIMES_SH);
    expect(r.status).toBe(0);
    expect(r.log).toContain(
      'curl -fsSL https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz -o /tmp/node.tgz',
    );
    expect(r.log).toContain(
      'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c  /tmp/node.tgz',
    );
    expect(r.log).toContain(
      'curl -fsSL https://github.com/astral-sh/python-build-standalone/releases/download/20261001/cpython-3.13.16+20261001-x86_64-unknown-linux-gnu-install_only.tar.gz -o /tmp/python.tgz',
    );
    expect(r.log).toContain(
      'b55f90dfb060e998a47e4a811dae46aaa27b923244044bbcf88de5e57a5fa4c7  /tmp/python.tgz',
    );
  });

  it('fetch the aarch64 builds of the same versions for aarch64', () => {
    const r = run(forArchitecture(RUNTIMES_SH, 'aarch64'));
    expect(r.status).toBe(0);
    expect(r.log).toContain(
      'curl -fsSL https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz -o /tmp/node.tgz',
    );
    expect(r.log).toContain(
      '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3  /tmp/node.tgz',
    );
    expect(r.log).toContain(
      'curl -fsSL https://github.com/astral-sh/python-build-standalone/releases/download/20261001/cpython-3.13.16+20261001-aarch64-unknown-linux-gnu-install_only.tar.gz -o /tmp/python.tgz',
    );
    expect(r.log).toContain(
      'e662f77a0c908d8f9555af85fb7fe636a7c34b0c86adc141f0f7b571bbaea6fd  /tmp/python.tgz',
    );
  });
});

describe('a repository run on aarch64', () => {
  it('copies the customer’s files as committed, rewriting only the scripts', () => {
    const packed = 'a file that names mitmproxy-12.2.3-linux-x86_64.tar.gz\n';
    const assets = buildSandboxAssets(nextjs, SIGNALS, 'claude_code', {
      architecture: 'aarch64',
      repository: {
        packed,
        install: { node: null, python: null, ruby: null },
      },
    });
    const file = (name: string) =>
      assets.find((a) => a.path === `/opt/agent-picks/${name}`)?.content;
    expect(file('repository.tsv')).toBe(packed);
    expect(file('setup.sh')).toContain('mitmproxy-12.2.3-linux-aarch64.tar.gz');
  });
});
