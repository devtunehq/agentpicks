/**
 * ABOUTME: Covers the repository variant of the sandbox assets: the frozen install commands per
 * package manager, make-env.sh's shape (valid bash, the baseline committed before anything
 * installs), and that a repository replaces the starter's packed files and nothing else.
 */
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { CATEGORY_REQUESTS } from '../catalogue/categories';
import { findEnvironment } from '../catalogue/environments';
import {
  buildRepositoryMakeEnvScript,
  repositoryInstallScript,
  type RepositoryInstall,
} from './repository-scripts';
import { buildSandboxAssets } from './sandbox-assets';

const NONE: RepositoryInstall = { node: null, python: null, ruby: null };

describe('repositoryInstallScript', () => {
  it.each([
    [{ ...NONE, node: 'npm' }, /^npm ci --no-audit --no-fund /],
    [{ ...NONE, node: 'pnpm' }, /^pnpm install --frozen-lockfile /],
    [
      { ...NONE, node: 'yarn' },
      /corepack yarn install --immutable .*corepack yarn install --frozen-lockfile/,
    ],
    [
      { ...NONE, python: 'uv' },
      /uv==0\.13\.0 .*\npython3 -m uv sync --frozen /,
    ],
    [
      { ...NONE, python: 'pip' },
      /^python3 -m venv \.venv .*\n\.venv\/bin\/pip install .*--require-hashes -r requirements\.txt /,
    ],
    [{ ...NONE, ruby: 'bundler' }, /^BUNDLE_FROZEN=true bundle install /],
  ] as [RepositoryInstall, RegExp][])(
    '%j installs frozen',
    (install, command) => {
      expect(repositoryInstallScript(install)).toMatch(command);
    },
  );

  it('installs nothing for a repository with no package manager', () => {
    expect(repositoryInstallScript(NONE)).toBe('');
  });
});

describe('buildRepositoryMakeEnvScript', () => {
  it.each([
    NONE,
    { node: 'pnpm', python: 'uv', ruby: 'bundler' },
  ] as RepositoryInstall[])('is valid bash for %j', (install) => {
    const r = spawnSync('bash', ['-n'], {
      input: buildRepositoryMakeEnvScript(install),
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('commits the baseline before installing, and installs Ruby only for a Gemfile.lock', () => {
    const script = buildRepositoryMakeEnvScript({ ...NONE, node: 'npm' });
    expect(script.indexOf('git commit -qm baseline')).toBeGreaterThan(
      script.indexOf('unpack /work/app $S/repository.tsv'),
    );
    expect(script.indexOf('git commit -qm baseline')).toBeLessThan(
      script.indexOf('npm ci'),
    );
    // Every committed path is staged, ignored or not, and globs in names stay literal.
    expect(script).toContain(
      'git --literal-pathspecs add -f --pathspec-from-file=- --pathspec-file-nul',
    );
    expect(script).not.toContain('git add -A');
    expect(script).not.toContain('portable-ruby');
    expect(
      buildRepositoryMakeEnvScript({ ...NONE, ruby: 'bundler' }),
    ).toContain('portable-ruby');
  });
});

describe('buildSandboxAssets with a repository', () => {
  it("replaces only make-env.sh and the starter's packed files", () => {
    const environment = findEnvironment('nextjs')!;
    const signals = CATEGORY_REQUESTS[0]!.earlyStop;
    const starter = buildSandboxAssets(environment, { earlyStop: signals });
    const repository = buildSandboxAssets(
      environment,
      { earlyStop: signals },
      undefined,
      { repository: { packed: '644\ta.txt\tYQ==\n', install: NONE } },
    );
    const byPath = (assets: typeof starter) =>
      new Map(assets.map((a) => [a.path, a.content]));
    const [before, after] = [byPath(starter), byPath(repository)];
    expect([...after.keys()].filter((p) => !before.has(p))).toEqual([
      '/opt/agent-picks/repository.tsv',
    ]);
    expect([...before.keys()].filter((p) => !after.has(p))).toEqual([
      '/opt/agent-picks/starter.tsv',
      '/opt/agent-picks/starter-locks.tsv',
    ]);
    for (const [path, content] of before)
      if (after.has(path) && path !== '/opt/agent-picks/make-env.sh')
        expect(after.get(path)).toBe(content);
    expect(after.get('/opt/agent-picks/make-env.sh')).toBe(
      buildRepositoryMakeEnvScript(NONE),
    );
  });
});
