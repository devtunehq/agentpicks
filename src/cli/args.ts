/**
 * ABOUTME: Parses `agentpicks run` arguments and resolves them against the catalogue: the
 * category, and either the stack (a committed starter the category runs in) or the customer's
 * repository (`--repo`, at `--ref` or HEAD). A run asks the category's default request, `add`.
 * Refuses an unknown one with a named error that lists the valid values, and a stack the Docker
 * host's architecture cannot run.
 */
import { parseArgs } from 'node:util';

import type { RepositoryInstall } from '../assets/repository-scripts';
import {
  CATEGORY_REQUESTS,
  findCategoryRequests,
  type CategoryRequests,
} from '../catalogue/categories';
import {
  ENVIRONMENTS,
  environmentRunsIn,
  findEnvironment,
  isRetiredEnvironment,
  type EnvironmentDefinition,
  type StarterKey,
} from '../catalogue/environments';
import type { PromptIntent } from '../catalogue/prompt-intents';
import type { SandboxPlatform } from '../sandbox/platform';
import {
  StackArchitectureError,
  UnknownCategoryError,
  UnknownStackError,
  UsageError,
} from './errors';
import { CUSTOMER_REPOSITORY_ENVIRONMENT } from './repository';

export interface RunArgs {
  category: string;
  /** Exactly one of `stack` and `repo` is set. */
  stack?: string;
  /** The path to the customer's repository. */
  repo?: string;
  /** The commit of `repo` to test; HEAD when absent. */
  ref?: string;
  runs: number;
  agent?: string;
  model?: string;
  out: string;
}

export const DEFAULT_OUT_DIR = './agentpicks-runs';

export function parseRunArgs(argv: string[]): RunArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        category: { type: 'string' },
        stack: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string' },
        runs: { type: 'string', default: '1' },
        agent: { type: 'string' },
        model: { type: 'string' },
        out: { type: 'string', default: DEFAULT_OUT_DIR },
      },
    }));
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!values.category)
    throw new UnknownCategoryError(
      `Choose a category with --category: ${categoryList()}.`,
    );
  if (values.stack !== undefined && values.repo !== undefined)
    throw new UsageError(
      'Pass --stack or --repo, not both: a run tests a starter or your repository.',
    );
  if (values.ref !== undefined && values.repo === undefined)
    throw new UsageError('--ref names a commit of --repo; pass --repo too.');
  if (!values.stack && !values.repo)
    throw new UnknownStackError(
      `Choose a stack with --stack: ${stackList(values.category)}. Or test your repository with --repo <path>.`,
    );
  if (!/^[1-9]\d*$/.test(values.runs))
    throw new UsageError(
      `--runs takes a whole number of runs, 1 or more, not ${values.runs}.`,
    );
  return {
    category: values.category,
    stack: values.stack,
    repo: values.repo,
    ref: values.ref,
    runs: Number(values.runs),
    agent: values.agent,
    model: values.model,
    out: values.out,
  };
}

export interface ResolvedTest {
  category: CategoryRequests;
  environment: EnvironmentDefinition;
  intent: PromptIntent;
  /** The request text, before the environment prefix and the request ending. */
  prompt: string;
}

/**
 * The category, stack and request a run tests; refuses any the catalogue does not hold. A
 * repository run (`repo` set) runs in every category, in the shared `customer_repository`
 * environment.
 */
export function resolveTest(
  args: Pick<RunArgs, 'category' | 'stack' | 'repo'>,
): ResolvedTest {
  const category = findCategoryRequests(args.category);
  if (!category)
    throw new UnknownCategoryError(
      `There is no category ${args.category}. Choose one of: ${categoryList()}.`,
    );
  const environment =
    args.repo !== undefined
      ? CUSTOMER_REPOSITORY_ENVIRONMENT
      : resolveStack(args.stack ?? '', category.slug);
  // Every category's first request is `add`, and no stack leaves it out.
  const [request] = category.prompts;
  return {
    category,
    environment,
    intent: request.intent,
    prompt: request.text,
  };
}

function resolveStack(stack: string, categorySlug: string) {
  const environment = findEnvironment(stack);
  if (
    !environment ||
    isRetiredEnvironment(environment.slug) ||
    !environmentRunsIn(environment.slug, categorySlug)
  )
    throw new UnknownStackError(
      `There is no stack ${stack} for ${categorySlug}. Choose one of: ${stackList(categorySlug)}.`,
    );
  return environment;
}

/** Starters whose setup downloads a runtime pinned for x86_64 only, by the name a refusal gives it. */
const X86_64_ONLY_STARTERS: Partial<Record<StarterKey, string>> = {
  rails: 'Rails',
};

/** Refuses, before anything is built or started, a stack that cannot run on `platform`. */
export function assertStackRuns(
  environment: EnvironmentDefinition,
  platform: SandboxPlatform,
): void {
  const runtime = X86_64_ONLY_STARTERS[environment.starter];
  if (platform === 'linux/arm64' && runtime)
    throw new StackArchitectureError(
      `${runtime} isn't available on arm64 machines yet, so --stack ${environment.slug} can't run here. Choose another stack.`,
    );
}

/** Refuses, before anything is built or started, a `--repo` whose installs can't run on `platform`. */
export function assertRepositoryRuns(
  install: RepositoryInstall,
  platform: SandboxPlatform,
): void {
  if (platform === 'linux/arm64' && install.ruby)
    throw new StackArchitectureError(
      "Ruby isn't available on arm64 machines yet, so a repository with a Gemfile.lock can't run here. Run it on an x86_64 machine.",
    );
}

function categoryList(): string {
  return CATEGORY_REQUESTS.map((c) => c.slug).join(', ');
}

function stackList(categorySlug: string): string {
  return ENVIRONMENTS.filter(
    (env) =>
      !isRetiredEnvironment(env.slug) &&
      (findCategoryRequests(categorySlug)
        ? environmentRunsIn(env.slug, categorySlug)
        : !env.categories),
  )
    .map((env) => env.slug)
    .join(', ');
}
