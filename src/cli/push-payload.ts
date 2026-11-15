/**
 * ABOUTME: What `agentpicks push` sends for a setup file: a file `from` a category saves through PUT
 * agent-picks/setup, its tools by key, and a job through PUT agent-picks/job. Each carries the digest
 * of the setup the file last saw (null for a new setup), so DevTune refuses a setup changed since
 * as setup_changed. What a file can't say (models, building blocks, a tool neither yours nor a
 * competitor, a stack or agent this version can't name) is sent as DevTune holds it. A tool from
 * DevTune's catalogue goes by key alone, and a job save fills in its signals. A copy's tool beyond
 * its category's is added in the DevTune app, so a `from` file's full entry must be one DevTune
 * already holds as it says, and a key one its category measures or the copy holds.
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
    // A copy's tool beyond its category's is added in the DevTune app, and the copy then holds it.
    for (const ref of tools)
      if (
        typeof ref === 'string'
          ? !CATEGORY_TOOLS[from.slug]?.includes(ref) &&
            !current?.tools.some((row) => row.tool_key === ref)
          : !heldAsWritten(ref, current)
      )
        throw new UsageError(
          `${shown}: ${key(ref)} isn't a tool of ${from.slug}. Add it to a category copy in the DevTune app, then run agentpicks pull.`,
        );
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
  if (file.requests?.improve != null)
    throw new UsageError(
      `${shown}: requests.improve can't be saved on a job. Remove it, and change it in DevTune instead.`,
    );
  const recommend = file.requests?.recommend;
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
      job: file.job,
      source_category_id: null,
      requests: {
        add: file.requests?.add,
        recommend,
        hosted: file.requests?.hosted ?? null,
      },
      building_blocks: current?.building_blocks ?? NO_BUILDING_BLOCKS,
      tools: [
        ...tools.map((ref) => jobTool(ref, current)),
        // A tool DevTune measures that is neither yours nor a competitor, which a file can't name.
        ...(current?.tools ?? [])
          .filter((row) => !listed.has(row.tool_key) && !held.has(row.tool_key))
          .map(heldJobTool),
      ],
      own_tool_key: file.tools?.own === undefined ? null : key(file.tools.own),
      competitor_tool_keys: (file.tools?.competitors ?? []).map(key),
      ...shared,
    },
  };
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
