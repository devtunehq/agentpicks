/**
 * ABOUTME: What `agentpicks init` reads from the customer's repository for its defaults: the stacks
 * its manifests and lockfiles name, whether it has a git commit (so `repo: .`), the customer's
 * own tool from the package name and git remote matched against the catalogue's tool keys, and the
 * agents installed and signed in here, found as `run` finds them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import { gitRoot, setupsRoot } from '../setup/files';
import { SETUP_AGENTS } from '../setup/schema';
import { planAgent } from './agent-plan';
import { resolveCredentials } from './credentials';
import { discoverAgents } from './discover';
import {
  AgentEndpointError,
  AgentModelError,
  KeychainLoginError,
  LoginExpiringError,
  MissingCredentialsError,
} from './errors';
import type { HostIo } from './host';
import { repositoryHasCommit, repositoryRemote } from './repository';
import { SELF_RUN_AGENTS } from './self-run-agents';

export interface DetectedRepository {
  /** The repository root a setup file is written under. */
  root: string;
  /** Whether `root` is a git repository. */
  git: boolean;
  /** Whether HEAD resolves to a commit, so a setup can default to `repo: .`. */
  hasCommit: boolean;
  /** The catalogue stacks the repository's frameworks match, in catalogue order. */
  stacks: string[];
  /** The files the stacks were read from, relative to the root. */
  stackSources: string[];
  /** The package.json name, as npm installs it; null without one. */
  packageName: string | null;
  /** The customer's tool as a catalogue key, with the categories that hold it and where it was read. */
  tool: { key: string; categories: string[]; source: string } | null;
  /** Agents installed and signed in here, by the name a setup gives them. */
  agents: string[];
}

/** Each stack, in catalogue order, with the packages of the framework it starts from. */
const STACK_PACKAGES: {
  stack: string;
  npm?: string[];
  pypi?: string[];
  gem?: string[];
}[] = [
  { stack: 'nextjs', npm: ['next'] },
  {
    stack: 'tanstack',
    npm: ['@tanstack/react-start', '@tanstack/solid-start', '@tanstack/start'],
  },
  { stack: 'sveltekit', npm: ['@sveltejs/kit'] },
  { stack: 'express', npm: ['express'] },
  { stack: 'fastapi', pypi: ['fastapi'] },
  { stack: 'rails', gem: ['rails'] },
];

/** The stacks named by manifests and lockfiles at the repository path, and their sources. */
export function detectStacks(root: string) {
  const packages = readPackages(root);
  const stacks = STACK_PACKAGES.filter(
    ({ npm = [], pypi = [], gem = [] }) =>
      npm.some((name) => packages.npm.has(name)) ||
      pypi.some((name) => packages.pypi.has(name)) ||
      gem.some((name) => packages.gem.has(name)),
  ).map(({ stack }) => stack);
  return { stacks, stackSources: stacks.length > 0 ? packages.sources : [] };
}

export function detectRepository(cwd: string, io: HostIo): DetectedRepository {
  const root = setupsRoot(cwd);
  const manifest = readJson(join(root, 'package.json'));
  const fullName =
    typeof manifest?.name === 'string' ? manifest.name.toLowerCase() : null;
  const git = gitRoot(cwd) !== null;
  return {
    root,
    git,
    hasCommit: git && repositoryHasCommit(root),
    ...detectStacks(root),
    packageName: fullName || null,
    tool: matchTool(fullName, git ? repositoryRemote(root) : null),
    agents: signedInAgents(io),
  };
}

/** The packages the repository's root manifest and lockfiles name, by ecosystem, and the files read. */
function readPackages(root: string) {
  const npm = new Set<string>();
  const pypi = new Set<string>();
  const gem = new Set<string>();
  const sources: string[] = [];
  const add = (set: Set<string>, names: Iterable<string>, source: string) => {
    const before = set.size;
    for (const name of names) set.add(name.toLowerCase());
    if (set.size > before && !sources.includes(source)) sources.push(source);
  };
  const dependencies = (manifest: Record<string, unknown> | null) =>
    ['dependencies', 'devDependencies'].flatMap((field) => {
      const value = manifest?.[field];
      return value && typeof value === 'object' ? Object.keys(value) : [];
    });

  add(npm, dependencies(readJson(join(root, 'package.json'))), 'package.json');
  // A pnpm monorepo's apps declare their frameworks in their own manifests, which its lockfile lists by importer.
  const pnpm = readText(join(root, 'pnpm-lock.yaml'));
  if (pnpm !== null) {
    const lock = safeYaml(pnpm);
    const importers =
      lock?.importers && typeof lock.importers === 'object'
        ? Object.values(lock.importers as Record<string, unknown>)
        : [];
    for (const importer of importers)
      add(
        npm,
        dependencies(
          importer && typeof importer === 'object'
            ? (importer as Record<string, unknown>)
            : null,
        ),
        'pnpm-lock.yaml',
      );
  }
  // npm's lockfile lists each workspace's manifest under its path; installed packages sit under node_modules.
  const npmLock = readJson(join(root, 'package-lock.json'));
  if (npmLock?.packages && typeof npmLock.packages === 'object')
    for (const [path, entry] of Object.entries(
      npmLock.packages as Record<string, unknown>,
    ))
      if (!path.includes('node_modules') && entry && typeof entry === 'object')
        add(
          npm,
          dependencies(entry as Record<string, unknown>),
          'package-lock.json',
        );

  for (const file of ['requirements.txt', 'pyproject.toml', 'uv.lock']) {
    const text = readText(join(root, file));
    // The name as a requirement or a quoted dependency, not `fastapi-users` or prose.
    if (text !== null && /(^|["'])fastapi(?=\s*($|["'<>=!~;[,@]))/im.test(text))
      add(pypi, ['fastapi'], file);
  }
  const gemfile = readText(join(root, 'Gemfile.lock'));
  if (gemfile !== null && /^ {4}rails \(/m.test(gemfile))
    add(gem, ['rails'], 'Gemfile.lock');
  return { npm, pypi, gem, sources };
}

/**
 * The catalogue tool the package name or the git remote names: a key equal to the package's scope
 * or name, the remote's repository or owner, or the first word of one (`sentry-javascript` names
 * `sentry`). Read in that order; the first match wins.
 */
function matchTool(
  packageName: string | null,
  remote: string | null,
): DetectedRepository['tool'] {
  const candidates: { word: string; source: string }[] = [];
  if (packageName) {
    const scope = /^@([^/]+)\//.exec(packageName)?.[1];
    if (scope) candidates.push({ word: scope, source: 'package.json' });
    candidates.push({
      word: packageName.replace(/^@[^/]+\//, ''),
      source: 'package.json',
    });
  }
  if (remote) {
    const [owner, repository] = remote
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .slice(-2);
    for (const word of [repository, owner])
      if (word)
        candidates.push({ word: word.toLowerCase(), source: 'git remote' });
  }
  for (const { word, source } of candidates)
    for (const key of [word, word.split(/[-_.]/)[0]!]) {
      const categories = Object.keys(CATEGORY_TOOLS).filter((slug) =>
        CATEGORY_TOOLS[slug]!.includes(key),
      );
      if (categories.length > 0) return { key, categories, source };
    }
  return null;
}

/** Why `run` would refuse an installed agent before its first container. */
const CREDENTIAL_REFUSALS = [
  AgentEndpointError,
  AgentModelError,
  KeychainLoginError,
  LoginExpiringError,
  MissingCredentialsError,
];

/**
 * The agents `run` could launch here now: installed, with a model it can run, and signed in, as
 * the checks before a run's first container decide.
 */
function signedInAgents(io: HostIo): string[] {
  return discoverAgents(io).agents.flatMap((agent) => {
    try {
      resolveCredentials(planAgent(agent), io);
    } catch (error) {
      if (CREDENTIAL_REFUSALS.some((refusal) => error instanceof refusal))
        return [];
      throw error;
    }
    const alias = SELF_RUN_AGENTS.find((a) => a.kind === agent.kind)!
      .aliases[0]!;
    return SETUP_AGENTS.includes(alias) ? [alias] : [];
  });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeYaml(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = parseYaml(text);
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
