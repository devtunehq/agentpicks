/**
 * ABOUTME: Reads the customer's repository for `agentpicks run --repo`: the commit to test (HEAD,
 * or `--ref`), its committed files from git's object store and never the working tree or `.git`,
 * its remote address reduced to host and path, and how it installs. Uncommitted changes are
 * never read, so the recorded commit is what is tested. Git runs against one git directory found
 * once, in an environment built from an allowlist, and never fetches. Every refusal is named and
 * comes before any container starts.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { basename, resolve } from 'node:path';

import {
  CUSTOMER_REPOSITORY_SLUG,
  type RepositoryInstall,
  type SandboxRepository,
} from '../assets/repository-scripts';
import { isHostAndPath } from '../bundle/schema';
import type { EnvironmentDefinition } from '../catalogue/environments';
import { packEntries, type LockedEntry } from '../locks/locked-files';
import {
  MissingObjectsError,
  NotARepositoryError,
  RepositoryContentError,
  SubmodulesError,
  GemfilePlatformsError,
  UnhashedRequirementsError,
  UnknownCommitError,
  UnsupportedGitError,
  UnsupportedPackageManagerError,
} from './errors';

/** The environment a repository run reports: the shared catalogue row, with no prompt prefix. */
export const CUSTOMER_REPOSITORY_ENVIRONMENT: EnvironmentDefinition = {
  slug: CUSTOMER_REPOSITORY_SLUG,
  name: 'Your repository',
  framework: 'unknown',
  starterRef: '',
  projectState: 'starter',
  notes: "The customer's own repository at one commit.",
  starter: 'empty',
  baselinePackages: [],
};

/** The most committed content a run copies into the container. */
export const REPOSITORY_MAX_BYTES = 200 * 1024 * 1024;

type Git = (args: string[], input?: string) => SpawnSyncReturns<Buffer>;

/** Inherited variables a host git call keeps; every other one, every `GIT_*` included, is dropped. */
export const GIT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
];

/**
 * The environment of every host git call: the allowlisted variables, and settings that keep a
 * read a read. `GIT_ALLOW_PROTOCOL` names no real transport, and while it is set git consults it
 * alone (`is_transport_allowed` in transport.c; read in 2.12, 2.43 and master), above any
 * `protocol.*` config, so a partial clone's lazy fetch can't use ssh, http or file. It still allows a remote helper named
 * `none` (`remote.<name>.vcs`, which an alias `remote-none` can satisfy), so it doesn't contain an
 * old git alone: `GIT_NO_LAZY_FETCH` stops the fetch from 2.45, and before that
 * `refusePartialCloneOnOldGit` refuses a partial clone before any read. Replace objects are off, so
 * a commit's id and its content always agree, and the system config isn't read.
 */
export function hostGitEnv(
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GIT_ENV_ALLOWLIST) {
    const value = inherited[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: 'none',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export interface RepositorySnapshot extends SandboxRepository {
  /** The path `--repo` named, made absolute. */
  root: string;
  /** The git directory every read used. */
  gitDir: string;
  /** The full commit id tested. */
  commit: string;
  /** The `origin` remote (or the first remote) as host and path; null with none or one not read with confidence. */
  remoteUrl: string | null;
  files: number;
  bytes: number;
}

/**
 * The repository containing `path` at `ref` (a commit, tag or branch), or at HEAD. Only committed
 * content is read, so the working tree's state doesn't matter.
 */
export function readRepository(path: string, ref?: string): RepositorySnapshot {
  const root = resolve(path);
  const gitDir = findGitDir(root);
  const git = hostGit(gitDir);
  refusePartialCloneOnOldGit(git, root);
  const commit = resolveCommit(git, root, ref);
  const tree = readTree(git, commit);
  const install = detectInstall(tree.map((e) => e.path));
  const blobs = readBlobs(git, root, commit, tree);
  // A manifest read here must be the file itself: a symlink's blob is only its target's path.
  const rootFile = (name: string): string => {
    const entry = tree.find((e) => e.path === name)!;
    if (entry.kind === 'link')
      throw new RepositoryContentError(
        `${name} is a symlink, which agentpicks can't check before the run. Commit ${name} itself to test this repository.`,
      );
    return blobs.get(entry.oid)!.toString('utf8');
  };
  if (install.python === 'pip')
    checkHashedRequirements(rootFile('requirements.txt'));
  if (install.ruby) checkGemfilePlatforms(rootFile('Gemfile.lock'));
  const entries = tree.map(
    (entry): LockedEntry =>
      entry.kind === 'link'
        ? {
            path: entry.path,
            kind: 'link',
            target: utf8(
              blobs.get(entry.oid)!,
              `${entry.path} is a symlink whose target isn't UTF-8`,
            ),
          }
        : {
            path: entry.path,
            kind: 'file',
            executable: entry.kind === 'executable',
            base64: blobs.get(entry.oid)!.toString('base64'),
          },
  );
  return {
    root,
    gitDir,
    commit,
    remoteUrl: readRemoteUrl(git),
    files: entries.length,
    bytes: tree.reduce((sum, e) => sum + e.size, 0),
    packed: packEntries(entries),
    install,
  };
}

/** Runs git with `hostGitEnv` and the given leading arguments; output as bytes. */
function runGit(cwd: string, lead: string[]): Git {
  const env = hostGitEnv();
  return (args, input) => {
    const r = spawnSync('git', ['--no-pager', ...lead, ...args], {
      cwd,
      input,
      env,
      maxBuffer: REPOSITORY_MAX_BYTES * 2,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.error)
      throw new UnsupportedGitError(
        `--repo needs git on this machine: running it failed (${r.error.message}).`,
      );
    return r;
  };
}

/** The git directory of the repository containing `root`, found once; refuses a path in no repository. */
function findGitDir(root: string): string {
  const r = runGit('/', ['-C', root])(['rev-parse', '--absolute-git-dir']);
  if (r.status !== 0)
    throw new NotARepositoryError(
      `${root} is not in a git repository (${r.stderr.toString().trim().split('\n')[0]}). Pass --repo the path to a git checkout.`,
    );
  return r.stdout.toString().trim();
}

/**
 * Runs git against `gitDir` alone, never discovering a repository again, so neither a work tree
 * setting nor an inherited variable can point a later call at another one. Every read goes
 * through it.
 */
export function hostGit(gitDir: string): Git {
  return runGit(gitDir, [`--git-dir=${gitDir}`]);
}

/** The first git that honours `GIT_NO_LAZY_FETCH` in every build. */
const MIN_GIT_PARTIAL_CLONE: [number, number] = [2, 45];

/** The host git's major and minor version; null when `git --version` can't be read. */
function gitVersion(): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(
    runGit('/', [])(['--version']).stdout.toString(),
  );
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The keys that make a repository a partial clone: `promisor_remote_config()` registers a promisor
 * from `remote.<name>.promisor` and `remote.<name>.partialclonefilter` (read at 2.31, 2.43, 2.44
 * and 2.45), and repository setup from `extensions.partialclone`. `--name-only` prints section and
 * key lowercased and the subsection as written.
 */
const PARTIAL_CLONE_KEYS =
  '^extensions\\.partialclone$|^remote\\..*\\.(promisor|partialclonefilter)$';

/**
 * Refuses a partial clone before any object is read, on a git older than 2.45 or of unknown
 * version. Such a git may ignore `GIT_NO_LAZY_FETCH`, and its lazy fetch runs a remote helper by
 * name, through `remote.<name>.vcs`, an `insteadOf` rewrite or an alias, which no
 * `GIT_ALLOW_PROTOCOL` value can rule out. Reads the effective config, includes and the user's
 * global config with it, as the fetch would; a config git can't read is refused too.
 */
function refusePartialCloneOnOldGit(git: Git, root: string): void {
  const version = gitVersion();
  if (
    version &&
    (version[0] > MIN_GIT_PARTIAL_CLONE[0] ||
      (version[0] === MIN_GIT_PARTIAL_CLONE[0] &&
        version[1] >= MIN_GIT_PARTIAL_CLONE[1]))
  )
    return;
  const r = git(['config', '--name-only', '--get-regexp', PARTIAL_CLONE_KEYS]);
  const keys = r.stdout.toString().trim();
  if (r.status === 1 && !keys) return;
  const has = version?.join('.') ?? 'a version it could not read';
  throw new UnsupportedGitError(
    r.status === 0
      ? `${root} is a partial clone (${keys.split('\n').join(', ')}), and reading one without fetching needs git ${MIN_GIT_PARTIAL_CLONE.join('.')} or later; this machine has ${has}. Update git, or test a full clone.`
      : `Reading the git config of ${root} failed (${r.stderr.toString().trim().split('\n')[0]}), and on git older than ${MIN_GIT_PARTIAL_CLONE.join('.')} (this machine has ${has}) agentpicks reads a repository only after confirming it isn't a partial clone. Fix the config, then run again.`,
  );
}

function resolveCommit(
  git: Git,
  root: string,
  ref: string | undefined,
): string {
  // A ref can't start with a dash, so rev-parse never reads one as an option.
  const r = ref?.startsWith('-')
    ? null
    : git(['rev-parse', '--verify', '--quiet', `${ref ?? 'HEAD'}^{commit}`]);
  if (r?.status === 0) return r.stdout.toString().trim();
  throw new UnknownCommitError(
    ref === undefined
      ? `${root} has no commit yet. Commit what you want tested, or pass --ref <commit>.`
      : `There is no commit ${ref} in ${root}.`,
  );
}

interface TreeEntry {
  path: string;
  kind: 'file' | 'executable' | 'link';
  oid: string;
  size: number;
}

const TREE_KINDS: Record<string, TreeEntry['kind']> = {
  '100644': 'file',
  '100755': 'executable',
  '120000': 'link',
};

const GITLINK_MODE = '160000';

function readTree(git: Git, commit: string): TreeEntry[] {
  const r = git(['ls-tree', '-r', '-l', '-z', '--full-tree', commit]);
  if (r.status !== 0)
    throw new MissingObjectsError(
      `Listing the files of ${commit} failed, so this repository doesn't hold all of it locally: ${r.stderr.toString().trim()}. agentpicks never fetches; fetch the commit (check it out once), then run again.`,
    );
  const submodules: string[] = [];
  const entries: TreeEntry[] = [];
  for (const line of utf8(
    r.stdout,
    `${commit} has a file whose name isn't UTF-8`,
  )
    .split('\0')
    .filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [mode = '', , oid = '', size = ''] = line.slice(0, tab).split(/ +/);
    const path = line.slice(tab + 1);
    if (mode === GITLINK_MODE) {
      submodules.push(path);
      continue;
    }
    const kind = TREE_KINDS[mode];
    if (!kind)
      throw new RepositoryContentError(
        `${path} has git mode ${mode}, which the copy cannot carry.`,
      );
    if (/[\t\n\r]/.test(path))
      throw new RepositoryContentError(
        `${JSON.stringify(path)} has a tab or line break in its name, which the copy cannot carry. Rename it to test this repository.`,
      );
    entries.push({ path, kind, oid, size: Number(size) });
  }
  if (submodules.length > 0)
    throw new SubmodulesError(
      `${commit} has submodules (${submodules.join(', ')}), and a commit holds only their commit ids, so a run can't copy what they contain. Test a repository without submodules.`,
    );
  const bytes = entries.reduce((sum, e) => sum + e.size, 0);
  if (bytes > REPOSITORY_MAX_BYTES)
    throw new RepositoryContentError(
      `${commit} holds ${Math.round(bytes / 1024 / 1024)} MB of files; a run copies at most ${REPOSITORY_MAX_BYTES / 1024 / 1024} MB.`,
    );
  return entries;
}

/**
 * Names and symlink targets as text, refused when they aren't UTF-8: decoding would replace their
 * bytes, so the copy would carry a different name or target, or two files under one name.
 */
function utf8(bytes: Buffer, refusal: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RepositoryContentError(
      `${refusal}, which the copy cannot carry. Rename it to test this repository.`,
    );
  }
}

/** Each blob's bytes, read in one `git cat-file --batch`, which applies no filter or textconv. */
function readBlobs(
  git: Git,
  root: string,
  commit: string,
  tree: TreeEntry[],
): Map<string, Buffer> {
  const unique = [...new Set(tree.map((e) => e.oid))];
  const blobs = new Map<string, Buffer>();
  if (unique.length === 0) return blobs;
  const r = git(['cat-file', '--batch'], `${unique.join('\n')}\n`);
  if (r.status !== 0)
    throw new RepositoryContentError(
      `Reading the files of ${root} failed: ${r.stderr.toString().trim()}`,
    );
  const out = r.stdout;
  let at = 0;
  for (const oid of unique) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString();
    const [, type, size] = header.split(' ');
    if (type !== 'blob') {
      const path = tree.find((e) => e.oid === oid)?.path ?? oid;
      throw new MissingObjectsError(
        `${root} doesn't hold ${path} of ${commit} locally (a partial clone), and agentpicks never fetches. Fetch the commit's files (check it out once, or clone without --filter), then run again.`,
      );
    }
    const start = eol + 1;
    blobs.set(oid, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
}

/**
 * The remote of the repository containing `root`, as `readRepository` records it; null outside a
 * repository, without git, or with no remote read with confidence. `init` names the customer's
 * tool from it.
 */
export function repositoryRemote(root: string): string | null {
  try {
    return readRemoteUrl(hostGit(findGitDir(resolve(root))));
  } catch (error) {
    if (
      error instanceof NotARepositoryError ||
      error instanceof UnsupportedGitError
    )
      return null;
    throw error;
  }
}

/** Whether HEAD names a commit that can be read locally, for init's repository default. */
export function repositoryHasCommit(root: string): boolean {
  try {
    const git = hostGit(findGitDir(resolve(root)));
    refusePartialCloneOnOldGit(git, root);
    resolveCommit(git, root, undefined);
    return true;
  } catch (error) {
    if (
      error instanceof NotARepositoryError ||
      error instanceof UnsupportedGitError ||
      error instanceof UnknownCommitError
    )
      return false;
    throw error;
  }
}

function readRemoteUrl(git: Git): string | null {
  const remotes = git(['remote']).stdout.toString().split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) return null;
  const r = git(['remote', 'get-url', remote]);
  const url = r.stdout.toString().trim();
  return r.status === 0 && url ? sanitizeRemoteUrl(url) : null;
}

/** A host name or IPv4 address, with an optional port. An IPv6 literal isn't read: its `::` is a helper's mark. */
const HOST =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;

/**
 * A remote address reduced to its host and path, in the forms git takes: `scheme://host/path`,
 * scp-like `host:path`, and `transport::address` (as its address). Userinfo, query and fragment
 * are dropped. Null for a local path, or any address not read with confidence: one whose path
 * holds an `@`, a backslash or a space could be a credential split at a slash, and one the bundle
 * manifest would refuse (a `::` left in the path) is dropped before the run rather than after it.
 */
export function sanitizeRemoteUrl(raw: string): string | null {
  const url = reduceRemoteUrl(raw);
  return url && isHostAndPath(url) ? url : null;
}

function reduceRemoteUrl(raw: string): string | null {
  const url = raw.trim();
  const helper = /^[A-Za-z][A-Za-z0-9+.-]*::([\s\S]*)$/.exec(url);
  if (helper) return reduceRemoteUrl(helper[1]!);

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#\\]*)([^?#]*)/.exec(url);
  if (scheme) {
    const [, name = '', authority = '', path = ''] = scheme;
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (!HOST.test(host) || /[\\\s@]/.test(path)) return null;
    return `${name.toLowerCase()}://${host}${path}`;
  }

  // scp-like `[user@]host:path`: a colon before any slash. A single-letter host is a drive.
  const scp = /^(?:[^/]*@)?([^@/:]+):([^?#]*)$/.exec(url);
  if (!scp) return null;
  const [, host = '', path = ''] = scp;
  if (host.length < 2 || !HOST.test(host) || /[\\\s@]/.test(path)) return null;
  return `${host}:${path}`;
}

/** Lockfiles at the repository's root, by the package manager that installs each frozen. */
const NODE_LOCKS: Record<string, NonNullable<RepositoryInstall['node']>> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
};

/** Files at the root that mean a package manager the sandbox has no frozen install for. */
const UNSUPPORTED: Record<string, string> = {
  'bun.lock': 'Bun',
  'bun.lockb': 'Bun',
  'deno.json': 'Deno',
  'deno.jsonc': 'Deno',
  'deno.lock': 'Deno',
  'poetry.lock': 'Poetry',
  Pipfile: 'Pipenv',
  'Pipfile.lock': 'Pipenv',
  'pdm.lock': 'PDM',
  'go.mod': 'Go modules',
  'Cargo.toml': 'Cargo',
  'composer.json': 'Composer',
  'pom.xml': 'Maven',
  'build.gradle': 'Gradle',
  'build.gradle.kts': 'Gradle',
  'mix.exs': 'Mix',
  'Package.swift': 'Swift Package Manager',
  'pubspec.yaml': 'pub',
};

const SUPPORTED =
  'npm, pnpm and Yarn from their lockfile, uv from uv.lock, pip from a hashed requirements.txt, and Bundler from Gemfile.lock';

/**
 * How a repository installs, from the files at its root: one Node lockfile, uv.lock or
 * requirements.txt, and Gemfile.lock, each optional. A manifest with no lockfile, several Node
 * lockfiles, or any other package manager is refused, naming it.
 */
export function detectInstall(paths: string[]): RepositoryInstall {
  const root = new Set(paths.filter((p) => !p.includes('/')));
  const unsupported = [...root].filter((p) => Object.hasOwn(UNSUPPORTED, p));
  if (unsupported.length > 0)
    throw new UnsupportedPackageManagerError(
      `This repository uses ${[...new Set(unsupported.map((p) => UNSUPPORTED[p]))].join(' and ')} (${unsupported.join(', ')}), which agentpicks can't install. It installs ${SUPPORTED}.`,
    );
  const nodeLocks = Object.keys(NODE_LOCKS).filter((p) => root.has(p));
  if (nodeLocks.length > 1)
    throw new UnsupportedPackageManagerError(
      `This repository has several Node lockfiles (${nodeLocks.join(', ')}). Keep the one its package manager writes.`,
    );
  const missing = (manifest: string, locks: string) =>
    new UnsupportedPackageManagerError(
      `This repository has ${manifest} but no ${locks}, so it can't be installed frozen. Commit its lockfile.`,
    );
  if (root.has('package.json') && nodeLocks.length === 0)
    throw missing('package.json', Object.keys(NODE_LOCKS).join(', '));
  const python = root.has('uv.lock')
    ? 'uv'
    : root.has('requirements.txt')
      ? 'pip'
      : null;
  if (root.has('pyproject.toml') && !python)
    throw missing('pyproject.toml', 'uv.lock or requirements.txt');
  if (root.has('Gemfile') && !root.has('Gemfile.lock'))
    throw missing('Gemfile', 'Gemfile.lock');
  return {
    node: nodeLocks[0] ? NODE_LOCKS[nodeLocks[0]]! : null,
    python,
    ruby: root.has('Gemfile.lock') ? 'bundler' : null,
  };
}

/** A requirement pinned with `==` to one version, with optional markers and one or more hashes. */
const HASHED_REQUIREMENT =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,\s-]*\])?\s*==\s*[A-Za-z0-9.+!_-]+(\s*;[^\\]*?)?(\s+--hash[=\s]\s*[a-z0-9]+:[0-9a-f]+)+$/;

/**
 * Refuses a requirements.txt pip can't install frozen: every requirement must be pinned with `==`
 * and carry a `--hash`, and no other option or include is allowed, so `--require-hashes` holds.
 */
export function checkHashedRequirements(text: string): void {
  const lines = text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
  const unpinned = lines.find((line) => !HASHED_REQUIREMENT.test(line));
  if (unpinned !== undefined)
    throw new UnhashedRequirementsError(
      `requirements.txt has a line not pinned with == and a --hash (${JSON.stringify(unpinned.slice(0, 80))}), so it can't be installed frozen. Commit a uv.lock, or a hashed requirements file (\`uv pip compile --generate-hashes\` or \`pip-compile --generate-hashes\`).`,
    );
}

/**
 * Refuses a Gemfile.lock whose PLATFORMS has neither `ruby` nor an x86_64 Linux platform, as a
 * lockfile written on macOS often has: frozen, Bundler won't add the sandbox's platform.
 */
export function checkGemfilePlatforms(text: string): void {
  const section =
    /^PLATFORMS\r?\n((?:[ \t]+\S.*\r?\n?)*)/m.exec(text)?.[1] ?? '';
  const platforms = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (platforms.some((p) => p === 'ruby' || p.startsWith('x86_64-linux')))
    return;
  throw new GemfilePlatformsError(
    `Gemfile.lock lists ${platforms.length ? `only ${platforms.join(', ')}` : 'no platform'}, so Bundler can't install it frozen in the Linux sandbox. Run \`bundle lock --add-platform x86_64-linux\` and commit Gemfile.lock.`,
  );
}

/**
 * The lines printed before the first run: the commit tested, that uncommitted changes aren't in
 * it, and what is copied and installed.
 */
export function describeRepository(repo: RepositorySnapshot): string[] {
  const managers = [repo.install.node, repo.install.python, repo.install.ruby]
    .filter(Boolean)
    .join(', ');
  return [
    `Testing commit ${repo.commit.slice(0, 12)} of ${basename(repo.root)}. Uncommitted changes aren't included.`,
    `Repository: ${repo.files} file${repo.files === 1 ? '' : 's'}${repo.remoteUrl ? `, remote ${repo.remoteUrl}` : ''}, ${managers ? `installed with ${managers}` : 'nothing to install'}`,
  ];
}
