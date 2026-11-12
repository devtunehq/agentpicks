/**
 * ABOUTME: Covers the sandbox image's build for the host's platform, its reuse and rebuild by
 * platform, pruning, and `cleanup`, against a recording fake docker.
 */
import { describe, expect, it } from 'vitest';

import type { DockerResult } from '../sandbox/docker';
import {
  cleanupDocker,
  ensureSandboxImage,
  removeOlderImages,
  removeSessionContainers,
  runRequirements,
  type DockerRun,
} from './image';

const OK = { exitCode: 0, stdout: '', stderr: '' };

/** A docker that answers by the first argument it matches, recording every call. */
function fakeDocker(answers: [string, Partial<DockerResult>][]) {
  const calls: string[][] = [];
  const run: DockerRun = async (args) => {
    calls.push(args);
    const answer = answers.find(([match]) => args.join(' ').startsWith(match));
    return { ...OK, ...answer?.[1] };
  };
  return { run, calls };
}

const IMAGES = [
  'sha256:new agentpicks-sandbox:0.2.0',
  'sha256:old agentpicks-sandbox:0.1.0',
  'sha256:dangling <none>:<none>',
].join('\n');

describe('ensureSandboxImage', () => {
  it('reuses the tag for this version when it exists for the host’s platform', async () => {
    const docker = fakeDocker([['image inspect', { stdout: 'linux/arm64\n' }]]);
    let builds = 0;
    const result = await ensureSandboxImage({
      version: '0.2.0',
      platform: 'linux/arm64',
      dockerfileDir: '/pkg/docker',
      run: docker.run,
      build: async () => (builds++, 0),
    });
    expect(result).toEqual({
      tag: 'agentpicks-sandbox:0.2.0',
      built: false,
      removed: [],
    });
    expect(builds).toBe(0);
    expect(docker.calls).toEqual([
      [
        'image',
        'inspect',
        '--format',
        '{{.Os}}/{{.Architecture}}',
        'agentpicks-sandbox:0.2.0',
      ],
    ]);
  });

  it('rebuilds the tag for the host’s platform when it was built for another, then removes the old build', async () => {
    const docker = fakeDocker([
      ['image inspect', { stdout: 'linux/amd64\n' }],
      [
        'image ls',
        {
          stdout:
            'sha256:arm agentpicks-sandbox:0.2.0\nsha256:amd <none>:<none>',
        },
      ],
    ]);
    const builds: string[][] = [];
    const result = await ensureSandboxImage({
      version: '0.2.0',
      platform: 'linux/arm64',
      dockerfileDir: '/pkg/docker',
      run: docker.run,
      build: async (args) => (builds.push(args), 0),
    });
    expect(builds).toEqual([
      [
        'build',
        '--platform',
        'linux/arm64',
        '--label',
        'dev.devtune.agentpicks=image',
        '--label',
        'dev.devtune.agentpicks.version=0.2.0',
        '--tag',
        'agentpicks-sandbox:0.2.0',
        '/pkg/docker',
      ],
    ]);
    expect(result).toEqual({
      tag: 'agentpicks-sandbox:0.2.0',
      built: true,
      removed: ['sha256:amd'],
    });
  });

  it('builds a missing tag with the label, then removes every older labelled image', async () => {
    const docker = fakeDocker([
      ['image inspect', { exitCode: 1, stderr: 'No such image' }],
      ['image ls', { stdout: IMAGES }],
    ]);
    const builds: string[][] = [];
    const result = await ensureSandboxImage({
      version: '0.2.0',
      platform: 'linux/amd64',
      dockerfileDir: '/pkg/docker',
      run: docker.run,
      build: async (args) => (builds.push(args), 0),
    });
    expect(builds).toEqual([
      [
        'build',
        '--platform',
        'linux/amd64',
        '--label',
        'dev.devtune.agentpicks=image',
        '--label',
        'dev.devtune.agentpicks.version=0.2.0',
        '--tag',
        'agentpicks-sandbox:0.2.0',
        '/pkg/docker',
      ],
    ]);
    expect(result).toEqual({
      tag: 'agentpicks-sandbox:0.2.0',
      built: true,
      removed: ['agentpicks-sandbox:0.1.0', 'sha256:dangling'],
    });
    expect(docker.calls.at(-1)).toEqual([
      'image',
      'rm',
      '--force',
      'agentpicks-sandbox:0.1.0',
      'sha256:dangling',
    ]);
    expect(docker.calls.find((c) => c[1] === 'ls')).toContain(
      'label=dev.devtune.agentpicks',
    );
  });

  it('fails, naming the tag, when the build fails', async () => {
    const docker = fakeDocker([['image inspect', { exitCode: 1 }]]);
    await expect(
      ensureSandboxImage({
        version: '0.2.0',
        platform: 'linux/amd64',
        dockerfileDir: '/pkg/docker',
        run: docker.run,
        build: async () => 1,
      }),
    ).rejects.toThrow(
      'Building the sandbox image agentpicks-sandbox:0.2.0 failed (docker build exit 1)',
    );
  });
});

describe('removeOlderImages', () => {
  it('keeps every tag of the current image', async () => {
    const docker = fakeDocker([
      [
        'image ls',
        {
          stdout:
            'sha256:new agentpicks-sandbox:0.2.0\nsha256:new agentpicks-sandbox:latest\n',
        },
      ],
    ]);
    expect(
      await removeOlderImages('agentpicks-sandbox:0.2.0', docker.run),
    ).toEqual([]);
    expect(docker.calls.some((c) => c[1] === 'rm')).toBe(false);
  });
});

describe('cleanupDocker', () => {
  it('removes every labelled container, then every labelled image', async () => {
    const docker = fakeDocker([
      ['ps', { stdout: 'c1\nc2\n' }],
      ['image ls', { stdout: IMAGES }],
    ]);
    expect(await cleanupDocker(docker.run)).toEqual({
      containers: ['c1', 'c2'],
      images: [
        'agentpicks-sandbox:0.2.0',
        'agentpicks-sandbox:0.1.0',
        'sha256:dangling',
      ],
    });
    expect(docker.calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'ps --all',
      'rm --force',
      'image ls',
      'image rm',
    ]);
    expect(docker.calls[0]).toContain('label=dev.devtune.agentpicks');
  });

  it('does nothing when nothing is labelled', async () => {
    const docker = fakeDocker([]);
    expect(await cleanupDocker(docker.run)).toEqual({
      containers: [],
      images: [],
    });
    expect(docker.calls).toHaveLength(2);
  });
});

describe('removeSessionContainers', () => {
  it('removes only the containers carrying this session’s label', async () => {
    const docker = fakeDocker([['ps', { stdout: 'c3\n' }]]);
    expect(await removeSessionContainers('s-1', docker.run)).toEqual(['c3']);
    expect(docker.calls).toEqual([
      [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        'label=dev.devtune.agentpicks.session=s-1',
      ],
      ['rm', '--force', 'c3'],
    ]);
  });
});

describe('runRequirements', () => {
  it("states a run's needs from the provider's limits", () => {
    expect(runRequirements()).toBe(
      "Each run needs Docker with 2 CPUs, 4 GB of memory and 20 GB free on Docker's disk, and may write up to 15 GB there while it runs.",
    );
  });
});
