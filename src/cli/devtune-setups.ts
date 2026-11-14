/**
 * ABOUTME: The project's DevTune setups over API v2, for list, pull, push and run by name: read them
 * with their snapshot digests and the catalogue ids a save names (GET agent-picks/setup), and save a
 * job (PUT agent-picks/job) or a category setup (PUT agent-picks/setup) with the digest the file last
 * saw, which DevTune refuses as setup_changed when the setup changed since, and answers with the
 * digest of the setup the save committed.
 */
import { z } from 'zod';

import type { DevtuneTarget } from './devtune-login';
import { callApi } from './upload';

const idSlug = z.object({ id: z.string(), slug: z.string() });

const devtuneSetupSchema = z.object({
  id: z.string(),
  category_slug: z.string(),
  name: z.string(),
  kind: z.enum(['job', 'copy', 'category']),
  source_category_slug: z.string().nullable(),
  snapshot_digest: z.string(),
  requests: z.record(z.string(), z.string().nullable()),
  tools: z.array(
    z.object({
      tool_key: z.string(),
      display_name: z.string(),
      brand_domain: z.string().nullable(),
      signals: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
  own_tool_key: z.string().nullable(),
  competitor_tool_keys: z.array(z.string()),
  environments: z.array(idSlug),
  agent_models: z.array(z.object({ agent: z.string(), model: z.string() })),
  building_blocks: z.record(z.string(), z.unknown()).nullable(),
});

const setupListSchema = z.object({
  setups: z.array(devtuneSetupSchema),
  catalogue: z.object({
    categories: z.array(idSlug),
    environments: z.array(idSlug),
    agents: z.array(
      z.object({
        agent: z.string(),
        models: z.array(z.string()),
        included_in_plan: z.boolean(),
      }),
    ),
  }),
});

/** One of the project's DevTune setups, as GET agent-picks/setup returns it. */
export type DevtuneSetup = z.infer<typeof devtuneSetupSchema>;
export type DevtuneSetupList = z.infer<typeof setupListSchema>;

const savedSchema = z.object({
  setup: z.object({ id: z.string(), category_slug: z.string() }).nullable(),
  snapshot_digest: z.string(),
});

const setupUrl = (target: DevtuneTarget, path: 'setup' | 'job') =>
  `${target.baseUrl}/projects/${target.projectId}/agent-picks/${path}`;

/** The project's setups and the catalogue a save names its ids from. */
export function readDevtuneSetups(target: DevtuneTarget) {
  return callApi(target, setupListSchema, setupUrl(target, 'setup'), {
    method: 'GET',
  });
}

/** Saves a setup file's content as a job, or as a category setup; resolves to the setup it saved and its digest. */
export async function saveDevtuneSetup(
  target: DevtuneTarget,
  route: 'job' | 'setup',
  body: Record<string, unknown>,
) {
  const saved = await callApi(target, savedSchema, setupUrl(target, route), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return { setup: saved.setup, snapshotDigest: saved.snapshot_digest };
}
