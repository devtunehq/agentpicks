/**
 * ABOUTME: Covers what `agentpicks push` sends for a file's competitors: a customer's setup tracks at most six, so a
 * file listing more is refused before sending, unless the DevTune setup it is linked to already holds more, as a
 * public board does. Category files adding tools save as copies through the job route, keeping
 * inherited requests, copied tools and the file's last-seen snapshot digest.
 */
import { describe, expect, it } from 'vitest';

import { findCategoryRequests } from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import { SETUP_MAX_COMPETITORS } from '../setup/rules';
import type { DevtuneSetup, DevtuneSetupList } from './devtune-setups';
import { UsageError } from './errors';
import { pushRequest } from './push-payload';

const BOARD = CATEGORY_TOOLS['error-tracking']!;

const LIST: DevtuneSetupList = {
  setups: [],
  catalogue: {
    categories: [
      { id: 'b1000000-0000-4000-8000-000000000003', slug: 'error-tracking' },
    ],
    environments: [],
    agents: [],
  },
};

/** The DevTune setup a file is linked to, holding `competitors`. */
const linked = (competitors: string[]): DevtuneSetup => ({
  id: 'setup-1',
  category_slug: 'error-tracking',
  name: 'Error tracking',
  kind: 'category',
  source_category_slug: 'error-tracking',
  snapshot_digest: 'a'.repeat(64),
  requests: {},
  tools: competitors.map((key) => ({
    tool_key: key,
    display_name: key,
    brand_domain: null,
    signals: null,
  })),
  own_tool_key: null,
  competitor_tool_keys: competitors,
  environments: [{ id: 'env-1', slug: 'nextjs' }],
  agent_models: [{ agent: 'codex', model: 'gpt-5' }],
  building_blocks: null,
});

describe('pushRequest competitors', () => {
  const file = (competitors: readonly string[]) => ({
    from: 'error-tracking',
    tools: { competitors: [...competitors] },
  });

  it('refuses a file listing more than six competitors before sending, new or linked to a customer setup', () => {
    const seven = BOARD.slice(0, SETUP_MAX_COMPETITORS + 1);
    for (const current of [null, linked(BOARD.slice(0, 2))])
      expect(() =>
        pushRequest(file(seven), current, LIST, 'errors.yaml'),
      ).toThrow(
        new UsageError(
          `errors.yaml: a setup tracks at most ${SETUP_MAX_COMPETITORS} competitors, and tools.competitors lists ${SETUP_MAX_COMPETITORS + 1}. Remove 1, then push again.`,
        ),
      );
  });

  it('sends every competitor of a file linked to a public board that already holds them', () => {
    const { body } = pushRequest(
      file(BOARD),
      linked([...BOARD]),
      LIST,
      'errors.yaml',
    );
    expect(body.competitor_tool_keys).toEqual(BOARD);
  });
});

describe('pushRequest category copies adding tools', () => {
  const category = findCategoryRequests('error-tracking')!;
  const list: DevtuneSetupList = {
    ...LIST,
    catalogue: {
      ...LIST.catalogue,
      environments: [{ id: 'env-1', slug: 'nextjs' }],
      agents: [
        { agent: 'codex', models: ['gpt-6.1-sol'], included_in_plan: true },
      ],
    },
  };
  const own = {
    key: 'acme-errors',
    name: 'Acme Errors',
    signals: { packages: { npm: ['@acme/errors'] } },
  };
  const file = {
    from: 'error-tracking',
    tools: { own, competitors: ['clerk'] },
    stacks: ['nextjs'],
    agents: ['codex'],
  };
  const requests = Object.fromEntries(
    category.prompts.map((p) => [p.intent, p.text]),
  );

  it('creates a category copy with inherited requests and tools plus the full entry and another catalogue key', () => {
    expect(pushRequest(file, null, list, 'errors.yaml')).toEqual({
      route: 'job',
      body: {
        job: category.name,
        source_category_id: LIST.catalogue.categories[0]!.id,
        requests: {
          add: requests.add,
          recommend: requests.recommend,
          hosted: requests.hosted ?? null,
        },
        tools: [
          {
            tool_key: own.key,
            display_name: own.name,
            brand_domain: null,
            signals: {
              ...own.signals,
              configNames: [],
              importPatterns: [],
              brandDomains: [],
            },
          },
          { tool_key: 'clerk' },
          ...BOARD.map((tool_key) => ({ tool_key })),
        ],
        own_tool_key: own.key,
        competitor_tool_keys: ['clerk'],
        environment_ids: ['env-1'],
        agent_models: [{ agent: 'codex', model: 'gpt-6.1-sol' }],
        snapshot_digest: null,
      },
    });
  });

  it('refuses added tools on a public-category setup before choosing a save route', () => {
    const current = linked(['sentry']);
    expect(() => pushRequest(file, current, list, 'errors.yaml')).toThrow(
      /public.category.*copy.*pull/i,
    );
    expect(
      pushRequest(
        { ...file, tools: { own: 'sentry' } },
        current,
        list,
        'errors.yaml',
      ).route,
    ).toBe('setup');
  });

  it.each(['sentry', 'clerk'])(
    'refuses unheld full catalogue entries for %s in both tool fields',
    (key) => {
      const entry = { ...own, key, name: key };
      for (const field of ['own', 'competitors'] as const) {
        const tools =
          field === 'own' ? { own: entry } : { competitors: [entry] };
        for (const current of [null, { ...linked([]), kind: 'copy' as const }])
          expect(() =>
            pushRequest({ ...file, tools }, current, list, 'errors.yaml'),
          ).toThrow(new RegExp(`tools\\.${field}.*${key}.*key alone`));
      }
    },
  );

  it('keeps full catalogue entries DevTune holds as written on the setup route', () => {
    const current = {
      ...linked([]),
      kind: 'copy' as const,
      tools: [
        {
          tool_key: 'clerk',
          display_name: 'Clerk',
          brand_domain: null,
          signals: own.signals,
        },
      ],
    };
    const request = pushRequest(
      { ...file, tools: { own: { ...own, key: 'clerk', name: 'Clerk' } } },
      current,
      list,
      'errors.yaml',
    );
    expect(request.route).toBe('setup');
  });

  it('keeps request overrides and hosted omissions and refuses only unsupported recommend or improve changes', () => {
    expect(
      pushRequest(
        {
          ...file,
          requests: {
            add: 'Add error tracking for the app and its workers.',
            hosted: null,
          },
        },
        null,
        list,
        'errors.yaml',
      ).body.requests,
    ).toEqual({
      add: 'Add error tracking for the app and its workers.',
      recommend: requests.recommend,
      hosted: null,
    });
    expect(() =>
      pushRequest(
        { ...file, requests: { recommend: null } },
        null,
        list,
        'errors.yaml',
      ),
    ).toThrow(/requests.recommend.*can't be left out.*push/);
    expect(() =>
      pushRequest(
        {
          ...file,
          requests: { improve: 'Improve error tracking throughout this app.' },
        },
        null,
        list,
        'errors.yaml',
      ),
    ).toThrow(/requests.improve.*can't be changed.*push/);
  });

  it('keeps inherited and pulled improve requests without sending an unsupported edit', () => {
    const category = findCategoryRequests('ci')!;
    const ciList = {
      ...list,
      catalogue: {
        ...list.catalogue,
        categories: [{ id: LIST.catalogue.categories[0]!.id, slug: 'ci' }],
      },
    };
    const ciFile = { ...file, from: 'ci' };
    const inherited = pushRequest(ciFile, null, ciList, 'ci.yaml');
    expect(inherited.body.requests).not.toHaveProperty('improve');
    expect(() =>
      pushRequest(
        { ...ciFile, requests: { improve: null } },
        null,
        ciList,
        'ci.yaml',
      ),
    ).toThrow(/requests.improve.*can't be changed/);
    const improve = 'Improve the checks for the app and its workers.';
    const current = {
      ...linked([]),
      kind: 'copy' as const,
      name: category.name,
      source_category_slug: 'ci',
      requests: { improve },
    };
    expect(
      pushRequest(
        { ...ciFile, requests: { improve } },
        current,
        ciList,
        'ci.yaml',
      ).body.requests,
    ).not.toHaveProperty('improve');
    expect(() => pushRequest(ciFile, current, ciList, 'ci.yaml')).toThrow(
      /requests.improve.*can't be changed/,
    );
  });

  it("keeps an existing copy's name, hidden tools, building blocks and last-seen digest", () => {
    const current = {
      ...linked(['sentry']),
      kind: 'copy' as const,
      name: 'Errors for our app',
      building_blocks: null,
      requests,
      snapshot_digest: 'b'.repeat(64),
      own_tool_key: 'old-errors',
      tools: [
        ...linked(['sentry']).tools,
        {
          tool_key: 'old-errors',
          display_name: 'Old Errors',
          brand_domain: null,
          signals: { packages: { npm: ['@acme/old-errors'] } },
        },
        {
          tool_key: 'hidden',
          display_name: 'Hidden',
          brand_domain: null,
          signals: { packages: {} },
        },
      ],
    };
    const pushed = pushRequest(
      { ...file, synced: { file: 'a'.repeat(64), setup: 'a'.repeat(64) } },
      current,
      list,
      'errors.yaml',
    );
    expect(pushed.route).toBe('job');
    expect(pushed.body).toMatchObject({
      job: current.name,
      setup: current.id,
      snapshot_digest: 'a'.repeat(64),
    });
    expect(pushed.body).not.toHaveProperty('building_blocks');
    // Sentry was the copy's competitor and old-errors its own tool; the file selects neither, and the copy keeps
    // both, as the setup route keeps a tool it isn't sent.
    expect(pushed.body.tools).toContainEqual({ tool_key: 'sentry' });
    expect(pushed.body.tools).toContainEqual({
      tool_key: 'old-errors',
      display_name: 'Old Errors',
      brand_domain: null,
      signals: { packages: { npm: ['@acme/old-errors'] } },
    });
    expect(pushed.body.tools).toContainEqual({
      tool_key: 'hidden',
      display_name: 'Hidden',
      brand_domain: null,
      signals: { packages: {} },
    });
  });
});
