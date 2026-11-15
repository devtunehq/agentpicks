/**
 * ABOUTME: `agentpicks init`: writes `agentpicks/<name>.yaml` from a short wizard whose defaults
 * come from the repository (`init-detect.ts`). The job is a built-in category, which writes
 * `from:`, or a job line; a job line's requests and tools are drafted through DevTune when signed
 * in (`init-draft.ts`), else typed. Each question shows its default and Enter takes it; `--yes`
 * takes every default and asks nothing, refusing by name when one can't be detected. The file is
 * checked as `validate` checks it before it is written, through a temporary file linked into place
 * so a setup that appeared meanwhile is never replaced without `--force`.
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';

import { stringify } from 'yaml';

import {
  CATEGORY_REQUESTS,
  findCategoryRequests,
} from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import {
  ENVIRONMENTS,
  environmentRunsIn,
  isRetiredEnvironment,
} from '../catalogue/environments';
import { checkSetupText, SETUPS_DIR } from '../setup/files';
import {
  requestTextProblem,
  SETUP_MAX_COMPETITORS,
  SETUP_REQUEST_MIN_LENGTH,
  SETUP_TEXT_MAX_LENGTH,
} from '../setup/rules';
import type { SetupFile, SetupToolEntry } from '../setup/schema';
import { UsageError } from './errors';
import { detectRepository, type DetectedRepository } from './init-detect';
import { devtuneDrafting, type Drafting, type JobDraft } from './init-draft';
import type { CliContext } from './main';
import { SELF_RUN_AGENTS } from './self-run-agents';
import { writeSetupText } from './setup-write';

type Answer<T> = { value: T } | { problem: string };

interface Question<T> {
  label: string;
  /** The default, as it would be typed; null when there is none. */
  fallback: string | null;
  read(answer: string): Answer<T>;
  /** Why `--yes` has no default here, and how to give one. */
  missing?: string;
}

interface Wizard {
  yes: boolean;
  ask: (question: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  detected: DetectedRepository;
  drafting: Drafting | null;
}

/** `agentpicks init [--yes] [--force]`. `ask` reads one answer from the terminal. */
export async function initCommand(
  argv: string[],
  ctx: CliContext & { ask: (question: string) => Promise<string> },
): Promise<number> {
  const { yes, force } = parseInitArgs(argv);
  if (!yes && !ctx.interactive)
    throw new UsageError(
      "agentpicks init asks questions, and this isn't a terminal. Run it on a terminal, or pass --yes to take every detected default.",
    );
  const wizard: Wizard = {
    yes,
    ask: ctx.ask,
    out: ctx.out,
    err: ctx.err,
    detected: detectRepository(ctx.cwd, ctx.io),
    drafting: null,
  };
  if (!yes) ctx.out('Press Enter to take the default in brackets.');

  const job = await askJob(wizard);
  let file: SetupFile;
  if ('category' in job) file = await askCategoryTools(wizard, job.category);
  else {
    wizard.drafting = devtuneDrafting(ctx.io, ctx.err);
    file = await askCustomJob(wizard, job.line);
  }
  Object.assign(file, await askTests(wizard, file.from));
  const agents = await askAgents(wizard);
  if (agents) file.agents = agents;
  const runs = await ask<number>(wizard, {
    label: 'Runs per agent and stack',
    fallback: '1',
    read: (answer) =>
      /^[1-9]\d*$/.test(answer) && Number(answer) <= 100
        ? { value: Number(answer) }
        : { problem: 'Give a whole number of runs, 1 to 100.' },
  });
  if (runs !== 1) file.runs = runs;

  const dir = join(wizard.detected.root, SETUPS_DIR);
  const text = stringify(file);
  const name = await ask<string>(wizard, {
    label: 'Name',
    fallback: file.from ?? slug(file.job!),
    read: (answer) => {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(answer))
        return {
          problem:
            'A name is lowercase letters, digits and hyphens, such as error-tracking.',
        };
      const path = setupPath(dir, answer);
      if (existsSync(path) && !force)
        return {
          problem: `${relative(ctx.cwd, path)} exists. Choose another name, or pass --force to replace it.`,
        };
      const checked = checkSetupText(path, text);
      return checked.problems.length > 0
        ? {
            problem: checked.problems
              .map((p) => `${p.field}: ${p.message}`)
              .join('\n'),
          }
        : { value: answer };
    },
  });
  const path = setupPath(dir, name);
  writeSetup(dir, path, text, force, ctx.cwd);

  const shown = relative(ctx.cwd, path) || path;
  ctx.out('');
  ctx.out(`Wrote ${shown}:`);
  ctx.out('');
  for (const line of text.trimEnd().split('\n')) ctx.out(`  ${line}`);
  ctx.out('');
  if (!file.agents)
    ctx.out(
      'It names no agents, so run uses the one agent installed where it runs.',
    );
  const custom = checkSetupText(path, text).setup!.customReason !== null;
  ctx.out(
    custom
      ? `To upload its runs, first run: agentpicks push ${name}, then agentpicks run ${name}. To keep bundles on this machine only, run: agentpicks run ${name} --no-upload.`
      : `Run it with: agentpicks run ${name}`,
  );
  return 0;
}

function parseInitArgs(argv: string[]) {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        yes: { type: 'boolean', short: 'y', default: false },
        force: { type: 'boolean', default: false },
      },
    });
    return { yes: values.yes, force: values.force };
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Asks one question until its answer reads, or under --yes takes its default. */
async function ask<T>(wizard: Wizard, question: Question<T>): Promise<T> {
  if (wizard.yes) {
    if (question.fallback === null)
      throw new UsageError(
        `agentpicks init --yes ${question.missing ?? `has no default for ${question.label.toLowerCase()}. Run agentpicks init on a terminal to answer it.`}`,
      );
    const read = question.read(question.fallback);
    if ('problem' in read) throw new UsageError(read.problem);
    return read.value;
  }
  for (;;) {
    const shown = question.fallback === null ? '' : ` [${question.fallback}]`;
    const answer =
      (await wizard.ask(`${question.label}${shown}: `)).trim() ||
      question.fallback ||
      '';
    const read = question.read(answer);
    if ('value' in read) return read.value;
    wizard.err(read.problem);
  }
}

/** Splits a comma-separated answer into its entries. */
const entries = (answer: string) =>
  answer
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Whether a request or new job line is shorter or longer than the setup rules take. */
const badLength = (text: string) => {
  const problem = requestTextProblem(text);
  return problem === 'too_short' || problem === 'too_long';
};

/** The job: a built-in category by number or slug, or a job line of its own. */
async function askJob(
  wizard: Wizard,
): Promise<{ category: string } | { line: string }> {
  const detected = wizard.detected.tool?.categories[0];
  const index = CATEGORY_REQUESTS.findIndex((c) => c.slug === detected);
  if (!wizard.yes) {
    wizard.out('Categories:');
    CATEGORY_REQUESTS.forEach((category, i) =>
      wizard.out(`  ${String(i + 1).padStart(2)}  ${category.name}`),
    );
  }
  return ask<{ category: string } | { line: string }>(wizard, {
    label: 'Job: a category number, or your own job line',
    fallback: index >= 0 ? String(index + 1) : null,
    missing:
      "can't choose a job: neither package.json nor the git remote names a catalogue tool. Run agentpicks init on a terminal to choose one.",
    read: (answer) => {
      const count = CATEGORY_REQUESTS.length;
      if (/^\d+$/.test(answer)) {
        const category = CATEGORY_REQUESTS[Number(answer) - 1];
        return category
          ? { value: { category: category.slug } }
          : {
              problem: `Choose a category from 1 to ${count}, or write a job line.`,
            };
      }
      const category = findCategoryRequests(answer);
      if (category) return { value: { category: category.slug } };
      if (
        !/\s/.test(answer) ||
        // A new job line meets a request's length; the guard is resolveSetup's, which names the field.
        badLength(answer)
      )
        return {
          problem: `Choose a category from 1 to ${count}, or write the job as a line of ${SETUP_REQUEST_MIN_LENGTH} to ${SETUP_TEXT_MAX_LENGTH} characters, such as Add feature flags.`,
        };
      return { value: { line: answer } };
    },
  });
}

/** A category setup's tools: its own tool and competitors, each a key of the category. */
async function askCategoryTools(
  wizard: Wizard,
  category: string,
): Promise<SetupFile> {
  const keys = CATEGORY_TOOLS[category] ?? [];
  const detected = wizard.detected.tool?.key;
  const own = await ask<string | null>(wizard, {
    label: `Your tool: a ${category} tool key, or none`,
    fallback: detected && keys.includes(detected) ? detected : 'none',
    read: (answer) =>
      answer === 'none'
        ? { value: null }
        : keys.includes(answer)
          ? { value: answer }
          : {
              problem: `${category} has no tool ${answer}. Use one of ${keys.join(', ')}, or none.`,
            },
  });
  const competitors = await ask<string[] | null>(wizard, {
    label: `Competitors: ${category} tool keys separated by commas, or all`,
    fallback: 'all',
    read: (answer): Answer<string[] | null> => {
      if (answer === 'all') return { value: null };
      const chosen = [...new Set(entries(answer))];
      const unknown = chosen.find((key) => !keys.includes(key) || key === own);
      if (!unknown && chosen.length > SETUP_MAX_COMPETITORS)
        return {
          problem: `List at most ${SETUP_MAX_COMPETITORS} competitors, or all.`,
        };
      return unknown
        ? {
            problem:
              unknown === own
                ? `${own} is your tool. List only competitors.`
                : `${category} has no tool ${unknown}. Use ${keys.join(', ')}, or all.`,
          }
        : { value: chosen };
    },
  });
  const tools = {
    ...(own ? { own } : {}),
    ...(competitors ? { competitors } : {}),
  };
  return { from: category, ...(own || competitors ? { tools } : {}) };
}

const INTENTS = ['add', 'recommend', 'hosted'] as const;

/**
 * A job line's requests and tools: drafted by DevTune and offered as defaults when signed in, else
 * typed. Asked again until the setup passes its checks, since a run needs the add request and a
 * tool it can recognise by a package.
 */
async function askCustomJob(wizard: Wizard, line: string): Promise<SetupFile> {
  const drafted = (await wizard.drafting?.job(line)) ?? null;
  const toolDrafts = new Map<string, SetupToolEntry | null>();
  for (;;) {
    const file: SetupFile = { job: line, requests: {} };
    for (const intent of INTENTS) {
      const request = await askRequest(wizard, intent, drafted);
      if (request) file.requests![intent] = request;
    }
    const own = await askOwnTool(wizard, line, toolDrafts);
    const competitors = await askCompetitors(
      wizard,
      line,
      drafted,
      own,
      toolDrafts,
    );
    file.tools = {
      ...(own ? { own } : {}),
      ...(competitors.length > 0 ? { competitors } : {}),
    };
    const checked = checkSetupText(
      join(wizard.detected.root, SETUPS_DIR, 'init.yaml'),
      stringify(file),
    );
    if (checked.problems.length === 0) return file;
    for (const problem of checked.problems)
      wizard.err(`${problem.field}: ${problem.message}`);
    wizard.err('Answer the requests and tools again.');
  }
}

async function askRequest(
  wizard: Wizard,
  intent: (typeof INTENTS)[number],
  drafted: JobDraft | null,
): Promise<string | null> {
  const draft = drafted?.requests.find((r) => r.intent === intent)?.text;
  return ask<string | null>(wizard, {
    label:
      intent === 'add'
        ? 'The add request, which a run asks'
        : `The ${intent} request, or none`,
    fallback: draft ?? (intent === 'add' ? null : 'none'),
    read: (answer) => {
      if (answer === 'none' && intent !== 'add') return { value: null };
      return !badLength(answer)
        ? { value: answer }
        : {
            problem: `Write the ${intent} request in ${SETUP_REQUEST_MIN_LENGTH} to ${SETUP_TEXT_MAX_LENGTH} characters${intent === 'add' ? '' : ', or none'}.`,
          };
    },
  });
}

/** The customer's own tool with its signals, or null for none. */
async function askOwnTool(
  wizard: Wizard,
  job: string,
  toolDrafts: Map<string, SetupToolEntry | null>,
): Promise<SetupToolEntry | null> {
  const { packageName, tool } = wizard.detected;
  const name = await ask<string | null>(wizard, {
    label: "Your tool's name, or none",
    fallback: tool?.key ?? packageName?.replace(/^@[^/]+\//, '') ?? 'none',
    read: (answer) =>
      answer === 'none'
        ? { value: null }
        : answer.length <= 100
          ? { value: answer }
          : { problem: 'Give a name of up to 100 characters.' },
  });
  if (name === null) return null;
  return toolWithSignals(
    wizard,
    { key: slug(name), name, domain: null },
    job,
    [],
    toolDrafts,
    // The repository's own package installs the customer's tool when the name came from it.
    packageName && name === packageName.replace(/^@[^/]+\//, '')
      ? packageName
      : null,
  );
}

/**
 * Competitors with their signals: by name, drafted through DevTune, while drafting is on; else by
 * the npm packages that install them.
 */
async function askCompetitors(
  wizard: Wizard,
  job: string,
  drafted: JobDraft | null,
  own: SetupToolEntry | null,
  toolDrafts: Map<string, SetupToolEntry | null>,
): Promise<SetupToolEntry[]> {
  const room = SETUP_MAX_COMPETITORS;
  const tooMany = `List at most ${room}: a setup tracks up to ${room} competitors.`;
  if (drafted) {
    const names = await ask<string[]>(wizard, {
      label: "Competitors' names separated by commas, or none",
      fallback:
        drafted.competitors
          .slice(0, room)
          .map((c) => c.name)
          .join(', ') || 'none',
      read: (answer) => {
        const chosen = answer === 'none' ? [] : [...new Set(entries(answer))];
        return chosen.length > room ? { problem: tooMany } : { value: chosen };
      },
    });
    const others = [
      ...(own ? [own] : []),
      ...names.map((name) => ({ key: slug(name), name })),
    ];
    const tools: SetupToolEntry[] = [];
    for (const name of names) {
      const key = slug(name);
      const domain =
        drafted.competitors.find((c) => c.name === name)?.domain ?? null;
      const tool = await toolWithSignals(
        wizard,
        { key, name, domain },
        job,
        others.filter((other) => other.key !== key),
        toolDrafts,
        null,
      );
      if (tool) tools.push(tool);
    }
    return tools;
  }
  const packages = await ask<string[]>(wizard, {
    label: "Competitors' npm packages separated by commas, or none",
    fallback: 'none',
    read: (answer) => {
      const chosen = answer === 'none' ? [] : [...new Set(entries(answer))];
      return chosen.length > room ? { problem: tooMany } : { value: chosen };
    },
  });
  return packages.map((name) => ({
    key: slug(name),
    name,
    signals: { packages: { npm: [name] } },
  }));
}

/**
 * The tool with its signals: drafted through DevTune while drafting is on, else the npm packages
 * the customer gives (`detected` the default). Null when it has none, since a run couldn't
 * recognise it; the setup's checks then say what's missing.
 */
async function toolWithSignals(
  wizard: Wizard,
  tool: { key: string; name: string; domain: string | null },
  job: string,
  others: { key: string; name: string }[],
  toolDrafts: Map<string, SetupToolEntry | null>,
  detected: string | null,
): Promise<SetupToolEntry | null> {
  if (wizard.drafting && !toolDrafts.has(tool.key))
    toolDrafts.set(tool.key, await wizard.drafting.tool(tool, job, others));
  const drafted = toolDrafts.get(tool.key);
  if (drafted) return drafted;
  const packages = await ask<string[]>(wizard, {
    label: `${tool.name}'s npm packages separated by commas, or none`,
    fallback: detected ?? 'none',
    read: (answer) => ({
      value: answer === 'none' ? [] : [...new Set(entries(answer))],
    }),
  });
  if (packages.length === 0) return null;
  return {
    key: tool.key,
    name: tool.name,
    ...(tool.domain ? { domain: tool.domain } : {}),
    signals: { packages: { npm: packages } },
  };
}

/** Where a run tests: the repository (`repo: .`) in a git repository, else the stacks detected. */
async function askTests(
  wizard: Wizard,
  from: string | undefined,
): Promise<Pick<SetupFile, 'repo' | 'stacks'>> {
  const runsIn = from ?? 'job-';
  const choices = ENVIRONMENTS.filter(
    (env) =>
      !isRetiredEnvironment(env.slug) && environmentRunsIn(env.slug, runsIn),
  ).map((env) => env.slug);
  const { git, stacks, root } = wizard.detected;
  const detected = stacks.filter((stack) => choices.includes(stack));
  return ask<Pick<SetupFile, 'repo' | 'stacks'>>(wizard, {
    label: 'Test in your repository (.) or in stacks separated by commas',
    fallback: git ? '.' : detected.join(', ') || null,
    missing: `found nothing to test in: ${root} isn't a git repository, and its package.json and lockfiles name no framework of a stack (${choices.join(', ')}). Run it in a git repository, or on a terminal to choose stacks.`,
    read: (answer): Answer<Pick<SetupFile, 'repo' | 'stacks'>> => {
      if (answer === '.') return { value: { repo: '.' } };
      const chosen = [...new Set(entries(answer))];
      const unknown = chosen.find((stack) => !choices.includes(stack));
      if (chosen.length === 0 || unknown)
        return {
          problem: `${unknown ?? 'Nothing'} isn't a stack ${from ? `for ${from}` : 'for your own job'}. Give . or stacks from ${choices.join(', ')}.`,
        };
      return { value: { stacks: chosen } };
    },
  });
}

/** The agents to test: those installed and signed in here, or null to leave it to the machine that runs it. */
async function askAgents(wizard: Wizard): Promise<string[] | null> {
  return ask<string[] | null>(wizard, {
    label: 'Agents separated by commas, or any',
    fallback: wizard.detected.agents.join(', ') || 'any',
    read: (answer): Answer<string[] | null> => {
      if (answer === 'any') return { value: null };
      const chosen = entries(answer).map(
        (alias) =>
          SELF_RUN_AGENTS.find((a) => a.aliases.includes(alias.toLowerCase()))
            ?.aliases[0] ?? alias,
      );
      const unique = [...new Set(chosen)];
      const unknown = unique.find(
        (alias) => !SELF_RUN_AGENTS.some((a) => a.aliases[0] === alias),
      );
      if (unknown || unique.length === 0 || unique.length > 4)
        return {
          problem: `Give up to four of ${SELF_RUN_AGENTS.map((a) => a.aliases[0]).join(', ')}, or any.`,
        };
      return { value: unique };
    },
  });
}

/** A setup or tool name from free text: lowercase letters and digits joined by hyphens. */
function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/, '') || 'setup'
  );
}

/** The setup named `name`: its existing file, `.yaml` or `.yml`, else a new `.yaml`. */
function setupPath(dir: string, name: string): string {
  return (
    ['.yaml', '.yml']
      .map((ext) => join(dir, `${name}${ext}`))
      .find(existsSync) ?? join(dir, `${name}.yaml`)
  );
}

/**
 * Writes the file through a temporary one beside it: renamed over the target with --force, else
 * linked into place, which fails rather than replace a file another `init` wrote meanwhile.
 */
function writeSetup(
  dir: string,
  path: string,
  text: string,
  force: boolean,
  cwd: string,
) {
  try {
    writeSetupText(dir, path, text, {
      replace: force,
      shown: (target) => relative(cwd, target) || target,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new UsageError(
        `${relative(cwd, path)} appeared while init ran. Run init again with another name, or pass --force to replace it.`,
      );
    throw error;
  }
}
