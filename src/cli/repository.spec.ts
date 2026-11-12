/**
 * ABOUTME: Covers reading the customer's repository for `--repo` against real git repositories in
 * a temp directory: each repository state (clean, uncommitted, `--ref`, unknown commit, no
 * commit, not a repository, submodules), that the repository read is the one at the path whatever
 * its config or the inherited environment names, a partial clone never fetched, a replaced commit
 * read as itself, what the copy carries, that a hostile repository's
 * config runs nothing and fetches nothing, the remote's reduction to host and path, and the
 * package managers a repository installs with or is refused for.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isHostAndPath } from '../bundle/schema';
import { parsePackedEntries } from '../locks/locked-files';
import {
  GemfilePlatformsError,
  MissingObjectsError,
  NotARepositoryError,
  SubmodulesError,
  UnhashedRequirementsError,
  UnknownCommitError,
  UnsupportedGitError,
  UnsupportedPackageManagerError,
} from './errors';
import {
  checkGemfilePlatforms,
  checkHashedRequirements,
  detectInstall,
  hostGitEnv,
  readRepository,
  sanitizeRemoteUrl,
} from './repository';

/** Git older than 2.45 refuses a partial clone before reading it, so never reaches its missing objects. */
const [gitMajor = 0, gitMinor = 0] = (
  /(\d+)\.(\d+)/.exec(
    spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout,
  ) ?? []
)
  .slice(1)
  .map(Number);
const PARTIAL_CLONE_REFUSAL =
  gitMajor > 2 || (gitMajor === 2 && gitMinor >= 45)
    ? MissingObjectsError
    : UnsupportedGitError;

let dir: string;
beforeEach(() => {
  // The developer's own git config (signing, excludes) stays out of these repositories.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  dir = mkdtempSync(join(tmpdir(), 'agentpicks-repo-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(path: string, content: string) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** A repository with one commit: an app with a committed lockfile, ignoring node_modules. */
function committedRepo(): string {
  git('init', '-q', '-b', 'main');
  write('package.json', '{"name":"app","private":true}\n');
  write('package-lock.json', '{"lockfileVersion":3}\n');
  write('.gitignore', 'node_modules/\n.env\n');
  write('src/index.js', 'console.log("hi")\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return git('rev-parse', 'HEAD');
}

describe('readRepository', () => {
  it('tests HEAD of a clean repository, copying its committed files and nothing ignored', () => {
    const head = committedRepo();
    write('node_modules/x/index.js', 'ignored');
    write('.env', 'SECRET=1');

    const repo = readRepository(join(dir, 'src'));
    expect(repo.commit).toBe(head);
    expect(repo.root).toBe(join(dir, 'src'));
    expect(repo.gitDir).toBe(git('rev-parse', '--absolute-git-dir'));
    expect(repo.remoteUrl).toBeNull();
    expect(repo.install).toEqual({ node: 'npm', python: null, ruby: null });
    expect(
      parsePackedEntries(repo.packed)
        .map((e) => e.path)
        .sort(),
    ).toEqual([
      '.gitignore',
      'package-lock.json',
      'package.json',
      'src/index.js',
    ]);
  });

  it('tests HEAD as committed whatever the working tree holds: changed, staged and untracked files are left out', () => {
    const head = committedRepo();
    write('src/index.js', 'changed\n');
    write('README.md', 'staged\n');
    git('add', 'README.md');
    write('notes/draft.md', 'untracked\n');

    const repo = readRepository(dir);
    expect(repo.commit).toBe(head);
    const entries = parsePackedEntries(repo.packed);
    expect(entries.find((e) => e.path === 'src/index.js')).toMatchObject({
      text: 'console.log("hi")\n',
    });
    expect(entries.map((e) => e.path)).not.toContain('README.md');
    expect(entries.map((e) => e.path)).not.toContain('notes/draft.md');
  });

  it('tests the --ref commit whatever the working tree holds, from the commit and not the disk', () => {
    const first = committedRepo();
    write('src/index.js', 'second version\n');
    git('commit', '-qam', 'second');
    write('src/index.js', 'uncommitted');
    write('scratch.txt', 'untracked');

    const repo = readRepository(dir, first);
    expect(repo.commit).toBe(first);
    const index = parsePackedEntries(repo.packed).find(
      (e) => e.path === 'src/index.js',
    );
    expect(index).toMatchObject({ text: 'console.log("hi")\n' });
    // A branch or tag resolves to its commit.
    git('tag', 'v1', first);
    expect(readRepository(dir, 'v1').commit).toBe(first);
  });

  it('refuses a --ref that starts with a dash, which git would read as an option', () => {
    committedRepo();
    expect(() => readRepository(dir, '--output=x')).toThrow(UnknownCommitError);
  });

  it('refuses a --ref that names no commit', () => {
    committedRepo();
    expect(() => readRepository(dir, 'no-such-ref')).toThrow(
      new UnknownCommitError(
        `There is no commit no-such-ref in ${git('rev-parse', '--show-toplevel')}.`,
      ),
    );
    // A tree is not a commit.
    expect(() => readRepository(dir, 'HEAD^{tree}')).toThrow(
      UnknownCommitError,
    );
  });

  it('refuses a repository with no commit yet', () => {
    git('init', '-q');
    expect(() => readRepository(dir)).toThrow(UnknownCommitError);
    expect(() => readRepository(dir)).toThrow(/has no commit yet/);
  });

  it('tests a detached HEAD that has a commit', () => {
    const head = committedRepo();
    git('checkout', '-q', '--detach');
    expect(readRepository(dir).commit).toBe(head);
  });

  it('refuses a path that is not in a git repository', () => {
    expect(() => readRepository(dir)).toThrow(NotARepositoryError);
    expect(() => readRepository(join(dir, 'missing'))).toThrow(
      /is not in a git repository/,
    );
  });

  it('refuses an unsupported package manager before reading any file', () => {
    committedRepo();
    write('go.mod', 'module x\n');
    git('add', '-A');
    git('commit', '-qm', 'go');
    expect(() => readRepository(dir)).toThrow(UnsupportedPackageManagerError);
  });

  it('carries executables and symlinks, and leaves .git out', () => {
    committedRepo();
    write('bin/run.sh', '#!/bin/sh\n');
    spawnSync('chmod', ['755', join(dir, 'bin/run.sh')]);
    symlinkSync('src/index.js', join(dir, 'main.js'));
    git('add', '-A');
    git('commit', '-qm', 'more');

    const entries = parsePackedEntries(readRepository(dir).packed);
    expect(entries.find((e) => e.path === 'bin/run.sh')).toMatchObject({
      kind: 'file',
      executable: true,
    });
    expect(entries.find((e) => e.path === 'main.js')).toEqual({
      path: 'main.js',
      kind: 'link',
      target: 'src/index.js',
    });
    expect(entries.some((e) => e.path.startsWith('.git/'))).toBe(false);
  });

  it('refuses a commit with a file name that isn’t UTF-8, rather than renaming it', () => {
    committedRepo();
    writeFileSync(
      Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x66, 0xff])]),
      'x\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'latin-1 name');
    expect(() => readRepository(dir)).toThrow(/whose name isn't UTF-8/);
  });

  it('refuses a symlink whose target isn’t UTF-8, rather than rewriting it', () => {
    committedRepo();
    symlinkSync(
      Buffer.concat([Buffer.from('f'), Buffer.from([0xff])]),
      join(dir, 'link'),
    );
    git('add', '-A');
    git('commit', '-qm', 'latin-1 target');
    expect(() => readRepository(dir)).toThrow(
      /link is a symlink whose target isn't UTF-8/,
    );
  });

  it.each(['requirements.txt', 'Gemfile.lock'])(
    'refuses a %s committed as a symlink, which it cannot check',
    (name) => {
      git('init', '-q', '-b', 'main');
      write(name === 'Gemfile.lock' ? 'Gemfile' : 'app.py', 'x\n');
      write('locks/real', 'x\n');
      symlinkSync('locks/real', join(dir, name));
      git('add', '-A');
      git('commit', '-qm', 'linked lock');
      expect(() => readRepository(dir)).toThrow(
        new RegExp(`${name.replace('.', '\\.')} is a symlink`),
      );
    },
  );

  it('refuses a commit with submodules, naming them, with or without --ref', () => {
    committedRepo();
    git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'1'.repeat(40)},vendor/lib`,
    );
    git('commit', '-qm', 'submodule');
    // An uninitialised submodule leaves an empty directory.
    mkdirSync(join(dir, 'vendor/lib'), { recursive: true });
    expect(() => readRepository(dir)).toThrow(SubmodulesError);
    expect(() => readRepository(dir, 'main')).toThrow(
      /has submodules \(vendor\/lib\), and a commit holds only their commit ids/,
    );
  });

  it('reads the repository at the path, not the work tree its config names', () => {
    const other = mkdtempSync(join(tmpdir(), 'agentpicks-other-'));
    try {
      const seed = dir;
      dir = other;
      committedRepo();
      write('other.txt', 'other\n');
      git('add', '-A');
      git('commit', '-qm', 'other');
      const otherHead = git('rev-parse', 'HEAD');
      dir = seed;
      const head = committedRepo();
      git('config', 'core.worktree', other);

      for (const ref of [undefined, 'HEAD']) {
        const repo = readRepository(dir, ref);
        expect(repo.commit).toBe(head);
        expect(repo.commit).not.toBe(otherHead);
        expect(
          parsePackedEntries(repo.packed).map((e) => e.path),
        ).not.toContain('other.txt');
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('ignores GIT_DIR, GIT_WORK_TREE, GIT_CONFIG and the rest of git’s variables in its own environment', () => {
    const other = mkdtempSync(join(tmpdir(), 'agentpicks-other-'));
    try {
      const seed = dir;
      dir = other;
      committedRepo();
      git('remote', 'add', 'origin', 'https://other.example/other.git');
      dir = seed;
      const head = committedRepo();
      writeFileSync(join(other, 'config'), '[protocol]\n\tallow = always\n');
      vi.stubEnv('GIT_DIR', join(other, '.git'));
      vi.stubEnv('GIT_WORK_TREE', other);
      vi.stubEnv('GIT_CONFIG', join(other, 'config'));
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'protocol.allow');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'always');
      vi.stubEnv('GIT_INDEX_FILE', join(other, '.git/index'));
      vi.stubEnv('GIT_OBJECT_DIRECTORY', join(other, '.git/objects'));

      const repo = readRepository(dir);
      expect(repo.commit).toBe(head);
      expect(repo.gitDir).toBe(join(dir, '.git'));
      expect(repo.remoteUrl).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("records origin's host and path alone", () => {
    committedRepo();
    git('remote', 'add', 'upstream', 'https://example.com/upstream.git');
    git(
      'remote',
      'add',
      'origin',
      'https::https://ben:ghp_secrettoken123@github.com/acme/app.git?x=1',
    );
    expect(readRepository(dir).remoteUrl).toBe(
      'https://github.com/acme/app.git',
    );
  });

  it('refuses a requirements.txt that is not pinned and hashed throughout', () => {
    committedRepo();
    write('requirements.txt', 'fastapi==0.115.0\n');
    git('add', '-A');
    git('commit', '-qm', 'python');
    expect(() => readRepository(dir)).toThrow(UnhashedRequirementsError);
  });
});

describe('readRepository against a hostile repository', () => {
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'agentpicks-hostile-'));
  });
  afterEach(() => rmSync(outside, { recursive: true, force: true }));

  /** An executable that leaves `name` in `outside` when anything runs it, then fails. */
  function trap(name: string): string {
    const path = join(outside, `${name}.sh`);
    writeFileSync(path, `#!/bin/sh\ntouch '${join(outside, name)}'\nexit 1\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const sprung = () =>
    readdirSync(outside).filter(
      (f) => !f.endsWith('.sh') && !['src', 'hooks', 'bin', 'home'].includes(f),
    );

  it('runs no fsmonitor, hook or filter driver its config names', () => {
    committedRepo();
    write(
      '.gitattributes',
      '*.js filter=clean-trap\n*.json filter=process-trap\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'attributes');
    git('config', 'core.fsmonitor', trap('fsmonitor'));
    git('config', 'filter.clean-trap.clean', `${trap('clean')}; cat`);
    git('config', 'filter.process-trap.process', trap('process'));
    git('config', 'core.hooksPath', join(outside, 'hooks'));
    mkdirSync(join(outside, 'hooks'));
    copyFileSync(trap('hook'), join(outside, 'hooks/post-index-change'));
    chmodSync(join(outside, 'hooks/post-index-change'), 0o755);
    // Changed timestamps make status read the files again, through their filters.
    const old = new Date('2001-01-01');
    for (const f of ['src/index.js', 'package.json'])
      utimesSync(join(dir, f), old, old);

    expect(readRepository(dir).commit).toBe(git('rev-parse', 'HEAD'));
    expect(readRepository(dir, 'main').commit).toBe(git('rev-parse', 'HEAD'));
    expect(sprung()).toEqual([]);

    // The same status without the overrides runs every one of them.
    spawnSync('git', ['-C', dir, 'status', '--porcelain']);
    expect(sprung().sort()).toEqual(['clean', 'fsmonitor', 'hook', 'process']);
  });

  /**
   * Makes `dir` a real partial clone missing its blobs, whose promisor remote is an ssh address
   * its own config allows and whose ssh command is a trap.
   */
  function hostilePartialClone() {
    const src = join(outside, 'src');
    mkdirSync(src);
    const seed = dir;
    dir = src;
    committedRepo();
    git('config', 'uploadpack.allowFilter', 'true');
    dir = seed;
    git(
      'clone',
      '-q',
      '--filter=blob:none',
      '--no-checkout',
      `file://${src}`,
      '.',
    );
    git('remote', 'set-url', 'origin', 'ssh://example.invalid/app.git');
    git('config', 'protocol.ssh.allow', 'always');
    git('config', 'core.sshCommand', trap('ssh'));
  }

  it('never fetches a partial clone’s missing objects, even through its ssh command, and refuses it', () => {
    hostilePartialClone();

    expect(() => readRepository(dir, 'main')).toThrow(PARTIAL_CLONE_REFUSAL);
    expect(() => readRepository(dir)).toThrow(PARTIAL_CLONE_REFUSAL);
    expect(sprung()).toEqual([]);

    // git on its own fetches the missing blob through the ssh command.
    spawnSync('git', ['-C', dir, 'cat-file', '-p', 'main:package.json']);
    expect(sprung()).toEqual(['ssh']);
  });

  it('allows no transport even where git would fetch lazily and the repository allows ssh', () => {
    hostilePartialClone();
    // As a git that ignores GIT_NO_LAZY_FETCH runs it: GIT_ALLOW_PROTOCOL alone stops the fetch.
    const { GIT_NO_LAZY_FETCH: _ignored, ...env } = hostGitEnv();
    const r = spawnSync(
      'git',
      ['--git-dir', join(dir, '.git'), 'cat-file', '-p', 'main:package.json'],
      { env, encoding: 'utf8' },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("transport 'ssh' not allowed");
    expect(sprung()).toEqual([]);
  });

  it('records a replaced commit’s own id and its own files, never the replacement’s', () => {
    const head = committedRepo();
    git('checkout', '-q', '-b', 'other');
    write('src/index.js', 'replacement\n');
    git('commit', '-qam', 'replacement');
    const replacement = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    git('replace', head, replacement);
    // git on its own now shows the replacement's files under the commit's id.
    expect(git('show', `${head}:src/index.js`)).toBe('replacement');

    for (const ref of [undefined, head]) {
      const repo = readRepository(dir, ref);
      expect(repo.commit).toBe(head);
      expect(
        parsePackedEntries(repo.packed).find((e) => e.path === 'src/index.js'),
      ).toMatchObject({ text: 'console.log("hi")\n' });
    }
  });
});

describe('sanitizeRemoteUrl', () => {
  it.each([
    [
      'https://user:ghp_token123@github.com/acme/app.git',
      'https://github.com/acme/app.git',
    ],
    [
      'https://x-access-token:tok@github.com/acme/app',
      'https://github.com/acme/app',
    ],
    [
      'https://token@gitlab.com:8443/acme/app.git',
      'https://gitlab.com:8443/acme/app.git',
    ],
    [
      'https://github.com/acme/app.git?private_token=abc#frag',
      'https://github.com/acme/app.git',
    ],
    ['HTTPS://github.com/acme/app.git', 'https://github.com/acme/app.git'],
    ['ssh://git@github.com/acme/app.git', 'ssh://github.com/acme/app.git'],
    ['git@github.com:acme/app.git', 'github.com:acme/app.git'],
    ['user:pass@host.example:acme/app.git', 'host.example:acme/app.git'],
    [
      'https::https://user:SECRET@host.example/repo',
      'https://host.example/repo',
    ],
    [
      'persistent-https::https://user:SECRET@host.example/repo?t=1',
      'https://host.example/repo',
    ],
    ['https://github.com/acme/app.git', 'https://github.com/acme/app.git'],
  ])('%s → %s', (url, sanitized) => {
    expect(sanitizeRemoteUrl(url)).toBe(sanitized);
    expect(isHostAndPath(sanitized)).toBe(true);
  });

  it.each([
    // Local paths and drives.
    '/srv/git/app.git',
    './app',
    'C:/repos/app',
    'file:///srv/git/app.git',
    // A command, not an address.
    "ext::ssh -i key host.example %S 'app'",
    // A password with a slash in it, which would leave part of it in the path.
    'https://user:pa/ss@host.example/app',
    'https://user:12345/ss@host.example/app',
    'user:pa/ss@host.example:app',
    'https://user:pa\\ss@host.example/app',
    'https://ho st/app',
    'https://[::1]/app',
    // A `::` left in the path, which the bundle manifest refuses.
    'https://host.example/a::b',
    'host.example:a::b',
    '',
  ])('reads %j as no address', (url) => {
    expect(sanitizeRemoteUrl(url)).toBeNull();
  });
});

describe('isHostAndPath', () => {
  it.each([
    'https://user@host.example/app',
    'https://user:tok@host.example/app',
    'user@host.example:app',
    'https://host.example/app?token=1',
    'https://host.example/app#x',
    'https::https://host.example/app',
  ])('rejects %j', (url) => {
    expect(isHostAndPath(url)).toBe(false);
  });
});

describe('checkHashedRequirements', () => {
  const HASH = `--hash=sha256:${'a'.repeat(64)}`;
  it('accepts pins with hashes, markers, extras, continuations and comments', () => {
    expect(() =>
      checkHashedRequirements(
        [
          '# generated',
          `fastapi==0.115.0 \\`,
          `    ${HASH} \\`,
          `    --hash=sha256:${'b'.repeat(64)}`,
          `uvicorn[standard]==0.30.1 ; python_version >= "3.9" ${HASH}`,
          '',
        ].join('\n'),
      ),
    ).not.toThrow();
  });

  it.each([
    ['fastapi==0.115.0'],
    [`fastapi>=0.115 ${HASH}`],
    [`fastapi==0.* ${HASH}`],
    [`-r other.txt`],
    [`-e . ${HASH}`],
    [`--index-url https://pypi.example/simple`],
    [`app @ https://example.com/app.whl ${HASH}`],
  ])('refuses %j', (line) => {
    expect(() => checkHashedRequirements(`${line}\n`)).toThrow(
      UnhashedRequirementsError,
    );
    expect(() => checkHashedRequirements(`${line}\n`)).toThrow(
      /Commit a uv\.lock, or a hashed requirements file/,
    );
  });
});

describe('detectInstall', () => {
  it.each([
    [['README.md'], { node: null, python: null, ruby: null }],
    [
      ['package.json', 'package-lock.json'],
      { node: 'npm', python: null, ruby: null },
    ],
    [
      ['package.json', 'pnpm-lock.yaml'],
      { node: 'pnpm', python: null, ruby: null },
    ],
    [['package.json', 'yarn.lock'], { node: 'yarn', python: null, ruby: null }],
    [['pyproject.toml', 'uv.lock'], { node: null, python: 'uv', ruby: null }],
    [['requirements.txt'], { node: null, python: 'pip', ruby: null }],
    [
      ['Gemfile', 'Gemfile.lock'],
      { node: null, python: null, ruby: 'bundler' },
    ],
    [
      ['package.json', 'pnpm-lock.yaml', 'requirements.txt', 'web/go.mod'],
      { node: 'pnpm', python: 'pip', ruby: null },
    ],
  ])('%j installs with %j', (paths, install) => {
    expect(detectInstall(paths)).toEqual(install);
  });

  it.each([
    [
      ['package.json', 'bun.lock'],
      /uses Bun \(bun\.lock\), which agentpicks can't install/,
    ],
    [['pyproject.toml', 'poetry.lock'], /uses Poetry/],
    [['go.mod'], /uses Go modules/],
    [['Cargo.toml', 'Cargo.lock'], /uses Cargo/],
    [
      ['package.json'],
      /has package\.json but no package-lock\.json, .*Commit its lockfile/,
    ],
    [
      ['pyproject.toml'],
      /has pyproject\.toml but no uv\.lock or requirements\.txt/,
    ],
    [['Gemfile'], /has Gemfile but no Gemfile\.lock/],
    [
      ['package.json', 'package-lock.json', 'yarn.lock'],
      /several Node lockfiles \(package-lock\.json, yarn\.lock\)/,
    ],
  ])('refuses %j', (paths, message) => {
    expect(() => detectInstall(paths)).toThrow(UnsupportedPackageManagerError);
    expect(() => detectInstall(paths)).toThrow(message);
  });
});

describe('checkGemfilePlatforms', () => {
  const lock = (platforms: string[]) =>
    `GEM\n  remote: https://rubygems.org/\n  specs:\n    nokogiri (1.16.0-arm64-darwin)\n\nPLATFORMS\n${platforms.map((p) => `  ${p}\n`).join('')}\nDEPENDENCIES\n  nokogiri\n`;

  it.each([
    [['arm64-darwin-23', 'x86_64-linux']],
    [['ruby']],
    [['x86_64-linux-gnu']],
  ])('installs a lockfile for %j', (platforms) => {
    expect(() => checkGemfilePlatforms(lock(platforms))).not.toThrow();
  });

  it('refuses a lockfile written for macOS alone, naming its platforms and the fix', () => {
    expect(() => checkGemfilePlatforms(lock(['arm64-darwin-23']))).toThrow(
      GemfilePlatformsError,
    );
    expect(() => checkGemfilePlatforms(lock(['arm64-darwin-23']))).toThrow(
      /only arm64-darwin-23.*bundle lock --add-platform x86_64-linux/,
    );
  });

  it('reads CRLF line endings', () => {
    expect(() =>
      checkGemfilePlatforms(lock(['x86_64-linux']).replace(/\n/g, '\r\n')),
    ).not.toThrow();
  });
});
