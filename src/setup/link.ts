/**
 * ABOUTME: How a setup file and a DevTune setup relate: the file's content digest, the sync state of a
 * linked pair from that digest and DevTune's snapshot digest against what pull or push last saw
 * (`synced`), the name a DevTune setup goes by, and a DevTune setup written as a file. A file says
 * what it can (job, requests, tools, stacks, agents); what it can't (models, building blocks, a
 * tool neither yours nor a competitor) stays in DevTune, and push keeps it. A tool from DevTune's
 * catalogue comes by key, in a job or a copy, since DevTune doesn't send its signals.
 */
import { createHash } from 'node:crypto';

import { stringify } from 'yaml';

import { findCategoryRequests } from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import {
  ENVIRONMENTS,
  environmentRunsIn,
  isRetiredEnvironment,
} from '../catalogue/environments';
import { PROMPT_INTENTS } from '../catalogue/prompt-intents';
import type { DevtuneSetup } from '../cli/devtune-setups';
import { SELF_RUN_AGENTS } from '../cli/self-run-agents';
import { resolveSetup } from './resolve';
import { SETUP_AGENTS, setupFileSchema, type SetupFile } from './schema';

/** Fields that stay on this machine: DevTune setups test stacks, and a run's count is the runner's. */
const LOCAL_ONLY = ['id', 'synced', 'repo', 'runs'] as const;

/** JSON with keys sorted at every depth, so a digest doesn't depend on the order a file lists them in. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The digest of what a file says DevTune holds: its parsed content without id, synced, repo and
 * runs, so formatting, comments and local-only fields don't count as a change.
 */
export function fileDigest(file: SetupFile): string {
  const content: Record<string, unknown> = { ...file };
  for (const key of LOCAL_ONLY) delete content[key];
  return createHash('sha256').update(canonical(content)).digest('hex');
}

/**
 * A linked file's state against its DevTune setup: in_sync, local_changed, devtune_changed,
 * both_changed or orphaned (DevTune has no setup with its id). A file linked without `synced`, such
 * as one given an id by hand, can't tell what either side changed, so it is both_changed.
 */
export type SyncState =
  | 'in_sync'
  | 'local_changed'
  | 'devtune_changed'
  | 'both_changed'
  | 'orphaned';

export function syncState(
  file: SetupFile,
  setup: Pick<DevtuneSetup, 'snapshot_digest'> | undefined,
): SyncState {
  if (!setup) return 'orphaned';
  if (!file.synced) return 'both_changed';
  const local = fileDigest(file) !== file.synced.file;
  const devtune = setup.snapshot_digest !== file.synced.setup;
  if (local && devtune) return 'both_changed';
  if (local) return 'local_changed';
  if (devtune) return 'devtune_changed';
  return 'in_sync';
}

/** How `list` shows a state. */
export const SYNC_STATE_LABELS: Record<SyncState, string> = {
  in_sync: 'in sync',
  local_changed: 'local changed',
  devtune_changed: 'DevTune changed',
  both_changed: 'both changed',
  orphaned: 'not in DevTune',
};

/** DevTune's agent id for each name a setup file gives it, and back. */
const AGENT_KINDS = new Map(
  SELF_RUN_AGENTS.map((agent) => [agent.aliases[0]!, agent.kind as string]),
);
export const devtuneAgent = (name: string) => AGENT_KINDS.get(name) ?? name;
const fileAgent = (kind: string) =>
  SETUP_AGENTS.find((name) => AGENT_KINDS.get(name) === kind);

/** A stack this version of agentpicks can name in a setup that runs in `runsIn`. */
export function nameableStack(slug: string, runsIn: string) {
  return (
    ENVIRONMENTS.some((env) => env.slug === slug) &&
    !isRetiredEnvironment(slug) &&
    environmentRunsIn(slug, runsIn)
  );
}

/** A file name from a job line: lowercase letters and digits joined by hyphens. */
function slugName(text: string) {
  return (
    text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'setup'
  );
}

/**
 * The name each DevTune setup goes by in list, pull and run, by id: a category setup or unedited
 * copy is its category's slug, any other its name as a file name, never a built-in category's slug.
 * Two setups that would share a name get -2, -3 and on.
 */
export function devtuneSetupNames(setups: DevtuneSetup[]): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const setup of setups) {
    const file = devtuneSetupFile(setup);
    const unedited =
      'file' in file &&
      file.file.from !== undefined &&
      !file.file.requests &&
      !hasOwnTools(file.file);
    let base =
      unedited && setup.source_category_slug
        ? setup.source_category_slug
        : slugName(setup.name);
    if (!unedited && findCategoryRequests(base)) base = `${base}-setup`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    names.set(setup.id, name);
  }
  return names;
}

/** Whether a `from` file measures a tool its category doesn't: a full entry, or another catalogue tool by key. */
export function hasOwnTools(file: SetupFile) {
  if (!file.from) return false;
  const categoryKeys = CATEGORY_TOOLS[file.from] ?? [];
  return [file.tools?.own, ...(file.tools?.competitors ?? [])].some(
    (ref) =>
      ref !== undefined &&
      (typeof ref !== 'string' || !categoryKeys.includes(ref)),
  );
}

/** DevTune's stored tool signals in the file's shape: empty lists and editor state left out. */
function fileSignals(signals: Record<string, unknown>) {
  const { dismissedYieldsTo: _dismissed, packages, ...rest } = signals;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest))
    if (!(Array.isArray(value) && value.length === 0) && value !== undefined)
      kept[key] = value;
  const named = Object.fromEntries(
    Object.entries((packages ?? {}) as Record<string, unknown>).filter(
      ([, list]) => Array.isArray(list) && list.length > 0,
    ),
  );
  if (Object.keys(named).length) kept.packages = named;
  return kept;
}

/** A customer-authored DevTune tool as a file's full entry. */
export function fileTool(
  row: DevtuneSetup['tools'][number] & {
    signals: Record<string, unknown>;
  },
) {
  return {
    key: row.tool_key,
    name: row.display_name,
    ...(row.brand_domain ? { domain: row.brand_domain } : {}),
    signals: fileSignals(row.signals),
  };
}

/**
 * A DevTune setup as a setup file, or why it can't be one: a job is its line, requests and tools;
 * a copy or category setup is `from` its category, with the requests that differ from the
 * category's (null for one it leaves out). In both, a tool the customer authored is a full entry
 * with its signals and a tool from DevTune's catalogue, whose signals DevTune doesn't send, is its
 * key. `keep` carries the local file's own repo and runs.
 */
export function devtuneSetupFile(
  setup: DevtuneSetup,
  keep: Pick<SetupFile, 'repo' | 'runs'> = {},
): { file: SetupFile } | { problem: string } {
  const from =
    setup.kind === 'job'
      ? null
      : findCategoryRequests(setup.source_category_slug ?? '');
  if (setup.kind !== 'job' && !from)
    return {
      problem: `It is a setup of the category ${setup.source_category_slug}, which this version of agentpicks doesn't have. Update agentpicks, then try again.`,
    };
  const catalogueKeys = from ? (CATEGORY_TOOLS[from.slug] ?? []) : [];
  // A tool key, or a full entry for the schema to check. DevTune sends no signals for a catalogue tool.
  const tool = (key: string): unknown => {
    if (catalogueKeys.includes(key)) return key;
    const row = setup.tools.find((each) => each.tool_key === key);
    if (!row?.signals) return key;
    return fileTool({ ...row, signals: row.signals });
  };
  const requests = Object.fromEntries(
    PROMPT_INTENTS.flatMap((intent): [string, string | null][] => {
      const text = setup.requests[intent];
      // A job's improve request isn't saved by a job save, so the file leaves it to DevTune.
      if (!from) return !text || intent === 'improve' ? [] : [[intent, text]];
      const published = from.prompts.find((p) => p.intent === intent)?.text;
      // A copy that leaves out a request its category asks says so with null.
      if (!text) return published ? [[intent, null]] : [];
      return text === published ? [] : [[intent, text]];
    }),
  );
  const own = setup.own_tool_key ? tool(setup.own_tool_key) : undefined;
  const competitors = setup.competitor_tool_keys.map(tool);
  const stacks = setup.environments
    .map((env) => env.slug)
    .filter((slug) => nameableStack(slug, from?.slug ?? 'job-'));
  const agents = [
    ...new Set(
      setup.agent_models.flatMap((entry) => fileAgent(entry.agent) ?? []),
    ),
  ];
  const parsed = setupFileSchema.safeParse({
    ...(from ? { from: from.slug } : { job: setup.name }),
    ...(Object.keys(requests).length ? { requests } : {}),
    ...(own !== undefined || competitors.length
      ? {
          tools: {
            ...(own !== undefined ? { own } : {}),
            ...(competitors.length ? { competitors } : {}),
          },
        }
      : {}),
    ...(keep.repo !== undefined
      ? { repo: keep.repo }
      : stacks.length
        ? { stacks }
        : {}),
    ...(agents.length ? { agents } : {}),
    ...(keep.runs !== undefined ? { runs: keep.runs } : {}),
  });
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      problem: `DevTune holds ${issue!.path.join('.') || 'a field'} in a form a setup file can't: ${issue!.message} Change it in DevTune, then pull again.`,
    };
  }
  return { file: parsed.data };
}

/** Whether a DevTune setup, written as a file, passes the file's checks against the tools it holds. */
export function devtuneSetupProblems(
  setup: DevtuneSetup,
  name: string,
  file: SetupFile,
) {
  const resolved = resolveSetup(name, file, setup.tools);
  return 'setup' in resolved ? [] : resolved.problems;
}

/**
 * The file's YAML, with `id` and `synced` first. The `synced.file` digest is of the content
 * written, so the file reads as in sync until it is edited.
 */
export function linkedSetupYaml(
  file: SetupFile,
  link: { id: string; setupDigest: string },
): string {
  const { id: _id, synced: _synced, ...content } = file;
  const linked: SetupFile = {
    id: link.id,
    synced: { setup: link.setupDigest, file: fileDigest(content) },
    ...content,
  };
  return stringify(linked, { lineWidth: 0 });
}
