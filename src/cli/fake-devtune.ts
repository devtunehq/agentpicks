/**
 * ABOUTME: DevTune's API v2 upload routes and Storage for CLI tests: a stubbed `fetch` that answers
 * each method and URL from a queue and records every call, and the answers create, complete and a
 * refusal give.
 */
import { vi } from 'vitest';

import type { DevtuneTarget } from './devtune-login';

export const TARGET = {
  baseUrl: 'https://devtune.test/api/v2',
  projectId: '11111111-2222-4333-8444-555555555555',
  apiKey: 'dtk_live_0123456789abcdef0123456789abcdef',
} satisfies DevtuneTarget;
export const UPLOADS = `${TARGET.baseUrl}/projects/${TARGET.projectId}/agent-picks/uploads`;

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

type Reply = { status: number; body: unknown } | Error;

/**
 * Stubs `fetch`: each call takes the next reply queued for its method and URL, and every call is
 * recorded. A PUT with nothing queued succeeds.
 */
export function stubFetch(replies: Record<string, Reply[]>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({
        method,
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body:
          init.body instanceof Uint8Array
            ? Buffer.from(init.body).toString('utf8')
            : init.body instanceof URLSearchParams
              ? init.body.toString()
              : ((init.body as string | undefined) ?? null),
      });
      const reply =
        replies[`${method} ${url}`]?.shift() ??
        (method === 'PUT' ? { status: 200, body: { Key: 'stored' } } : null);
      if (!reply) throw new Error(`unexpected ${method} ${url}`);
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

/** Create's answer: one address per artifact named in `urls` (null when absent from it, as stored). */
export function created(
  runId: string,
  names: string[],
  urls: Record<string, string | null>,
  status: 'open' | 'completed' = 'open',
) {
  return {
    status: 200,
    body: {
      data: {
        run_id: runId,
        status,
        expires_at: '2026-11-12T12:00:00Z',
        completed_at: null,
        run:
          status === 'completed'
            ? {
                id: runId,
                test_id: 't',
                status: 'completed',
                analysis: 'pending',
              }
            : null,
        uploads:
          status === 'completed'
            ? []
            : names.map((name) => ({
                name,
                bytes: 1,
                path: `self-run/p/${runId}/${name}`,
                url: urls[name] ?? null,
              })),
      },
      meta: {
        timestamp: '2026-11-11T12:06:00Z',
        projectId: TARGET.projectId,
      },
    },
  };
}

/** Complete's answer for a recorded run awaiting analysis. */
export function completed(runId: string) {
  return {
    status: 200,
    body: {
      data: {
        run_id: runId,
        status: 'completed',
        expires_at: '2026-11-12T12:00:00Z',
        completed_at: '2026-11-11T12:06:00Z',
        run: {
          id: runId,
          test_id: 't',
          status: 'completed',
          analysis: 'pending',
        },
      },
      meta: {
        timestamp: '2026-11-11T12:06:00Z',
        projectId: TARGET.projectId,
      },
    },
  };
}

/** A named refusal, in API v2's error body. */
export function refused(status: number, reason: string, message: string) {
  return {
    status,
    body: { error: 'conflict', message, reason, status },
  };
}

/** API v2's setup read and the two saves push sends. */
export const SETUPS = `${TARGET.baseUrl}/projects/${TARGET.projectId}/agent-picks/setup`;
export const JOB = `${TARGET.baseUrl}/projects/${TARGET.projectId}/agent-picks/job`;

/** The setup read's answer: the setups given, and a catalogue of error-tracking, two stacks and two agents. */
export function setupList(setups: unknown[]) {
  return {
    status: 200,
    body: {
      data: {
        setups,
        catalogue: {
          categories: [
            {
              id: 'c0000000-0000-4000-8000-000000000001',
              slug: 'error-tracking',
            },
          ],
          environments: [
            { id: 'e0000000-0000-4000-8000-000000000001', slug: 'nextjs' },
            { id: 'e0000000-0000-4000-8000-000000000002', slug: 'express' },
          ],
          agents: [
            {
              agent: 'claude_code',
              models: ['claude-sonnet-5-5'],
              included_in_plan: true,
            },
            { agent: 'codex', models: ['gpt-6.1-sol'], included_in_plan: true },
          ],
        },
      },
      meta: { timestamp: '2026-11-14T12:00:00Z', projectId: TARGET.projectId },
    },
  };
}

/** A save's answer, echoing the setup it saved and the digest the save committed. */
export function savedSetup(
  id: string,
  categorySlug: string,
  snapshotDigest: string,
) {
  return {
    status: 200,
    body: {
      data: {
        saved: true,
        setup: { id, category_slug: categorySlug },
        snapshot_digest: snapshotDigest,
      },
      meta: { timestamp: '2026-11-14T12:00:00Z', projectId: TARGET.projectId },
    },
  };
}
