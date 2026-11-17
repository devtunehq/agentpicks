/**
 * ABOUTME: What `agentpicks push` sends for a setup file: a category file saves through the setup
 * route until it adds a tool or edits its signals, when the job route saves its category copy with the
 * inherited requests and tools. A job also uses the job route. Each carries the digest the file
 * last saw (null for a new setup), so DevTune refuses concurrent changes as setup_changed. Models
 * stay as DevTune holds them; a copy keeps every tool it holds, and a job drops one its file stops
 * selecting. Copies omit building blocks to keep their inherited
 * or saved recognition; blank jobs send the blocks DevTune lists. Catalogue tools go by key and
 * the job save fills in their signals; customer-authored tools carry their full entries. A file
 * linked to a public-category setup must use a project copy before adding tools.
 */
import { findCategoryRequests } from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import { PROMPT_INTENTS } from '../catalogue/prompt-intents';
import {
  canonical,
  devtuneAgent,
  fileTool,
  nameableStack,
} from '../setup/link';
import { CATALOGUE_TOOL_KEYS, SETUP_MAX_COMPETITORS } from '../setup/rules';
import type { SetupFile, SetupToolEntry, SetupToolRef } from '../setup/schema';
import type { DevtuneSetup, DevtuneSetupList } from './devtune-setups';
import { UsageError } from './errors';
import { SELF_RUN_AGENTS } from './self-run-agents';

export interface PushRequest {
  route: 'job' | 'setup';
  body: Record<string, unknown>;
}

/** The job save's empty building blocks, for a new job. */
const NO_BUILDING_BLOCKS = { packages: {}, codePatterns: [] };

/**
 * The request that saves `file` as `current` (null for a new setup), or a UsageError naming what
 * the file must say first. `shown` names the file in messages; `repositoryStacks` supplies detected
 * stacks for a new repository file without changing where its runs test.
 */
export function pushRequest(
  file: SetupFile,
  current: DevtuneSetup | null,
  list: DevtuneSetupList,
  shown: string,
  repositoryStacks?: string[],
): PushRequest {
  const from = file.from ? findCategoryRequests(file.from) : undefined;
  const runsIn = from?.slug ?? 'job-';
  const tools = [
    ...(file.tools?.own !== undefined ? [file.tools.own] : []),
    ...(file.tools?.competitors ?? []),
  ];
  const key = (ref: SetupToolRef) => (typeof ref === 'string' ? ref : ref.key);
  // A customer's setup tracks at most six competitors; only one DevTune already holds with more, a public board, keeps
  // them.
  const competitors = file.tools?.competitors?.length ?? 0;
  if (
    competitors > SETUP_MAX_COMPETITORS &&
    (current?.competitor_tool_keys.length ?? 0) <= SETUP_MAX_COMPETITORS
  )
    throw new UsageError(
      `${shown}: a setup tracks at most ${SETUP_MAX_COMPETITORS} competitors, and tools.competitors lists ${competitors}. Remove ${competitors - SETUP_MAX_COMPETITORS}, then push again.`,
    );
  const shared = {
    environment_ids: environmentIds(
      file,
      current,
      list,
      runsIn,
      shown,
      repositoryStacks,
    ),
    agent_models: agentModels(file, current, list, shown),
    snapshot_digest: current ? (file.synced?.setup ?? null) : null,
    ...(current ? { setup: current.id } : {}),
  };
  if (from) {
    const named = [
      ...(file.tools?.own !== undefined
        ? [{ ref: file.tools.own, field: 'tools.own' }]
        : []),
      ...(file.tools?.competitors ?? []).map((ref, index) => ({
        ref,
        field: `tools.competitors[${index}]`,
      })),
    ];
    for (const { ref, field } of named)
      if (
        typeof ref !== 'string' &&
        CATALOGUE_TOOL_KEYS.has(ref.key) &&
        !heldAsWritten(ref, current)
      )
        throw new UsageError(
          `${shown}: ${field}: ${ref.key} is a catalogue tool. Use the key alone (${ref.key}), so pull and push keep the same tool.`,
        );
  }
  const writesCopy =
    from &&
    tools.some((ref) =>
      typeof ref === 'string'
        ? !CATEGORY_TOOLS[from.slug]?.includes(ref) &&
          !current?.tools.some((row) => row.tool_key === ref)
        : !heldAsWritten(ref, current),
    );
  if (writesCopy && current?.kind === 'category')
    throw new UsageError(
      `${shown}: this file is linked to a public-category setup, which can't add tools through push. Create a category copy in the DevTune app, pull that copy, then add your tools to its file and push again.`,
    );
  if (from && !writesCopy) {
    return {
      route: 'setup',
      body: {
        category_id: categoryId(list, from.slug, shown),
        tool_key: file.tools?.own === undefined ? null : key(file.tools.own),
        competitor_tool_keys: (file.tools?.competitors ?? []).map(key),
        ...setupRequests(file, current, from),
        ...shared,
      },
    };
  }
  if (!from && file.requests?.improve != null)
    throw new UsageError(
      `${shown}: requests.improve can't be saved on a job. Remove it, and change it in DevTune instead.`,
    );
  const copyRequests = from
    ? categoryJobRequests(file, current, from, shown)
    : null;
  const recommend = copyRequests?.recommend ?? file.requests?.recommend;
  if (!recommend)
    throw new UsageError(
      `${shown}: give requests.recommend. DevTune saves a job with its add and recommend requests.`,
    );
  const listed = new Set(tools.map(key));
  const held = new Set([
    ...(current?.own_tool_key ? [current.own_tool_key] : []),
    ...(current?.competitor_tool_keys ?? []),
  ]);
  return {
    route: 'job',
    body: {
      job: from ? (current?.name ?? from.name) : file.job,
      source_category_id: from ? categoryId(list, from.slug, shown) : null,
      requests: copyRequests ?? {
        add: file.requests?.add,
        recommend,
        hosted: file.requests?.hosted ?? null,
      },
      ...(!from
        ? { building_blocks: current?.building_blocks ?? NO_BUILDING_BLOCKS }
        : {}),
      tools: [
        ...tools.map((ref) => jobTool(ref, current)),
        // A new copy inherits every category tool, including ones the file doesn't select.
        ...(from && !current ? (CATEGORY_TOOLS[from.slug] ?? []) : [])
          .filter((tool) => !listed.has(tool))
          .map((tool_key) => ({ tool_key })),
        // A tool DevTune measures that is neither yours nor a competitor, which a file can't name. A copy keeps every
        // tool it holds, as the setup route does; only a job drops a tool its file stops selecting.
        ...(current?.tools ?? [])
          .filter(
            (row) =>
              !listed.has(row.tool_key) && (from || !held.has(row.tool_key)),
          )
          .map(heldJobTool),
      ],
      own_tool_key: file.tools?.own === undefined ? null : key(file.tools.own),
      competitor_tool_keys: (file.tools?.competitors ?? []).map(key),
      ...shared,
    },
  };
}

/**
 * The job API requires add and recommend, allows a null hosted request, and keeps improve and the
 * ending unchanged. A copy's inherited improve request can therefore only be kept as held.
 */
function categoryJobRequests(
  file: SetupFile,
  current: DevtuneSetup | null,
  from: NonNullable<ReturnType<typeof findCategoryRequests>>,
  shown: string,
) {
  const published = (intent: (typeof PROMPT_INTENTS)[number]) =>
    from.prompts.find((prompt) => prompt.intent === intent)?.text ?? null;
  const effective = (intent: (typeof PROMPT_INTENTS)[number]) =>
    file.requests?.[intent] === undefined
      ? published(intent)
      : file.requests[intent];
  const improve = effective('improve');
  const heldImprove = current
    ? (current.requests.improve ?? null)
    : published('improve');
  if (improve !== heldImprove)
    throw new UsageError(
      `${shown}: requests.improve can't be changed while push saves tools to a category copy. Keep the inherited or pulled requests.improve value, then push again.`,
    );
  const add = effective('add');
  const recommend = effective('recommend');
  for (const [intent, text] of [
    ['add', add],
    ['recommend', recommend],
  ])
    if (!text)
      throw new UsageError(
        `${shown}: requests.${intent} can't be left out while push saves tools to a category copy. Give its text, push the tools, then push the omission separately.`,
      );
  return { add, recommend, hosted: effective('hosted') };
}

/** How the setup save takes a request a copy leaves out. */
const OMITTED_REQUEST = 'omitted';

/**
 * A category setup's requests: the file's, null as left out, and for a request it no longer
 * overrides or leaves out, the category's own text again, so deleting a request from the file goes
 * back to the category's.
 */
function setupRequests(
  file: SetupFile,
  current: DevtuneSetup | null,
  from: NonNullable<ReturnType<typeof findCategoryRequests>>,
) {
  const requests: Record<string, string> = {};
  for (const intent of PROMPT_INTENTS) {
    const text = file.requests?.[intent];
    const published = from.prompts.find((p) => p.intent === intent)?.text;
    const held = current?.requests[intent] ?? null;
    if (text === null) requests[intent] = OMITTED_REQUEST;
    else if (text !== undefined) requests[intent] = text;
    else if (current && published && held !== published)
      requests[intent] = published;
  }
  return Object.keys(requests).length ? { requests } : {};
}

/** Whether DevTune's setup holds a file's full entry as the file writes it, as pull wrote it. */
function heldAsWritten(entry: SetupToolEntry, current: DevtuneSetup | null) {
  const row = current?.tools.find((each) => each.tool_key === entry.key);
  return (
    row?.signals != null &&
    canonical(fileTool({ ...row, signals: row.signals })) === canonical(entry)
  );
}

/**
 * A tool DevTune's setup holds as the job save takes it: in full with the signals DevTune sent, or a
 * catalogue tool, whose signals DevTune doesn't send, by key alone.
 */
function heldJobTool(row: DevtuneSetup['tools'][number]) {
  return row.signals === null
    ? { tool_key: row.tool_key }
    : {
        tool_key: row.tool_key,
        display_name: row.display_name,
        brand_domain: row.brand_domain,
        signals: row.signals,
      };
}

/**
 * A file's tool as the job save takes it: a full entry's own signals, DevTune's for a key its setup
 * holds, or a catalogue tool by key alone, which the save fills in.
 */
function jobTool(ref: SetupToolRef, current: DevtuneSetup | null) {
  const row = current?.tools.find(
    (each) => each.tool_key === (typeof ref === 'string' ? ref : ref.key),
  );
  if (typeof ref === 'string')
    return row ? heldJobTool(row) : { tool_key: ref };
  return {
    tool_key: ref.key,
    display_name: ref.name,
    brand_domain: ref.domain ?? null,
    signals: jobSignals(ref, row?.signals ?? null),
  };
}

/** A full entry's signals in the job save's shape, keeping DevTune's dismissed suggestions. */
function jobSignals(
  entry: SetupToolEntry,
  held: Record<string, unknown> | null,
) {
  const { packages, configNames, importPatterns, brandDomains, ...rest } =
    entry.signals;
  return {
    packages: packages ?? {},
    configNames: configNames ?? [],
    importPatterns: importPatterns ?? [],
    brandDomains: brandDomains ?? [],
    ...rest,
    ...(Array.isArray(held?.dismissedYieldsTo)
      ? { dismissedYieldsTo: held.dismissedYieldsTo }
      : {}),
  };
}

function categoryId(list: DevtuneSetupList, slug: string, shown: string) {
  const category = list.catalogue.categories.find((c) => c.slug === slug);
  if (!category)
    throw new UsageError(
      `${shown}: DevTune has no published category ${slug}. Choose another from:, or update agentpicks.`,
    );
  return category.id;
}

/** The file's stacks by id, and the test apps DevTune holds that this version can't name. */
function environmentIds(
  file: SetupFile,
  current: DevtuneSetup | null,
  list: DevtuneSetupList,
  runsIn: string,
  shown: string,
  repositoryStacks: string[] | undefined,
) {
  const stacks =
    file.stacks ??
    repositoryStacks?.filter((slug) => nameableStack(slug, runsIn));
  if (!stacks && current) return current.environments.map((env) => env.id);
  if (!stacks?.length)
    throw new UsageError(
      `${shown}: couldn't detect any supported stacks for this repository. Replace repo: with stacks: (for example, stacks: [nextjs]), then push again. To test the repository, pass --repo to agentpicks run.`,
    );
  const ids = stacks.map((slug) => {
    const env = list.catalogue.environments.find((each) => each.slug === slug);
    if (!env)
      throw new UsageError(
        `${shown}: DevTune has no stack ${slug}. Remove it from stacks:, or update agentpicks.`,
      );
    return env.id;
  });
  const kept = (current?.environments ?? [])
    .filter((env) => !nameableStack(env.slug, runsIn))
    .map((env) => env.id);
  return [...new Set([...ids, ...kept])];
}

/**
 * The agents and models to save: each agent the file names with the models DevTune holds for it,
 * or its first offered model for one DevTune doesn't test yet, and every agent the file can't name.
 */
function agentModels(
  file: SetupFile,
  current: DevtuneSetup | null,
  list: DevtuneSetupList,
  shown: string,
) {
  const held = current?.agent_models ?? [];
  if (!file.agents) {
    if (current) return held;
    throw new UsageError(
      `${shown}: give agents:, the agents DevTune tests the setup with.`,
    );
  }
  const named = file.agents.map(devtuneAgent);
  return [
    ...named.flatMap((agent) => {
      const models = held.filter((entry) => entry.agent === agent);
      if (models.length) return models;
      const model = list.catalogue.agents.find((each) => each.agent === agent)
        ?.models[0];
      if (!model)
        throw new UsageError(
          `${shown}: DevTune offers no model for ${agent}. Remove it from agents:.`,
        );
      return [{ agent, model }];
    }),
    ...held.filter(
      (entry) =>
        !named.includes(entry.agent) &&
        !SETUP_AGENT_KINDS.includes(entry.agent),
    ),
  ];
}

/** The agents a setup file can name, as DevTune ids. */
const SETUP_AGENT_KINDS: string[] = SELF_RUN_AGENTS.map((agent) => agent.kind);
