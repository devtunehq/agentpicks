/**
 * ABOUTME: `agentpicks init`'s drafting through DevTune for a custom job, with a saved sign-in or
 * project key: the job's requests and competitors from `POST …/agent-picks/job/draft`, and each
 * tool's signals from `POST …/agent-picks/tools/draft`, both counting against the project's hourly
 * draft allowance. The first refusal, failed draft, or DevTune out of reach prints one warning and
 * turns drafting off for the rest of the wizard, which carries on offline.
 */
import { z } from 'zod';

import { toolSignalsSchema, type SetupToolEntry } from '../setup/schema';
import { devtuneTarget, type DevtuneTarget } from './devtune-login';
import { NotLoggedInError, UploadError } from './errors';
import { callApi } from './upload';

const jobDraftSchema = z.object({
  status: z.string(),
  error: z.string().nullable(),
  requests: z.array(z.object({ intent: z.string(), text: z.string() })),
  competitors: z.array(
    z.object({ name: z.string(), domain: z.string().nullable() }),
  ),
});

const toolDraftSchema = z.object({
  status: z.string(),
  error: z.string().nullable(),
  signals: z.record(z.string(), z.unknown()),
});

export interface JobDraft {
  requests: { intent: string; text: string }[];
  competitors: { name: string; domain: string | null }[];
}

export interface Drafting {
  /** The job's requests and competitors, or null once drafting is off. */
  job(job: string): Promise<JobDraft | null>;
  /** The tool with its drafted signals, or null when none were found or drafting is off. */
  tool(
    tool: { key: string; name: string; domain: string | null },
    job: string,
    others: { key: string; name: string }[],
  ): Promise<SetupToolEntry | null>;
}

/** Drafting through DevTune when a sign-in or key is saved or set; null when there is none. */
export function devtuneDrafting(
  io: Parameters<typeof devtuneTarget>[0],
  warn: (line: string) => void,
): Drafting | null {
  let target: DevtuneTarget;
  try {
    target = devtuneTarget(io);
  } catch (error) {
    if (error instanceof NotLoggedInError) return null;
    throw error;
  }
  const routes = `${target.baseUrl}/projects/${target.projectId}/agent-picks`;
  let off = false;
  const draft = async <T>(
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
  ): Promise<T | null> => {
    if (off) return null;
    try {
      return await callApi(target, schema, `${routes}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      off = true;
      warn(`DevTune didn't draft: ${error.message} Continuing offline.`);
      return null;
    }
  };
  return {
    async job(job) {
      const drafted = await draft('job/draft', jobDraftSchema, { job });
      if (!drafted || drafted.status === 'drafted') return drafted;
      off = true;
      warn(
        `DevTune couldn't draft the job: ${drafted.error ?? 'no reason given'} Continuing offline.`,
      );
      return null;
    },
    async tool(tool, job, others) {
      const drafted = await draft('tools/draft', toolDraftSchema, {
        tool_key: tool.key,
        name: tool.name,
        domain: tool.domain,
        job,
        other_tools: others.map((other) => ({
          tool_key: other.key,
          name: other.name,
        })),
      });
      if (!drafted) return null;
      if (drafted.status !== 'drafted') {
        off = true;
        warn(
          `DevTune couldn't draft ${tool.name}: ${drafted.error ?? 'no reason given'} Continuing offline.`,
        );
        return null;
      }
      const signals = setupSignals(drafted.signals);
      if (!signals) return null;
      return {
        key: tool.key,
        name: tool.name,
        ...(tool.domain ? { domain: tool.domain } : {}),
        signals,
      };
    },
  };
}

/** The signal lists a setup file holds, with the most of each it takes. */
const LISTS = {
  configNames: 30,
  importPatterns: 20,
  brandDomains: 10,
  configFiles: 10,
  configPatterns: 10,
} as const;
const ECOSYSTEMS = ['npm', 'pypi', 'gem'] as const;
const MAX_PACKAGES = 40;

/**
 * A drafted tool's signals as a setup file holds them: each entry the setup schema accepts, the
 * rest dropped. Null when no package or config name survives, since a run couldn't recognise it.
 */
function setupSignals(
  drafted: Record<string, unknown>,
): SetupToolEntry['signals'] | null {
  const accepted = (field: Record<string, unknown>) =>
    toolSignalsSchema.safeParse(field).success;
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  const packages: Record<string, string[]> = {};
  const draftedPackages =
    drafted.packages && typeof drafted.packages === 'object'
      ? (drafted.packages as Record<string, unknown>)
      : {};
  for (const ecosystem of ECOSYSTEMS) {
    const names = list(draftedPackages[ecosystem])
      .filter((name) => accepted({ packages: { [ecosystem]: [name] } }))
      .slice(0, MAX_PACKAGES);
    if (names.length > 0) packages[ecosystem] = names;
  }
  const signals: SetupToolEntry['signals'] = {
    ...(Object.keys(packages).length > 0 ? { packages } : {}),
  };
  for (const [field, max] of Object.entries(LISTS) as [
    keyof typeof LISTS,
    number,
  ][]) {
    const values = list(drafted[field])
      .filter((value) => accepted({ [field]: [value] }))
      .slice(0, max);
    if (values.length > 0) signals[field] = values;
  }
  const parsed = toolSignalsSchema.safeParse(signals);
  if (!parsed.success) return null;
  return Object.keys(packages).length > 0 || signals.configNames
    ? parsed.data
    : null;
}
