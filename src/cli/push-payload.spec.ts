/**
 * ABOUTME: Covers what `agentpicks push` sends for a file's competitors: a customer's setup tracks at most six, so a
 * file listing more is refused before sending, unless the DevTune setup it is linked to already holds more, as a
 * public board does.
 */
import { describe, expect, it } from 'vitest';

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
