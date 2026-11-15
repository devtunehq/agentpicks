/**
 * ABOUTME: Turns a parsed setup file into what a run tests, checked against the catalogue: `from`
 * inherits a built-in category's job, requests and early stop; a tool key must be a tool of DevTune's
 * catalogue (one this version knows, or one the linked DevTune setup holds without signals), whose
 * signals DevTune holds, so a run here recognises it only through its `from` category's early stop,
 * and a copy names one its category doesn't measure only once the copy holds it; full tool entries add their package and config names to the early stop, as
 * a job's tools do in a managed run; stacks must run in the category, or in any job without one. A
 * setup that is its category as published (no requests or tools of its own) uploads as that
 * category; any other is custom. The app's rules hold too: no `yieldsTo` loop, and no request naming a tool it measures.
 * Every problem names the field and the fix.
 */
import {
  CATEGORY_REQUESTS,
  findCategoryRequests,
  type CategoryRequests,
} from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import type { EarlyStopPatterns } from '../catalogue/early-stop';
import {
  ENVIRONMENTS,
  environmentRunsIn,
  findEnvironment,
  isRetiredEnvironment,
  type EnvironmentDefinition,
} from '../catalogue/environments';
import { PROMPT_INTENTS } from '../catalogue/prompt-intents';
import {
  SETUP_MAX_OWN_SIGNAL_TOOLS,
  type SetupFile,
  type SetupToolEntry,
  type SetupToolRef,
} from './schema';

/** A problem with one field of a setup file; `field` is its path, such as `tools.competitors[1]`. */
export interface SetupProblem {
  field: string;
  message: string;
}

/** A setup file resolved against the catalogue, ready to plan runs from. */
export interface ResolvedSetup {
  name: string;
  id: string | null;
  /** What pull or push last saw, for a linked file. */
  synced: { setup: string; file: string } | null;
  from: string | null;
  /** The job line: the file's, or its `from` category's name. */
  job: string;
  /**
   * The category the setup's runs record and upload as: `from` for a setup that is its category as
   * published, else null (a custom setup: its own job, or `from` with requests or tools of its own).
   */
  category: CategoryRequests | null;
  /** What the run asks: the file's `add` request, or its category's. */
  request: { intent: 'add'; text: string };
  /** What the early-stop watcher treats as a pick having landed. */
  earlyStop: EarlyStopPatterns;
  /** Why the setup is custom, for the upload refusal; null when it isn't. */
  customReason: string | null;
  /**
   * The catalogue tools it measures that its early stop doesn't hold (every key in a setup without
   * `from`, and any the linked DevTune setup measures beside your tool and competitors), whose picks
   * only DevTune, which holds their signals, can read.
   */
  unrecognised: string[];
  stacks: EnvironmentDefinition[] | null;
  /** The repository path, relative to the file's repository root, and the commit to test. */
  repo: { path: string; ref?: string } | null;
  agents: string[] | null;
  runs: number | null;
}

/**
 * A tool the file's linked DevTune setup holds, as DevTune sends it: a catalogue tool with null
 * signals, since DevTune keeps those.
 */
export interface HeldTool {
  tool_key: string;
  display_name: string;
  signals: Record<string, unknown> | null;
}

/** Every tool key in DevTune's catalogue that this version knows. */
const CATALOGUE_KEYS = new Set(Object.values(CATEGORY_TOOLS).flat());

/** A watcher pattern that never matches: its input is normalised to have no underscores. */
export const NEVER_PATTERN = '__no-pick__';

/**
 * `held` is what the file's linked DevTune setup holds, when DevTune was read: a key DevTune sent
 * without signals is a catalogue tool even if this version doesn't know it, and a copy may name a
 * catalogue tool its category doesn't measure only if the copy holds it. Unread (undefined), a
 * linked copy's catalogue keys are left for push to check against DevTune.
 */
export function resolveSetup(
  name: string,
  file: SetupFile,
  held?: readonly HeldTool[],
): { setup: ResolvedSetup; problems: [] } | { problems: SetupProblem[] } {
  const problems: SetupProblem[] = [];
  const category = file.from ? findCategoryRequests(file.from) : undefined;
  if (!file.from && !file.job)
    problems.push({
      field: 'job',
      message:
        'Give the job line, or inherit a built-in category with from: (one of ' +
        `${CATEGORY_REQUESTS.map((c) => c.slug).join(', ')}).`,
    });
  const add =
    file.requests?.add === null
      ? undefined
      : (file.requests?.add ?? category?.prompts[0].text);
  if (!add)
    problems.push({
      field: 'requests.add',
      message:
        file.requests?.add === null
          ? "A run asks the add request, so it can't be left out. Give it, or delete the line to inherit from:'s."
          : 'Give the add request, the one a run asks, or inherit it with from:.',
    });
  if (file.stacks && file.repo)
    problems.push({
      field: 'repo',
      message:
        'Give stacks or repo, not both: a run tests starters or your repository.',
    });

  const tools = toolRefs(file);
  if (!file.from && tools.length === 0)
    problems.push({
      field: 'tools',
      message:
        "Give your tool under tools.own, or competitors under tools.competitors, each with its signals or, for a tool in DevTune's catalogue, by its key, so a run can recognise a pick.",
    });
  const catalogueKeys = file.from ? (CATEGORY_TOOLS[file.from] ?? []) : [];
  for (const { ref, field } of tools) {
    if (typeof ref !== 'string') {
      if (!hasSignal(ref))
        problems.push({
          field: `${field}.signals`,
          message: `Give ${ref.name} at least one package, config name or pattern, so a run can recognise it.`,
        });
      if (catalogueKeys.includes(ref.key))
        problems.push({
          field: `${field}.key`,
          message: `${file.from} already has a tool ${ref.key}. Name it by its key alone (${ref.key}), or give your entry another key.`,
        });
      continue;
    }
    const row = held?.find((each) => each.tool_key === ref);
    if (file.from) {
      // A copy measures another catalogue tool only once it is added in the DevTune app.
      const unchecked = !held && file.id && CATALOGUE_KEYS.has(ref);
      if (!catalogueKeys.includes(ref) && !row && !unchecked)
        problems.push({
          field,
          message: `${file.from} has no tool ${ref}. Use one of ${catalogueKeys.join(', ')}, or add ${ref} to a category copy in the DevTune app, then run agentpicks pull.`,
        });
    } else if (!CATALOGUE_KEYS.has(ref) && row?.signals !== null)
      problems.push({
        field,
        message: row
          ? `${ref} is a tool of your own, which a file gives in full. Run agentpicks pull to write its entry, or give the full entry: key, name and signals, and optionally domain.`
          : `${ref} isn't a tool in this version of agentpicks' catalogue. Give the full entry: key, name and signals, and optionally domain; or, for a tool DevTune's catalogue has added since, update agentpicks.`,
      });
  }
  const entries = tools.flatMap(({ ref }) =>
    typeof ref === 'string' ? [] : [ref],
  );
  if (entries.length > SETUP_MAX_OWN_SIGNAL_TOOLS)
    problems.push({
      field: 'tools',
      message: `A setup holds at most ${SETUP_MAX_OWN_SIGNAL_TOOLS} tools with their own signals; it has ${entries.length}.`,
    });
  const keys = tools.map(({ ref }) =>
    typeof ref === 'string' ? ref : ref.key,
  );
  const repeated = keys.find((key, i) => keys.indexOf(key) !== i);
  if (repeated)
    problems.push({
      field: 'tools',
      message: `${repeated} is listed more than once. List each tool once, as own or as a competitor.`,
    });
  if (hasYieldsCycle(entries))
    problems.push({
      field: 'tools',
      message:
        "Tools' yieldsTo loop back on themselves, so no run could be classified. Remove a yieldsTo from the loop.",
    });
  for (const [field, text] of [
    ['job', file.job] as const,
    ...PROMPT_INTENTS.map(
      (intent) => [`requests.${intent}`, file.requests?.[intent]] as const,
    ),
  ]) {
    const refusal = text == null ? undefined : requestRefusal(text);
    if (refusal) problems.push({ field, message: refusal });
  }
  for (const intent of PROMPT_INTENTS) {
    const text = file.requests?.[intent];
    const named =
      text &&
      [
        ...entries.map((tool) => ({
          name: tool.name,
          words: entryWords(tool),
        })),
        // A tool by key: its key, and the name DevTune gives it, where DevTune sent one.
        ...tools.flatMap(({ ref }) => {
          if (typeof ref !== 'string') return [];
          const shown = held?.find(
            (each) => each.tool_key === ref,
          )?.display_name;
          return [
            { name: shown ?? ref, words: [ref, ...(shown ? [shown] : [])] },
          ];
        }),
      ].find((tool) => namesWord(text, tool.words));
    if (named)
      problems.push({
        field: `requests.${intent}`,
        message: `It names ${named.name}, a tool this setup measures, so a run would test that name, not the job. Reword it without the tool.`,
      });
  }
  // Earlier listings ask for the same agent or stack again, which would double the runs and their cost.
  for (const field of ['stacks', 'agents'] as const) {
    const list: readonly string[] = file[field] ?? [];
    list.forEach((value, i) => {
      if (list.indexOf(value) !== i)
        problems.push({
          field: `${field}[${i}]`,
          message: `${value} is listed more than once. List each once.`,
        });
    });
  }

  const runsIn = file.from ?? 'job-';
  const stacks = (file.stacks ?? []).map((slug, i) => {
    const environment = findEnvironment(slug);
    if (
      !environment ||
      isRetiredEnvironment(slug) ||
      !environmentRunsIn(slug, runsIn)
    ) {
      problems.push({
        field: `stacks[${i}]`,
        message: `${slug} doesn't run ${file.from ? `in ${file.from}` : 'a setup without from'}. Use one of ${stackChoices(runsIn)}.`,
      });
      return null;
    }
    return environment;
  });

  const unrecognised = [
    ...keys.filter(
      (key, i) =>
        typeof tools[i]!.ref === 'string' && !catalogueKeys.includes(key),
    ),
    // A catalogue tool the linked setup measures that is neither yours nor a competitor, which a
    // file can't name: a run here can't recognise it either.
    ...(held ?? [])
      .filter(
        (row) =>
          row.signals === null &&
          !keys.includes(row.tool_key) &&
          !catalogueKeys.includes(row.tool_key),
      )
      .map((row) => row.tool_key),
  ];
  const customReason = file.from
    ? editedReason(category!, file, entries, unrecognised)
    : 'it has its own job';
  if (customReason && findCategoryRequests(name))
    problems.push({
      field: '(file)',
      message: `A custom setup can't share its name with the built-in category ${name}. Rename the file.`,
    });
  const earlyStop = mergeEarlyStop(category?.earlyStop, entries, [
    ...catalogueKeys,
    ...keys,
  ]);
  // A tool by key has no signals here, so a setup with one can't need its entries to stop early.
  if (
    !file.from &&
    entries.length > 0 &&
    unrecognised.length === 0 &&
    earlyStop.installPattern === NEVER_PATTERN &&
    earlyStop.codePattern === NEVER_PATTERN
  )
    problems.push({
      field: 'tools',
      message:
        "Give at least one tool a package or config name under signals, so a run can tell that a pick landed. A tool that yields to another tool in the setup doesn't count.",
    });

  if (problems.length > 0) return { problems };

  return {
    problems: [],
    setup: {
      name,
      id: file.id ?? null,
      synced: file.synced ?? null,
      from: file.from ?? null,
      job: file.job ?? category!.name,
      category: customReason === null ? category! : null,
      request: { intent: 'add', text: add! },
      earlyStop,
      customReason,
      unrecognised,
      stacks: file.stacks
        ? stacks.filter((env): env is EnvironmentDefinition => env !== null)
        : null,
      repo:
        file.repo === undefined
          ? null
          : typeof file.repo === 'string'
            ? { path: file.repo }
            : file.repo,
      agents: file.agents ?? null,
      runs: file.runs ?? null,
    },
  };
}

function toolRefs(file: SetupFile): { ref: SetupToolRef; field: string }[] {
  return [
    ...(file.tools?.own === undefined
      ? []
      : [{ ref: file.tools.own, field: 'tools.own' }]),
    ...(file.tools?.competitors ?? []).map((ref, i) => ({
      ref,
      field: `tools.competitors[${i}]`,
    })),
  ];
}

function hasSignal(entry: SetupToolEntry): boolean {
  const s = entry.signals;
  return [
    s.packages?.npm,
    s.packages?.pypi,
    s.packages?.gem,
    s.configNames,
    s.importPatterns,
    s.commandPatterns,
    s.configFiles,
    s.configPatterns,
    s.selfHosted,
  ].some((list) => (list?.length ?? 0) > 0);
}

/**
 * Why a setup `from` a category isn't that category as published, or null when it is: a request
 * worded differently or left out, a tool with its own signals, or a catalogue tool the category
 * doesn't measure (`added`). Naming which of the category's tools are yours and which compete
 * changes nothing a run asks or recognises, so it isn't an edit.
 */
function editedReason(
  category: CategoryRequests,
  file: SetupFile,
  entries: SetupToolEntry[],
  added: string[],
): string | null {
  for (const intent of PROMPT_INTENTS) {
    const text = file.requests?.[intent];
    const published = category.prompts.find((p) => p.intent === intent)?.text;
    if (text === undefined || (text === null && !published)) continue;
    if (text === null)
      return `it leaves out ${category.slug}'s ${intent} request`;
    if (text !== published)
      return `its ${intent} request isn't ${category.slug}'s`;
  }
  if (entries.length > 0)
    return `it gives ${entries.map((e) => e.key).join(', ')} signals of its own`;
  if (added.length > 0)
    return `it measures ${added.join(', ')}, which ${category.slug} doesn't`;
  return null;
}

function stackChoices(runsIn: string): string {
  return ENVIRONMENTS.filter(
    (env) =>
      !isRetiredEnvironment(env.slug) && environmentRunsIn(env.slug, runsIn),
  )
    .map((env) => env.slug)
    .join(', ');
}

/** A literal for a POSIX extended regex, which JavaScript's reads the same. */
const escapeEre = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The watcher's form of a package name: quoted, lowercase, `_` as `-`, as it normalises manifest
 * entries. A prefix (`@clerk/`, `omniauth*`) keeps its closing quote off.
 */
function watchedPackage(name: string): string {
  const prefix = name.endsWith('/') || name.endsWith('*');
  const normalised = name.replace(/\*$/, '').toLowerCase().replace(/_/g, '-');
  return `"${escapeEre(normalised)}${prefix ? '' : '"'}`;
}

/**
 * The category's early stop, if any, with the package and config names of the setup's own tools
 * (`entries`) added, as a managed run derives a job's (`jobCategorySignals`): a tool that yields to
 * another tool in the setup (`listedKeys`: every key it lists, and its category's) can't start it.
 * The schema has already refused a name the watcher can't carry.
 */
export function mergeEarlyStop(
  base: EarlyStopPatterns | undefined,
  entries: readonly Pick<SetupToolEntry, 'key' | 'signals'>[],
  listedKeys: readonly string[],
): EarlyStopPatterns {
  const stopping = entries.filter(
    (tool) => !tool.signals.yieldsTo?.some((key) => listedKeys.includes(key)),
  );
  const unique = (names: string[]) => [...new Set(names)];
  const packages = unique(
    stopping.flatMap((tool) => [
      ...(tool.signals.packages?.npm ?? []),
      ...(tool.signals.packages?.pypi ?? []),
      ...(tool.signals.packages?.gem ?? []),
    ]),
  ).map(watchedPackage);
  const configNames = unique(
    stopping.flatMap((tool) => tool.signals.configNames ?? []),
  ).map(escapeEre);
  const join = (inherited: string | undefined, added: string[]) =>
    [inherited, ...added].filter(Boolean).join('|') || NEVER_PATTERN;
  return {
    installPattern: join(base?.installPattern, packages),
    codePattern: join(base?.codePattern, configNames),
    ...(base?.pathPattern ? { pathPattern: base.pathPattern } : {}),
  };
}

/**
 * Whether the tools' `yieldsTo` loop back on themselves, through any number of tools, a tool
 * yielding to itself included, as the app refuses. Keys of tools not in the list are ignored.
 */
function hasYieldsCycle(entries: readonly SetupToolEntry[]): boolean {
  const edges = new Map(
    entries.map((tool) => [tool.key, tool.signals.yieldsTo ?? []]),
  );
  const done = new Set<string>();
  const visiting = new Set<string>();
  const cycles = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (done.has(key) || !edges.has(key)) return false;
    visiting.add(key);
    const found = edges.get(key)!.some(cycles);
    visiting.delete(key);
    done.add(key);
    return found;
  };
  return entries.some((tool) => cycles(tool.key));
}

/**
 * Shapes DevTune refuses in a job line or request (`requestProblem` in the app): a link or domain, code characters
 * or an environment reference, and an env-style name. An agent reads a request as an instruction, with keys in its
 * environment. Words aren't refused: a job can be about secrets.
 */
const REQUEST_REFUSALS: readonly [RegExp, string][] = [
  [
    /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|io|dev|ai|net|org|app|co|sh|xyz)\b/iu,
    'It holds a link or domain, which DevTune refuses in a request. Name the job without it.',
  ],
  [
    /[$`|<>{};\\]|\b(?:process\.env|os\.environ|getenv|printenv|ENV\[)/iu,
    'It holds code characters or an environment reference, which DevTune refuses in a request. Describe the job in words.',
  ],
  [
    /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u,
    'It holds an environment variable name, which DevTune refuses in a request. Describe the job in words.',
  ],
];

/** Why DevTune would refuse the job line or request, or undefined when it takes it. */
function requestRefusal(text: string): string | undefined {
  return REQUEST_REFUSALS.find(([pattern]) => pattern.test(text))?.[1];
}

/** The words that name a full entry, as the app's `names_tool` rail reads them: its name, aliases and domains. */
function entryWords(tool: SetupToolEntry): string[] {
  return [
    tool.name,
    ...(tool.signals.aliases ?? []),
    ...(tool.signals.brandDomains ?? []),
    ...(tool.domain ? [tool.domain] : []),
  ];
}

/** Whether `text` holds one of `words` standing as a word (no letter or digit touching either end), without case. */
function namesWord(text: string, words: readonly string[]): boolean {
  return words.some(
    (word) =>
      word.trim() !== '' &&
      new RegExp(
        `(^|[^\\p{L}\\p{N}])${escapeEre(word.trim())}($|[^\\p{L}\\p{N}])`,
        'iu',
      ).test(text),
  );
}
