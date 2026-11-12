/**
 * ABOUTME: Sets up a small fixture repository with a committed npm lockfile in a real Docker
 * sandbox, through the same setup.sh a run uses: its commit is laid down, committed as the
 * baseline with the commit's exact tree (a force-added ignored file and CRLF bytes included), installed frozen, and nothing of the host's `.git` comes
 * with it. Skips, printing why, when `docker info` fails. Run it with `pnpm test:integration`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATEGORY_REQUESTS } from '../catalogue/categories';
import { SETUP_TIMEOUT_SEC } from '../run/limits';
import { setupCommand, uploadRunInputs } from '../run/sandbox-run';
import {
  DOCKER_SANDBOX_IMAGE,
  DockerSandboxProvider,
  type DockerSandbox,
} from '../sandbox/docker';
import {
  CUSTOMER_REPOSITORY_ENVIRONMENT,
  readRepository,
  type RepositorySnapshot,
} from './repository';

const DOCKERFILE_DIR = resolve(__dirname, '../../docker');

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'fixture',
    version: '1.0.0',
    private: true,
    dependencies: { 'is-number': '7.0.0' },
  },
  null,
  2,
)}\n`;

const PACKAGE_LOCK = `${JSON.stringify(
  {
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'fixture',
        version: '1.0.0',
        dependencies: { 'is-number': '7.0.0' },
      },
      'node_modules/is-number': {
        version: '7.0.0',
        resolved: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
        integrity:
          'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
        license: 'MIT',
        engines: { node: '>=0.12.0' },
      },
    },
  },
  null,
  2,
)}\n`;

function dockerUnavailable(): string | null {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (r.error) return r.error.message;
  if (r.status !== 0)
    return r.stderr.trim().split('\n')[0] ?? `exit ${r.status}`;
  return null;
}

const skipReason = dockerUnavailable();
if (skipReason) {
  process.stderr.write(
    `Skipping the repository setup integration spec: docker info failed (${skipReason})\n`,
  );
}

describe.skipIf(skipReason !== null)(
  'a repository run’s setup in Docker',
  () => {
    let dir: string;
    let repo: RepositorySnapshot;
    let box: DockerSandbox;
    let setup: { exitCode: number; stdout: string; stderr: string };
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Dev',
          GIT_AUTHOR_EMAIL: 'dev@example.com',
          GIT_COMMITTER_NAME: 'Dev',
          GIT_COMMITTER_EMAIL: 'dev@example.com',
        },
      });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const inBox = async (command: string) => {
      const r = await box.exec(command);
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      return r.stdout.trim();
    };

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'agentpicks-repo-fixture-'));
      git('init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'package.json'), PACKAGE_JSON);
      writeFileSync(join(dir, 'package-lock.json'), PACKAGE_LOCK);
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n');
      // A committed file its own .gitignore matches, force-added: the baseline must hold it.
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist/keep.js'), 'module.exports = 2;\n');
      writeFileSync(join(dir, 'index.js'), 'module.exports = 1;\n');
      // A blob with CRLF endings under a text attribute: an add in the container would
      // normalise it unless the baseline keeps the commit's bytes.
      writeFileSync(join(dir, 'notes.txt'), 'one\r\ntwo\r\n');
      git('add', '-A');
      git('add', '-f', 'dist/keep.js');
      git('commit', '-qm', 'first');
      writeFileSync(join(dir, '.gitattributes'), '* text=auto\n');
      git('add', '.gitattributes');
      git('commit', '-qm', 'attributes');
      git('remote', 'add', 'origin', 'https://dev:tok@example.com/fixture.git');
      writeFileSync(join(dir, '.git/hooks/post-commit'), '#!/bin/sh\nexit 1\n');

      repo = readRepository(dir);
      expect(repo.install).toEqual({ node: 'npm', python: null, ruby: null });

      const build = spawnSync(
        'docker',
        ['build', '--tag', DOCKER_SANDBOX_IMAGE, DOCKERFILE_DIR],
        { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
      );
      expect(build.status).toBe(0);
      box = await new DockerSandboxProvider().create({ timeoutMin: 30 });
      const job = {
        environment: CUSTOMER_REPOSITORY_ENVIRONMENT,
        agent: 'claude_code' as const,
        signals: { earlyStop: CATEGORY_REQUESTS[0]!.earlyStop },
        repository: { packed: repo.packed, install: repo.install },
      };
      await uploadRunInputs(box, job, 'Add error tracking.');
      setup = await box.exec(setupCommand(job), {
        timeoutSec: SETUP_TIMEOUT_SEC,
      });
    }, 20 * 60_000);

    afterAll(async () => {
      await box?.destroy();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('finishes setup', () => {
      expect(setup.stdout + setup.stderr).toContain('"projectSec"');
      expect(setup.exitCode).toBe(0);
    });

    it('commits the baseline as exactly the tested commit’s tree, in one commit', async () => {
      expect(await inBox('git -C /work/app rev-parse "HEAD^{tree}"')).toBe(
        git('rev-parse', `${repo.commit}^{tree}`),
      );
      expect(await inBox('git -C /work/app rev-list --count HEAD')).toBe('1');
      expect(await inBox('git -C /work/app status --porcelain')).toBe('');
      expect(await inBox('git -C /work/app ls-files dist')).toBe(
        'dist/keep.js',
      );
    });

    it('installs the dependencies frozen from the committed lockfile', async () => {
      expect(
        JSON.parse(
          await inBox('cat /work/app/node_modules/is-number/package.json'),
        ).version,
      ).toBe('7.0.0');
    });

    it('brings none of the host’s .git: no remote, no hooks', async () => {
      expect(await inBox('git -C /work/app remote')).toBe('');
      expect(
        await inBox(
          'find /work/app/.git/hooks -type f ! -name "*.sample" | wc -l',
        ),
      ).toBe('0');
    });

    it('records the shared environment', async () => {
      expect(
        JSON.parse(await inBox('cat /opt/agent-picks/out/env.json')),
      ).toMatchObject({ env: 'customer_repository', stripped: false });
    });
  },
);
