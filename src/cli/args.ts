/**
 * ABOUTME: Parses `agentpicks run` arguments and resolves them into a run plan: a built-in category
 * (`--category`) or a setup file, with the stacks (committed starters it runs in) or the customer's
 * repository (`--repo`, at `--ref` or HEAD), the agents and the number of runs; a setup's flags
 * override its file. A run asks the `add` request. Refuses an unknown category or stack with a
 * named error that lists the valid values, and a stack the Docker host's architecture cannot run.
 */
import { relative, resolve } from 'node:path';
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
import type { ResolvedSetup } from '../setup/resolve';
import { CUSTOM_SETUP_CATEGORY_PREFIX, type BundleSetup } from './bundle';
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
  /** Upload each bundle to DevTune once it is written; false with --no-upload. */
  upload: boolean;
}

export const DEFAULT_OUT_DIR = './agentpicks-runs';

const RUN_OPTIONS = {
  category: { type: 'string' },
  stack: { type: 'string' },
  repo: { type: 'string' },
  ref: { type: 'string' },
  runs: { type: 'string' },
  agent: { type: 'string' },
  model: { type: 'string' },
  out: { type: 'string', default: DEFAULT_OUT_DIR },
  'no-upload': { type: 'boolean', default: false },
} as const;

function readRunOptions(argv: string[]) {
  return usage(() =>
    parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: RUN_OPTIONS,
    }),
  );
}

type RunValues = ReturnType<typeof readRunOptions>['values'];

/** `agentpicks run --category …`: a one-off run of a built-in category. */
export function parseRunArgs(argv: string[]): RunArgs {
  const { values, positionals } = readRunOptions(argv);
  if (positionals.length > 0)
    throw new UsageError(
      `Unexpected argument '${positionals[0]}'. Name a setup or pass --category, not both.`,
    );
  return categoryArgs(values);
}

/** `--category`'s flags, checked; `hint` follows the refusal of a missing category. */
function categoryArgs(values: RunValues, hint = ''): RunArgs {
  if (!values.category)
    throw new UnknownCategoryError(
      `Choose a category with --category: ${categoryList()}.${hint}`,
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
  return {
    category: values.category,
    stack: values.stack,
    repo: values.repo,
    ref: values.ref,
    runs: runCount(values.runs) ?? 1,
    agent: values.agent,
    model: values.model,
    out: values.out,
    upload: !values['no-upload'],
  };
}

function runCount(runs: string | undefined): number | undefined {
  if (runs === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(runs))
    throw new UsageError(
      `--runs takes a whole number of runs, 1 or more, not ${runs}.`,
    );
  return Number(runs);
}

/** The flags of `agentpicks run <setup>`, each overriding what the setup file says. */
export type SetupRunFlags = Omit<RunArgs, 'category' | 'runs'> & {
  runs?: number;
};

/**
 * `agentpicks run`: a setup by name or path, the picker (`setup: null`) when nothing is named, no
 * --category is given and `picker` is set (a terminal), or else a one-off run of --category.
 */
export function parseRunCommand(
  argv: string[],
  { picker }: { picker: boolean },
):
  | { kind: 'category'; args: RunArgs }
  | { kind: 'setup'; setup: string | null; flags: SetupRunFlags } {
  const { values, positionals } = readRunOptions(argv);
  if (positionals.length > 1)
    throw new UsageError(
      `Name one setup to run, not ${positionals.length}: ${positionals.join(', ')}.`,
    );
  const [setup] = positionals;
  if (setup !== undefined && values.category !== undefined)
    throw new UsageError(
      `Pass a setup or --category, not both: ${setup} already says what to test.`,
    );
  if (setup === undefined && (values.category !== undefined || !picker))
    return {
      kind: 'category',
      args: categoryArgs(values, ' Or name a setup: agentpicks run <setup>.'),
    };
  if (values.stack !== undefined && values.repo !== undefined)
    throw new UsageError(
      'Pass --stack or --repo, not both: a run tests a starter or your repository.',
    );
  return {
    kind: 'setup',
    setup: setup ?? null,
    flags: {
      stack: values.stack,
      repo: values.repo,
      ref: values.ref,
      runs: runCount(values.runs),
      agent: values.agent,
      model: values.model,
      out: values.out,
      upload: !values['no-upload'],
    },
  };
}

/** `agentpicks upload <dir>`: one bundle directory, or the --out directory of `run`. */
export function parseUploadArgs(argv: string[]): { dir: string } {
  const { positionals } = usage(() =>
    parseArgs({ args: argv, strict: true, allowPositionals: true }),
  );
  if (positionals.length !== 1)
    throw new UsageError(
      'Pass the bundle directory to upload, or the --out directory of agentpicks run.',
    );
  return { dir: positionals[0]! };
}

export interface LoginArgs {
  /** Save a project API key read from standard input instead of signing in through the browser. */
  apiKey: boolean;
  /** With apiKey, the key's project, saved without asking DevTune. */
  project?: string;
  /** Print the sign-in address without opening a browser. */
  noBrowser: boolean;
}

/** `agentpicks login [--no-browser]` or `agentpicks login --api-key [--project <id>]`. */
export function parseLoginArgs(argv: string[]): LoginArgs {
  const { values } = usage(() =>
    parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        'api-key': { type: 'boolean', default: false },
        project: { type: 'string' },
        'no-browser': { type: 'boolean', default: false },
      },
    }),
  );
  const apiKey = values['api-key'];
  if (values.project !== undefined && !apiKey)
    throw new UsageError(
      "--project goes with --api-key. Signing in through the browser, you choose the project on DevTune's consent page.",
    );
  if (values['no-browser'] && apiKey)
    throw new UsageError(
      '--no-browser goes with signing in through the browser, not --api-key.',
    );
  return { apiKey, project: values.project, noBrowser: values['no-browser'] };
}

/** The parse, with node's own message as a UsageError. */
function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface ResolvedTest {
  /**
   * What the run records and uploads as, and its early stop: a built-in category, or for a custom
   * setup `setup:<name>`, which no DevTune category matches, with the setup's early stop.
   */
  category: Pick<CategoryRequests, 'slug' | 'earlyStop'>;
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

/** What one `agentpicks run` invocation runs: each test with each agent, `runs` times. */
export interface RunPlan {
  /** One per stack, or one for the repository. */
  tests: ResolvedTest[];
  /** The repository to test, absolute; absent for stacks. */
  repo?: string;
  ref?: string;
  /** Each agent to run; an entry with no agent runs the one installed. */
  agents: { agent?: string; model?: string }[];
  runs: number;
  out: string;
  upload: boolean;
  /** The setup the plan came from, recorded in each bundle's manifest. */
  setup?: {
    record: BundleSetup;
    /** The file, for messages. */
    path: string;
    /** Why it can't upload yet; null when it uploads as its category. */
    customReason: string | null;
  };
}

/** The plan for `run --category …`: one test, one agent. */
export function categoryPlan(args: RunArgs, cwd: string): RunPlan {
  return {
    tests: [resolveTest(args)],
    ...(args.repo === undefined
      ? {}
      : { repo: resolve(cwd, args.repo), ref: args.ref }),
    agents: [{ agent: args.agent, model: args.model }],
    runs: args.runs,
    out: args.out,
    upload: args.upload,
  };
}

/**
 * The plan for `run <setup>`: the setup's tests, agents and runs, each overridden by its flag.
 * `--stack` and `--repo` replace the file's stacks and repo; `--agent` its agents.
 */
export function setupPlan(
  file: { path: string; root: string; setup: ResolvedSetup },
  flags: SetupRunFlags,
  cwd: string,
): RunPlan {
  const { setup } = file;
  const shown = relative(cwd, file.path) || file.path;
  // A custom setup records a category no DevTune category matches, so no route files its runs under one.
  const category = setup.category ?? {
    slug: `${CUSTOM_SETUP_CATEGORY_PREFIX}${setup.name}`,
    earlyStop: setup.earlyStop,
  };
  const test = (environment: EnvironmentDefinition): ResolvedTest => ({
    category,
    environment,
    intent: setup.request.intent,
    prompt: setup.request.text,
  });
  const runsIn = setup.from ?? 'job-';
  let repo: { path: string; ref?: string } | undefined;
  let stacks: EnvironmentDefinition[] = [];
  if (flags.repo !== undefined)
    repo = { path: resolve(cwd, flags.repo), ref: flags.ref };
  else if (flags.stack !== undefined) {
    const environment = findEnvironment(flags.stack);
    if (
      !environment ||
      isRetiredEnvironment(environment.slug) ||
      !environmentRunsIn(environment.slug, runsIn)
    )
      throw new UnknownStackError(
        `There is no stack ${flags.stack} for ${setup.name}. Choose one of: ${stackList(runsIn)}.`,
      );
    stacks = [environment];
  } else if (setup.repo)
    repo = {
      path: resolve(file.root, setup.repo.path),
      ref: flags.ref ?? setup.repo.ref,
    };
  else if (setup.stacks) stacks = setup.stacks;
  else
    throw new UnknownStackError(
      `${shown} names no stacks or repo. Add stacks: or repo: to it, or pass --stack <stack> or --repo <path>.`,
    );
  if (flags.ref !== undefined && !repo)
    throw new UsageError('--ref names a commit of --repo; pass --repo too.');

  const agents = flags.agent ? [flags.agent] : (setup.agents ?? [undefined]);
  if (flags.model !== undefined && agents.length > 1)
    throw new UsageError(
      `--model sets one agent's model, and ${shown} runs ${agents.join(', ')}. Pass --agent too.`,
    );
  return {
    tests: repo ? [test(CUSTOMER_REPOSITORY_ENVIRONMENT)] : stacks.map(test),
    ...(repo ? { repo: repo.path, ref: repo.ref } : {}),
    agents: agents.map((agent) => ({ agent, model: flags.model })),
    runs: flags.runs ?? setup.runs ?? 1,
    out: flags.out,
    upload: flags.upload,
    setup: {
      record: {
        name: setup.name,
        from: setup.from,
        id: setup.id,
        job: setup.job,
      },
      path: file.path,
      customReason: setup.customReason,
    },
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
      (findCategoryRequests(categorySlug) || categorySlug === 'job-'
        ? environmentRunsIn(env.slug, categorySlug)
        : !env.categories),
  )
    .map((env) => env.slug)
    .join(', ');
}
