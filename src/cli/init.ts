/**
 * ABOUTME: `agentpicks init`: writes `agentpicks/<name>.yaml` from a short wizard whose defaults
 * come from the repository (`init-detect.ts`). The job is a built-in category, which writes
 * `from:`, or a job line; a job line's requests and tools (`init-job-line.ts`) are drafted through
 * DevTune when signed in (`init-draft.ts`), else typed. Questions are asked through `init-wizard.ts`. Categories, a category's tools and stacks are listed numbered, and
 * a typed answer picks them by number, or by a range such as 2-4 where it takes several. Each
 * question shows its default and Enter takes it; `--yes` takes every default, refusing by name when
 * one can't be detected. A category setup's questions each have a flag (`--category`, `--tool`,
 * `--competitors`, `--repo .` or `--stack`, `--agent`, `--runs`, `--name`, or `--job` for a job
 * line) taking keys, never list numbers: its value is read as the typed answer is, before anything
 * is listed, asked or drafted where no earlier answer is needed; a question a flag answers is
 * neither listed nor asked, and a value that doesn't read refuses, naming the flag. Off a terminal,
 * a question no flag answers takes its default under `--yes`, else refuses naming its flag (and
 * `--yes` where it has a default); a job line needs `--yes` there, refused before any draft. Under
 * `--yes` or off a terminal, a job line that fails its checks refuses instead of asking again.
 * The file is checked as `validate` checks it before it is written, through a temporary file
 * linked into place so a setup that appeared meanwhile is never replaced without `--force`. Its
 * first line points an editor at the setup schema. After the file, a category setup gets the
 * `agentpicks init` command that writes the same setup in another repository; the last line says
 * how to run it: with --no-upload when nothing here can upload.
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
  activeEnvironments,
  setupEnvironments,
} from '../catalogue/environments';
import { checkSetupText, SETUPS_DIR } from '../setup/files';
import {
  SETUP_MAX_COMPETITORS,
  SETUP_REQUEST_MIN_LENGTH,
  SETUP_TEXT_MAX_LENGTH,
} from '../setup/rules';
import type { SetupFile } from '../setup/schema';
import { devtuneTarget } from './devtune-login';
import { UsageError } from './errors';
import { detectRepository } from './init-detect';
import { devtuneDrafting } from './init-draft';
import { askCustomJob } from './init-job-line';
import {
  ask,
  badLength,
  entries,
  pickKey,
  readGiven,
  refuseListNumbers,
  showNumbered,
  slug,
  withRanges,
  type Answer,
  type Question,
  type Wizard,
} from './init-wizard';
import type { CliContext } from './main';
import { SELF_RUN_AGENTS } from './self-run-agents';
import { SCHEMA_LINE, writeSetupText } from './setup-write';

/** What `parseInitArgs` read from init's flags. */
export type InitFlags = ReturnType<typeof parseInitArgs>;

/** `agentpicks init [--yes] [--force] [<flags>]`. `ask` reads one answer from the terminal. */
export async function initCommand(
  argv: string[],
  ctx: CliContext & { ask: (question: string) => Promise<string> },
): Promise<number> {
  const flags = parseInitArgs(argv);
  const { yes, force } = flags;
  const wizard: Wizard = {
    yes,
    interactive: Boolean(ctx.interactive),
    flags,
    cwd: ctx.cwd,
    ask: ctx.ask,
    out: ctx.out,
    err: ctx.err,
    detected: detectRepository(ctx.cwd, ctx.io),
    drafting: null,
    hinted: false,
  };
  checkFlags(wizard);

  const job = await askJob(wizard);
  let file: SetupFile;
  if ('category' in job) file = await askCategoryTools(wizard, job.category);
  else if (flags.tool !== undefined || flags.competitors !== undefined)
    throw jobLineFlagError(
      flags.tool !== undefined ? '--tool' : '--competitors',
      job.line,
    );
  else if (!yes && !wizard.interactive)
    // Refused before drafting, which counts against the project's hourly draft allowance.
    throw new UsageError(
      "agentpicks init can't ask a job line's requests and tools without a terminal, and they have no flags. Pass --yes to take DevTune's drafts, which needs a sign-in, or write the setup against agentpicks schema.",
    );
  else {
    wizard.drafting = devtuneDrafting(ctx.io, ctx.err);
    file = await askCustomJob(wizard, job.line);
  }
  Object.assign(file, await askTests(wizard, file.from));
  const agents = await ask(wizard, agentsQuestion(wizard));
  if (agents) file.agents = agents;
  const runs = await ask(wizard, runsQuestion(wizard));
  if (runs !== 1) file.runs = runs;

  const dir = join(wizard.detected.root, SETUPS_DIR);
  const text = `${SCHEMA_LINE}\n${stringify(file)}`;
  const name = await ask(
    wizard,
    nameQuestion(wizard, file.from ?? slug(file.job!), (answer) => {
      const checked = checkSetupText(setupPath(dir, answer), text);
      return checked.problems.length > 0
        ? {
            problem: checked.problems
              .map((p) => `${p.field}: ${p.message}`)
              .join('\n'),
          }
        : { value: answer };
    }),
  );
  const path = setupPath(dir, name);
  writeSetup(dir, path, text, force, ctx.cwd);

  const shown = relative(ctx.cwd, path) || path;
  ctx.out('');
  ctx.out(`Wrote ${shown}:`);
  ctx.out('');
  for (const line of text.trimEnd().split('\n').slice(1)) ctx.out(`  ${line}`);
  ctx.out('');
  if (file.from)
    ctx.out(
      `To write the same setup in another repository: ${initAgain(file, name)}`,
    );
  if (!file.agents)
    ctx.out(
      'It names no agents, so run uses the one agent installed where it runs.',
    );
  const custom = checkSetupText(path, text).setup!.customReason !== null;
  if (ctx.io.env.AGENTPICKS_NO_UPLOAD)
    ctx.out(`Run it with: agentpicks run ${name}`);
  else if (!signedIn(ctx.io)) {
    ctx.out(`Run it with: agentpicks run ${name} --no-upload`);
    ctx.out(
      `That needs no DevTune account. To upload its runs to DevTune, sign in with agentpicks login${custom ? `, then run agentpicks push ${name}` : ''}.`,
    );
  } else
    ctx.out(
      custom
        ? `To upload its runs, first run: agentpicks push ${name}, then agentpicks run ${name}. To keep bundles on this machine only, run: agentpicks run ${name} --no-upload.`
        : `Run it with: agentpicks run ${name}`,
    );
  return 0;
}

/**
 * Whether `run` would upload here without --no-upload. Any refusal (no sign-in, or an API address
 * or key that doesn't read) means it wouldn't, and the file is already written, so none fails init.
 */
function signedIn(io: CliContext['io']): boolean {
  try {
    devtuneTarget(io);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `agentpicks init` command that writes a category setup `file` again with no questions: each
 * answer as its flag, with `--yes`, in any repository. It leaves out --competitors for all and
 * --runs for 1, and gives no tool as --tool none, since --yes would take a tool the repository
 * names. Every value is a key, slug, alias, number or setup name, so it pastes into a shell as
 * printed.
 */
function initAgain(file: SetupFile, name: string) {
  const { own, competitors } = file.tools ?? {};
  return [
    'agentpicks init',
    `--category ${file.from}`,
    `--tool ${typeof own === 'string' ? own : 'none'}`,
    ...(competitors ? [`--competitors ${competitors.join(',')}`] : []),
    ...(file.repo
      ? ['--repo .']
      : (file.stacks ?? []).map((stack) => `--stack ${stack}`)),
    ...(file.agents ?? ['any']).map((agent) => `--agent ${agent}`),
    ...(file.runs ? [`--runs ${file.runs}`] : []),
    `--name ${name}`,
    '--yes',
  ].join(' ');
}

function parseInitArgs(argv: string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        yes: { type: 'boolean', short: 'y', default: false },
        force: { type: 'boolean', default: false },
        category: { type: 'string' },
        job: { type: 'string' },
        tool: { type: 'string' },
        competitors: { type: 'string' },
        repo: { type: 'string' },
        stack: { type: 'string', multiple: true, default: [] },
        agent: { type: 'string', multiple: true, default: [] },
        runs: { type: 'string' },
        name: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (values.category !== undefined && values.job !== undefined)
    throw new UsageError(
      'Pass --category or --job, not both: a setup tests a category or a job line of its own.',
    );
  if (values.repo !== undefined && values.stack.length > 0)
    throw new UsageError(
      'Pass --repo or --stack, not both: a setup tests this repository or stacks.',
    );
  if (values.repo !== undefined && values.repo !== '.')
    throw new UsageError(
      `--repo takes only . (this repository's committed files), not ${values.repo}.`,
    );
  if (values.stack.some((stack) => entries(stack).includes('.')))
    throw new UsageError(
      "--stack takes stack slugs. To test this repository's committed files, pass --repo .",
    );
  return values;
}

/** The refusal shared by an explicit job line and one typed at the prompt. */
function jobLineFlagError(flag: '--tool' | '--competitors', line: string) {
  return new UsageError(
    `${flag} answers a category's questions, and ${line} is a job line. Pass --category, or leave it out.`,
  );
}

/**
 * Refuses, before anything is listed, asked or drafted, a flag whose value doesn't read. Each
 * question's own read checks it. Without the job, --tool, --competitors and --stack are checked
 * only for list numbers, and --stack for a slug no stack has; their checks against the job wait
 * for its question, and so does a check against another question's answer, such as a competitor
 * that is the tool this repository names. --name's exists check runs here, its setup checks at
 * its question.
 */
function checkFlags(wizard: Wizard) {
  const read = <T>(question: Question<T>) =>
    question.given === undefined
      ? undefined
      : readGiven({ ...question, given: question.given });
  const job = read(jobQuestion(wizard));
  const { tool, competitors, stack } = wizard.flags;
  if (job && 'category' in job) {
    const own = read(toolQuestion(wizard, job.category));
    read(competitorsQuestion(wizard, job.category, own ?? null));
  } else
    for (const [flag, value] of [
      ['--tool', tool],
      ['--competitors', competitors],
    ] as const)
      if (value !== undefined) {
        if (job && 'line' in job) throw jobLineFlagError(flag, job.line);
        refuseListNumbers(flag, value, 'agentpicks catalogue <category>');
      }
  if (job && stack.length > 0)
    read(testsQuestion(wizard, 'category' in job ? job.category : undefined));
  else if (stack.length > 0) {
    const given = stack.join(',');
    const choices = activeEnvironments().map((env) => env.slug);
    const keys = `${choices.join(', ')}, or all`;
    refuseListNumbers('--stack', given, keys);
    const unknown = entries(given).find(
      (slug) => slug !== 'all' && !choices.includes(slug),
    );
    if (unknown !== undefined)
      throw new UsageError(
        `--stack: ${unknown} isn't a stack. Give one of: ${keys}.`,
      );
  }
  read(agentsQuestion(wizard));
  read(runsQuestion(wizard));
  read(nameQuestion(wizard, null, (answer) => ({ value: answer })));
}

/** The job: a built-in category by number or slug, or a job line of its own. */
async function askJob(
  wizard: Wizard,
): Promise<{ category: string } | { line: string }> {
  const question = jobQuestion(wizard);
  showNumbered(
    wizard,
    question.given,
    "DevTune's public categories. Choose one to write a setup that runs its tests on this machine:",
    CATEGORY_REQUESTS.map((category) => category.name),
  );
  return ask(wizard, question);
}

/** The job question. `--category` must read as a category, and `--job` as a job line. */
function jobQuestion(
  wizard: Wizard,
): Question<{ category: string } | { line: string }> {
  const detected = wizard.detected.tool?.categories[0];
  const index = CATEGORY_REQUESTS.findIndex((c) => c.slug === detected);
  const { category, job } = wizard.flags;
  return {
    label: 'Category number, or your own job line',
    fallback: index >= 0 ? String(index + 1) : null,
    missing:
      "can't choose a job: neither package.json nor the git remote names a catalogue tool. Run agentpicks init on a terminal to choose one.",
    flag:
      category !== undefined
        ? '--category'
        : job !== undefined
          ? '--job'
          : '--category or --job',
    given: category ?? job,
    keys: category !== undefined ? 'agentpicks catalogue' : undefined,
    read: (answer, flag) => {
      const read = readJob(answer, flag);
      if (
        category !== undefined &&
        !('value' in read && 'category' in read.value)
      )
        return { problem: `There is no category ${answer}.` };
      if ('problem' in read) return read;
      if (job !== undefined && 'category' in read.value)
        return {
          problem: `${answer} names a category. Pass it as --category ${read.value.category}.`,
        };
      return read;
    },
  };
}

/**
 * Reads a job answer: a category number or slug, or a job line of its own. A flag's refusal
 * (`flag`) asks for a job line alone, since a flag takes no list number.
 */
function readJob(
  answer: string,
  flag: boolean,
): Answer<{ category: string } | { line: string }> {
  const count = CATEGORY_REQUESTS.length;
  const line = `${flag ? 'Write' : `Choose a category from 1 to ${count}, or write`} the job as a line of ${SETUP_REQUEST_MIN_LENGTH} to ${SETUP_TEXT_MAX_LENGTH} characters, such as Add feature flags.`;
  if (/^\d+$/.test(answer)) {
    const category = CATEGORY_REQUESTS[Number(answer) - 1];
    return category
      ? { value: { category: category.slug } }
      : {
          problem: flag
            ? line
            : `Choose a category from 1 to ${count}, or write a job line.`,
        };
  }
  const category = findCategoryRequests(answer);
  if (category) return { value: { category: category.slug } };
  if (
    !/\s/.test(answer) ||
    // A new job line meets a request's length; the guard is resolveSetup's, which names the field.
    badLength(answer)
  )
    return { problem: line };
  return { value: { line: answer } };
}

/** A category setup's tools: its own tool and competitors, each a key of the category. */
async function askCategoryTools(
  wizard: Wizard,
  category: string,
): Promise<SetupFile> {
  const { tool, competitors: rivals } = wizard.flags;
  // The tools list serves both questions, so it shows while either is asked.
  showNumbered(
    wizard,
    tool !== undefined && rivals !== undefined ? tool : undefined,
    `${findCategoryRequests(category)?.name ?? category} tools DevTune tests:`,
    CATEGORY_TOOLS[category] ?? [],
  );
  const own = await ask(wizard, toolQuestion(wizard, category));
  const competitors = await ask(
    wizard,
    competitorsQuestion(wizard, category, own),
  );
  const tools = {
    ...(own ? { own } : {}),
    ...(competitors ? { competitors } : {}),
  };
  return { from: category, ...(own || competitors ? { tools } : {}) };
}

/** Your tool: a key of the category's tools, or none. */
function toolQuestion(
  wizard: Wizard,
  category: string,
): Question<string | null> {
  const keys = CATEGORY_TOOLS[category] ?? [];
  return {
    label: 'Your tool: its number, or none',
    fallback: toolDefault(wizard, category),
    flag: '--tool',
    given: wizard.flags.tool,
    keys: `agentpicks catalogue ${category}`,
    read: (answer, flag) => {
      if (answer === 'none') return { value: null };
      const key = pickKey(answer, keys);
      return key
        ? { value: key }
        : {
            problem: `${answer} isn't on the list. Give ${flag ? 'a tool key' : `a number from 1 to ${keys.length}`}, or none.`,
          };
    },
  };
}

/** Competitors: keys of the category's tools other than `own`, or null for all. */
function competitorsQuestion(
  wizard: Wizard,
  category: string,
  own: string | null,
): Question<string[] | null> {
  const keys = CATEGORY_TOOLS[category] ?? [];
  return {
    label:
      'Competitors: their numbers or ranges separated by commas (2, 5-8), or all',
    fallback: 'all',
    flag: '--competitors',
    given: wizard.flags.competitors,
    keys: `agentpicks catalogue ${category}`,
    read: (answer, flag): Answer<string[] | null> => {
      if (answer === 'all') return { value: null };
      const give = `Give ${flag ? 'tool keys' : `numbers from 1 to ${keys.length}`}, or all.`;
      const chosen: string[] = [];
      const given = withRanges(answer, keys.length);
      if (given.length === 0) return { problem: give };
      for (const entry of given) {
        const key = pickKey(entry, keys);
        if (!key) return { problem: `${entry} isn't on the list. ${give}` };
        if (key === own)
          return {
            problem:
              wizard.yes && wizard.flags.tool === undefined
                ? `${own} is your tool, as this repository names it. Pass --tool none, or leave ${own} out.`
                : `${own} is your tool. List only competitors.`,
          };
        if (!chosen.includes(key)) chosen.push(key);
      }
      return chosen.length > SETUP_MAX_COMPETITORS
        ? {
            problem: `List at most ${SETUP_MAX_COMPETITORS} competitors, or all.`,
          }
        : { value: chosen };
    },
  };
}

/** The tool question's default: the tool this repository names, when it's one of the category's. */
function toolDefault(wizard: Wizard, category: string): string {
  const detected = wizard.detected.tool?.key;
  return detected && (CATEGORY_TOOLS[category] ?? []).includes(detected)
    ? detected
    : 'none';
}

/**
 * Where a run tests: the repository (`repo: .`, answered `repo` or `.`), every stack the job runs in
 * (`all`), or stacks by number, range or slug. The default is the repository when it has a commit,
 * else the stacks detected.
 */
async function askTests(
  wizard: Wizard,
  from: string | undefined,
): Promise<Pick<SetupFile, 'repo' | 'stacks'>> {
  const question = testsQuestion(wizard, from);
  showNumbered(
    wizard,
    question.given,
    'Stacks: starter apps a run can build in instead of this repository:',
    setupEnvironments(from ?? 'job-').map((env) => env.name),
    1,
  );
  return ask(wizard, question);
}

/** Where to test, for a setup `from` a category, or a job line when undefined. */
function testsQuestion(
  wizard: Wizard,
  from: string | undefined,
): Question<Pick<SetupFile, 'repo' | 'stacks'>> {
  const choices = setupEnvironments(from ?? 'job-').map((env) => env.slug);
  const { hasCommit, stacks, root } = wizard.detected;
  const detected = stacks.filter((stack) => choices.includes(stack));
  const { repo, stack } = wizard.flags;
  return {
    label:
      'Where to test: this repository (repo), all stacks (all), or stack numbers or ranges separated by commas (1, 3-4)',
    fallback: hasCommit ? 'repo' : detected.join(', ') || null,
    missing: `found nothing to test in ${root}: agentpicks couldn't confirm a commit there, and no package.json or lockfile there names a framework of a stack (${choices.join(', ')}). Run it on a terminal to choose stacks.`,
    flag:
      repo !== undefined
        ? '--repo'
        : stack.length > 0 || !hasCommit
          ? '--stack'
          : '--repo . or --stack',
    given: repo ?? (stack.length > 0 ? stack.join(',') : undefined),
    keys:
      repo === undefined
        ? `agentpicks catalogue${from ? ` ${from}` : ''}`
        : undefined,
    read: (answer, flag): Answer<Pick<SetupFile, 'repo' | 'stacks'>> => {
      if (answer === '.' || (!flag && answer === 'repo'))
        return { value: { repo: '.' } };
      if (answer === 'all') return { value: { stacks: choices } };
      const given = withRanges(answer, choices.length);
      const chosen = [
        ...new Set(given.map((entry) => pickKey(entry, choices))),
      ];
      const unknown = given.find((entry) => !pickKey(entry, choices));
      if (given.length === 0 || unknown)
        return {
          problem: `${unknown ?? 'Nothing'} isn't a stack ${from ? `for ${from}` : 'for your own job'}. Give ${flag ? 'stack slugs, or all' : `repo, all, or numbers from 1 to ${choices.length}`}.`,
        };
      return { value: { stacks: chosen.filter((stack) => stack !== null) } };
    },
  };
}

/** The agents to test: those installed and signed in here, or null to leave it to the machine that runs it. */
function agentsQuestion(wizard: Wizard): Question<string[] | null> {
  return {
    label: 'Agents separated by commas, or any',
    fallback: wizard.detected.agents.join(', ') || 'any',
    flag: '--agent',
    given:
      wizard.flags.agent.length > 0 ? wizard.flags.agent.join(',') : undefined,
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
  };
}

function runsQuestion(wizard: Wizard): Question<number> {
  return {
    label: 'Runs per agent and stack',
    fallback: '1',
    flag: '--runs',
    given: wizard.flags.runs,
    read: (answer) =>
      /^[1-9]\d*$/.test(answer) && Number(answer) <= 100
        ? { value: Number(answer) }
        : { problem: 'Give a whole number of runs, 1 to 100.' },
  };
}

/**
 * The setup's name: its shape, then that no setup of that name exists unless --force, then
 * `written`'s checks of the file it would be.
 */
function nameQuestion(
  wizard: Wizard,
  fallback: string | null,
  written: (name: string) => Answer<string>,
): Question<string> {
  return {
    label: `Setup name, saved as ${SETUPS_DIR}/<name>.yaml`,
    fallback,
    flag: '--name',
    given: wizard.flags.name,
    read: (answer) => {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(answer))
        return {
          problem:
            'A name is lowercase letters, digits and hyphens, such as error-tracking.',
        };
      const path = setupPath(join(wizard.detected.root, SETUPS_DIR), answer);
      if (existsSync(path) && !wizard.flags.force)
        return {
          problem: `${relative(wizard.cwd, path)} exists. Choose another name, or pass --force to replace it.`,
        };
      return written(answer);
    },
  };
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
