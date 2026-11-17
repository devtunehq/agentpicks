/**
 * ABOUTME: Covers resolving a setup file against the catalogue: `from` inheritance, catalogue tool
 * keys, full tool entries and the early stop their signals add, what makes a setup custom, and the
 * named problems for a missing job, request or tool, an unknown key, and a stack the setup can't use.
 */
import { describe, expect, it } from 'vitest';

import { findCategoryRequests } from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import { fileDigest } from './digest';
import { NEVER_PATTERN, resolveSetup, type ResolvedSetup } from './resolve';
import {
  CONFIG_NAME_MESSAGE,
  PACKAGE_NAME_MESSAGE,
  packageNameSchema,
  PATTERN_MESSAGE,
  SETUP_MAX_COMPETITORS,
  SETUP_MAX_TOOLS,
  TEXT_PROBLEM_MESSAGES,
} from './rules';
import { setupFileSchema, type SetupFile } from './schema';

const ERROR_TRACKING = findCategoryRequests('error-tracking')!;

function resolved(name: string, file: unknown): ResolvedSetup {
  const result = resolveSetup(name, setupFileSchema.parse(file));
  expect(result.problems).toEqual([]);
  return (result as { setup: ResolvedSetup }).setup;
}

function problems(file: unknown) {
  return resolveSetup('broken', setupFileSchema.parse(file)).problems;
}

const FLAGS: SetupFile['tools'] = {
  own: {
    key: 'acme-flags',
    name: 'Acme Flags',
    domain: 'acme.dev',
    signals: {
      packages: { npm: ['@acme/flags', '@acme/'], pypi: ['acme_flags'] },
      configNames: ['ACME_FLAGS_KEY', 'api.acme.dev'],
    },
  },
  competitors: [
    {
      key: 'launchdarkly',
      name: 'LaunchDarkly',
      signals: { packages: { npm: ['launchdarkly-node-server-sdk'] } },
    },
  ],
};

describe('resolveSetup', () => {
  it('inherits a category’s job, add request and early stop with from, and uploads as it', () => {
    const setup = resolved('errors', {
      from: 'error-tracking',
      stacks: ['nextjs'],
    });
    expect(setup).toMatchObject({
      name: 'errors',
      from: 'error-tracking',
      id: null,
      job: 'Error tracking',
      category: ERROR_TRACKING,
      request: { intent: 'add', text: ERROR_TRACKING.prompts[0].text },
      earlyStop: ERROR_TRACKING.earlyStop,
      customReason: null,
      stacks: [expect.objectContaining({ slug: 'nextjs' })],
      repo: null,
      agents: null,
      runs: null,
    });
  });

  it('keeps the category for its own job line, its published requests and catalogue tool keys', () => {
    const setup = resolved('errors', {
      id: 'setup-1',
      job: 'Catch crashes',
      from: 'error-tracking',
      requests: { add: ERROR_TRACKING.prompts[0].text },
      tools: { own: 'sentry', competitors: ['bugsnag', 'rollbar'] },
      repo: { path: '.', ref: 'main' },
      agents: ['codex'],
      runs: 2,
    });
    expect(setup).toMatchObject({
      id: 'setup-1',
      job: 'Catch crashes',
      category: ERROR_TRACKING,
      customReason: null,
      repo: { path: '.', ref: 'main' },
      agents: ['codex'],
      runs: 2,
    });
  });

  it('makes a setup custom when it rewords a request or gives a tool its own signals', () => {
    expect(
      resolved('errors', {
        from: 'error-tracking',
        requests: { add: 'Add error tracking with source maps.' },
      }),
    ).toMatchObject({
      category: null,
      customReason: "its add request isn't error-tracking's",
      request: { text: 'Add error tracking with source maps.' },
      earlyStop: ERROR_TRACKING.earlyStop,
    });
    const edited = resolved('errors', {
      from: 'error-tracking',
      tools: { own: FLAGS.own, competitors: ['sentry'] },
    });
    expect(edited.category).toBeNull();
    expect(edited.customReason).toBe('it gives acme-flags signals of its own');
    expect(edited.earlyStop.installPattern).toBe(
      `${ERROR_TRACKING.earlyStop.installPattern}|"@acme/flags"|"@acme/|"acme-flags"`,
    );
  });

  it('makes a setup that leaves out a request (null) custom, and refuses leaving out add, the one a run asks', () => {
    expect(
      resolved('errors', {
        from: 'error-tracking',
        requests: { hosted: null },
      }),
    ).toMatchObject({
      category: null,
      customReason: "it leaves out error-tracking's hosted request",
      request: { text: ERROR_TRACKING.prompts[0].text },
    });
    // improve, which error-tracking doesn't ask, left out is the category as published.
    expect(
      resolved('error-tracking', {
        from: 'error-tracking',
        requests: { improve: null },
      }).customReason,
    ).toBeNull();
    expect(
      problems({ from: 'error-tracking', requests: { add: null } }),
    ).toEqual([
      {
        field: 'requests.add',
        message:
          "A run asks the add request, so it can't be left out. Give it, or delete the line to inherit from:'s.",
      },
    ]);
  });

  it('builds a custom setup’s early stop from its tools’ package and config names', () => {
    const setup = resolved('flags', {
      job: 'Add feature flags',
      requests: { add: 'Add feature flags to this app.' },
      tools: FLAGS,
      stacks: ['nextjs', 'express'],
    });
    expect(setup).toMatchObject({
      from: null,
      job: 'Add feature flags',
      category: null,
      customReason: 'it has its own job',
      request: { intent: 'add', text: 'Add feature flags to this app.' },
      earlyStop: {
        installPattern:
          '"@acme/flags"|"@acme/|"acme-flags"|"launchdarkly-node-server-sdk"',
        codePattern: 'ACME_FLAGS_KEY|api\\.acme\\.dev',
      },
    });
    expect(setup.stacks!.map((env) => env.slug)).toEqual(['nextjs', 'express']);
  });

  it('leaves a tool that yields to another tool in the setup out of the early stop', () => {
    const setup = resolved('flags', {
      job: 'Add feature flags',
      requests: { add: 'Add feature flags to this app.' },
      tools: {
        own: {
          key: 'wrapper',
          name: 'Wrapper',
          signals: { packages: { npm: ['wrapper'] }, yieldsTo: ['acme-flags'] },
        },
        competitors: [FLAGS.own!],
      },
    });
    expect(setup.earlyStop.installPattern).toBe(
      '"@acme/flags"|"@acme/|"acme-flags"',
    );
  });

  it('runs a custom setup with no package or config name to watch for, whose picks DevTune reads by name', () => {
    const watchless = {
      job: 'Add feature flags',
      requests: { add: 'Add feature flags to this app.' },
      tools: {
        own: {
          key: 'acme',
          name: 'Acme',
          signals: { importPatterns: ['acme\\.init'] },
        },
      },
    };
    expect(resolved('flags', watchless).earlyStop).toEqual({
      installPattern: NEVER_PATTERN,
      codePattern: NEVER_PATTERN,
    });
    // A from category's own early stop still watches, so the same tool is fine there.
    expect(
      resolved('errors', {
        from: 'error-tracking',
        tools: watchless.tools,
      }).earlyStop.installPattern,
    ).toBe(ERROR_TRACKING.earlyStop.installPattern);
    expect(NEVER_PATTERN).toBe('__no-pick__');
  });

  it('keeps a tool yielding to a catalogue tool, listed or the category’s, out of the early stop', () => {
    const mine = {
      key: 'mine',
      name: 'Mine',
      signals: { packages: { npm: ['mine-sdk'] }, yieldsTo: ['sentry'] },
    };
    for (const competitors of [['sentry'], []])
      expect(
        resolved('errors', {
          from: 'error-tracking',
          tools: { own: mine, competitors },
        }).earlyStop.installPattern,
      ).not.toContain('mine-sdk');
  });

  it('holds a setup to the app’s rules: own keys, no yield loops, requests that name no measured tool', () => {
    expect(
      problems({
        from: 'error-tracking',
        tools: {
          own: {
            key: 'sentry',
            name: 'Our Sentry',
            signals: { packages: { npm: ['our-sentry'] } },
          },
        },
      }),
    ).toEqual([
      {
        field: 'tools.own.key',
        message:
          'error-tracking already has a tool sentry. Name it by its key alone (sentry), or give your entry another key.',
      },
    ]);
    const loop = (key: string, yieldsTo: string) => ({
      key,
      name: key,
      signals: { packages: { npm: [`${key}-sdk`] }, yieldsTo: [yieldsTo] },
    });
    expect(
      problems({
        job: 'Add flags',
        requests: {
          add: 'Add flags with Acme Flags.',
          hosted: 'Use acme.dev.',
        },
        tools: {
          own: { ...(FLAGS.own as object), signals: { configNames: ['ACME'] } },
          competitors: [loop('one', 'two'), loop('two', 'one')],
        },
      }),
    ).toEqual([
      {
        field: 'tools',
        message:
          "Tools' yieldsTo loop back on themselves, so no run could be classified. Remove a yieldsTo from the loop.",
      },
      {
        field: 'requests.hosted',
        message:
          'It holds a link or domain, which DevTune refuses in a request. Name the job without it.',
      },
      {
        field: 'requests.add',
        message:
          'It names Acme Flags, a tool this setup measures, so a run would test that name, not the job. Reword it without the tool.',
      },
      {
        field: 'requests.hosted',
        message: expect.stringMatching(/^It names Acme Flags,/),
      },
    ]);
  });

  it('caps a new setup at six competitors and a job line of 8 characters, which a linked one may exceed as DevTune holds it', () => {
    const written = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => ({
        key: `${prefix}-${i}`,
        name: `${prefix} ${i}`,
        signals: { brandDomains: [`${prefix}-${i}.dev`] },
      }));
    const board = CATEGORY_TOOLS['error-tracking']!;
    const tooMany = (count: number) => ({
      field: 'tools.competitors',
      message: `A setup tracks at most ${SETUP_MAX_COMPETITORS} competitors; it has ${count}.`,
    });
    expect(
      problems({
        job: 'Add flags',
        requests: { add: 'Add feature flags to this app.' },
        tools: { competitors: written(SETUP_MAX_COMPETITORS + 1, 'rival') },
      }),
    ).toEqual([tooMany(SETUP_MAX_COMPETITORS + 1)]);
    expect(
      problems({ from: 'error-tracking', tools: { competitors: board } }),
    ).toEqual([tooMany(board.length)]);
    // A file pulled from a public board, which ranks every tool of its category.
    expect(
      problems({
        id: 'board',
        from: 'error-tracking',
        tools: { competitors: board },
      }),
    ).toEqual([]);
    expect(
      problems({
        id: 'board',
        from: 'error-tracking',
        tools: {
          competitors: [...board, ...written(SETUP_MAX_TOOLS + 1, 'extra')],
        },
      }),
    ).toEqual([expect.objectContaining({ field: 'tools' })]);
    // A job saved before job lines were held to a request's length.
    const legacy = {
      job: 'Track',
      requests: { add: 'Track crawler visits to this app.' },
      tools: { own: written(1, 'own')[0] },
    };
    expect(problems(legacy)).toEqual([
      { field: 'job', message: TEXT_PROBLEM_MESSAGES.too_short },
    ]);
    // Linked and unchanged since pull, it keeps DevTune's line; edited, the line is new.
    const pulled = {
      ...legacy,
      id: 'legacy',
      synced: { setup: 'a'.repeat(64), file: fileDigest(legacy) },
    };
    expect(problems(pulled)).toEqual([]);
    expect(problems({ ...pulled, job: 'Trace' })).toEqual([
      { field: 'job', message: TEXT_PROBLEM_MESSAGES.too_short },
    ]);
    expect(problems({ ...legacy, id: 'legacy' })).toEqual([
      { field: 'job', message: TEXT_PROBLEM_MESSAGES.too_short },
    ]);
  });

  it('refuses what DevTune refuses in a job line or request: a link, code characters, an env-style name', () => {
    expect(
      problems({
        job: 'Add flags from https://flags.example',
        requests: {
          add: 'Add feature flags, reading process.env for the key.',
          recommend: 'Recommend flags, then set FLAGS_API_KEY.',
        },
        tools: FLAGS,
        stacks: ['nextjs'],
      }).map((problem) => problem.field),
    ).toEqual(['job', 'requests.add', 'requests.recommend']);
    expect(
      problems({
        job: 'Add flags that keep secrets and API keys out of logs',
        tools: FLAGS,
        requests: { add: 'Add feature flags to this app.' },
        stacks: ['nextjs'],
      }),
    ).toEqual([]);
  });

  it('refuses a stack or agent listed twice, and a custom setup named after a built-in category', () => {
    expect(
      problems({
        from: 'error-tracking',
        stacks: ['nextjs', 'express', 'nextjs'],
        agents: ['codex', 'codex'],
      }),
    ).toEqual([
      {
        field: 'stacks[2]',
        message: 'nextjs is listed more than once. List each once.',
      },
      {
        field: 'agents[1]',
        message: 'codex is listed more than once. List each once.',
      },
    ]);
    const reworded = {
      from: 'error-tracking',
      requests: { add: 'Add error tracking with source maps.' },
    };
    expect(
      resolveSetup('error-tracking', setupFileSchema.parse(reworded)).problems,
    ).toEqual([
      {
        field: '(file)',
        message:
          "A custom setup can't share its name with the built-in category error-tracking. Rename the file.",
      },
    ]);
    expect(
      resolveSetup('payments', setupFileSchema.parse({ from: 'payments' }))
        .problems,
    ).toEqual([]);
  });

  it.each([
    [
      { requests: { add: 'Add it.' } },
      'requests.add',
      'Write at least 8 characters.',
    ],
    [
      { signals: { importPatterns: ['(?=lookahead)'] } },
      'tools.own.signals.importPatterns[0]',
      PATTERN_MESSAGE,
    ],
    [
      { signals: { configFiles: ['x'.repeat(201)] } },
      'tools.own.signals.configFiles[0]',
      PATTERN_MESSAGE,
    ],
    [
      { signals: { packages: { npm: ['*'] } } },
      'tools.own.signals.packages.npm[0]',
      PACKAGE_NAME_MESSAGE,
    ],
    [
      { signals: { packages: { gem: ['@/'] } } },
      'tools.own.signals.packages.gem[0]',
      PACKAGE_NAME_MESSAGE,
    ],
    [
      { signals: { configNames: ['--help'] } },
      'tools.own.signals.configNames[0]',
      CONFIG_NAME_MESSAGE,
    ],
    [
      { signals: { configNames: ['K'] } },
      'tools.own.signals.configNames[0]',
      CONFIG_NAME_MESSAGE,
    ],
    [
      { signals: { commandPatterns: [''] } },
      'tools.own.signals.commandPatterns[0]',
      PATTERN_MESSAGE,
    ],
    [
      { signals: { configNames: ["ACME 'KEY'"] } },
      'tools.own.signals.configNames[0]',
      CONFIG_NAME_MESSAGE,
    ],
  ])('refuses %j, naming the field', (change, field, message) => {
    const { requests, signals } = change as {
      requests?: object;
      signals?: object;
    };
    const parsed = setupFileSchema.safeParse({
      job: 'Add feature flags',
      requests: requests ?? { add: 'Add feature flags to this app.' },
      tools: {
        own: {
          key: 'acme',
          name: 'Acme',
          signals: signals ?? { configNames: ['ACME'] },
        },
      },
    });
    expect(
      parsed.error?.issues.map((issue) => ({
        field: issue.path
          .map((key, i) =>
            typeof key === 'number'
              ? `[${key}]`
              : `${i ? '.' : ''}${String(key)}`,
          )
          .join(''),
        message: issue.message,
      })),
    ).toEqual([{ field, message }]);
  });

  it('refuses an oversized package name on its length alone, before the format check', () => {
    const parsed = packageNameSchema.safeParse(`${'a'.repeat(50_000)}!`);
    expect(parsed.error?.issues.map((issue) => issue.code)).toEqual([
      'too_big',
    ]);
  });

  it.each(['@acme/', '-acme', 'acme*', '@scope/pkg'])(
    'accepts the package name %s',
    (name) => expect(packageNameSchema.safeParse(name).success).toBe(true),
  );

  it('names the field and the fix for every problem', () => {
    expect(problems({ stacks: ['nextjs'], repo: '.' })).toEqual([
      {
        field: 'job',
        message: expect.stringMatching(/^Give the job line, or inherit/),
      },
      {
        field: 'requests.add',
        message: expect.stringMatching(/^Give the add request/),
      },
      {
        field: 'repo',
        message:
          'Give stacks or repo, not both: a run tests starters or your repository.',
      },
      { field: 'tools', message: expect.stringMatching(/^Give your tool/) },
    ]);
    expect(
      problems({
        from: 'error-tracking',
        tools: {
          own: 'nobody-errors',
          competitors: [
            { key: 'bare', name: 'Bare', signals: {} },
            'sentry',
            'sentry',
          ],
        },
        stacks: ['nextjs'],
      }),
    ).toEqual([
      {
        field: 'tools.own',
        message: expect.stringMatching(
          /^error-tracking has no tool nobody-errors\. Give the full entry:/,
        ),
      },
      {
        field: 'tools',
        message:
          'sentry is listed more than once. List each tool once, as own or as a competitor.',
      },
    ]);
    expect(
      problems({
        job: 'Add flags',
        requests: { add: 'Add flags.' },
        tools: { own: 'acme-flags' },
      }),
    ).toEqual([
      {
        field: 'tools.own',
        message:
          "acme-flags isn't a tool in this version of agentpicks' catalogue. Give the full entry: key, name and signals, and optionally domain; or, for a tool DevTune's catalogue has added since, update agentpicks.",
      },
    ]);
  });

  it('takes a catalogue tool by key in a job or a copy, which its runs here leave for DevTune to recognise', () => {
    const job = resolveSetup('flags', {
      job: 'Add feature flags',
      requests: { add: 'Add feature flags to this app.' },
      tools: {
        own: {
          key: 'acme-flags',
          name: 'Acme Flags',
          signals: { packages: { npm: ['@acme/flags'] } },
        },
        competitors: ['posthog'],
      },
      stacks: ['nextjs'],
    });
    expect('setup' in job && job.setup.unrecognised).toEqual(['posthog']);

    // A copy recognises its category's tools by its early stop and is custom once it measures another catalogue tool.
    const copyFile = {
      id: '11111111-1111-4111-8111-111111111111',
      from: 'error-tracking',
      tools: { own: 'sentry', competitors: ['clerk'] },
      stacks: ['nextjs'],
    };
    const clerk = { tool_key: 'clerk', display_name: 'Clerk', signals: null };
    const copy = resolveSetup('my-errors', copyFile, [clerk]);
    expect('setup' in copy && copy.setup).toMatchObject({
      unrecognised: ['clerk'],
      customReason: "it measures clerk, which error-tracking doesn't",
    });
    expect(resolveSetup('my-errors', copyFile, [])).toHaveProperty('setup');
    const { id: _id, ...unlinked } = copyFile;
    expect(resolveSetup('my-errors', unlinked)).toHaveProperty('setup');
    expect(resolveSetup('my-errors', copyFile)).toHaveProperty('setup');
    const unedited = resolveSetup('error-tracking', {
      from: 'error-tracking',
      tools: { own: 'sentry' },
      stacks: ['nextjs'],
    });
    expect('setup' in unedited && unedited.setup).toMatchObject({
      unrecognised: [],
      customReason: null,
    });
  });

  it("counts a catalogue tool the linked setup measures beside your tool and competitors as one a run here can't recognise", () => {
    const job = {
      job: 'Add feature flags',
      requests: { add: 'Add feature flags to this app.' },
      tools: {
        own: {
          key: 'acme-flags',
          name: 'Acme Flags',
          signals: { packages: { npm: ['@acme/flags'] } },
        },
      },
      stacks: ['nextjs'],
    };
    // PostHog is neither yours nor a competitor, so the file can't name it, and DevTune sends no signals for it.
    const held = [
      { tool_key: 'acme-flags', display_name: 'Acme Flags', signals: {} },
      { tool_key: 'posthog', display_name: 'PostHog', signals: null },
    ];
    expect(resolveSetup('flags', job, held)).toMatchObject({
      setup: { unrecognised: ['posthog'] },
    });
    expect(resolveSetup('flags', job)).toMatchObject({
      setup: { unrecognised: [] },
    });
  });

  it("takes a key DevTune holds without signals as a catalogue tool, checks requests against a key's names, and needs no early stop for one", () => {
    const job = {
      job: 'Add feature flags',
      requests: { add: 'Add feature flags to this app.' },
      tools: {
        own: {
          key: 'acme-flags',
          name: 'Acme Flags',
          signals: {
            packages: { npm: ['@acme/flags'] },
            yieldsTo: ['hogflags'],
          },
        },
        competitors: ['hogflags'],
      },
      stacks: ['nextjs'],
    };
    // A key this version doesn't know, which the linked DevTune setup holds as a catalogue tool. Acme Flags yields
    // to it, so no entry stops a run early, which a tool by key excuses.
    const held = [
      { tool_key: 'hogflags', display_name: 'Hog Flags', signals: null },
    ];
    expect(resolveSetup('flags', job, held)).toMatchObject({
      setup: { unrecognised: ['hogflags'] },
    });
    expect(resolveSetup('flags', job)).toEqual({
      problems: [
        {
          field: 'tools.competitors[0]',
          message: expect.stringMatching(/update agentpicks\.$/),
        },
      ],
    });
    // A request naming the tool by its key or by DevTune's name for it.
    for (const text of ['Would hogflags fit?', 'Would Hog Flags fit?'])
      expect(
        resolveSetup(
          'flags',
          { ...job, requests: { ...job.requests, recommend: text } },
          held,
        ),
      ).toEqual({
        problems: [
          {
            field: 'requests.recommend',
            message: expect.stringMatching(
              /^It names Hog Flags, a tool this setup measures/,
            ),
          },
        ],
      });
  });

  it('refuses a stack the category, or a setup without from, doesn’t run in', () => {
    expect(
      problems({ from: 'ci', stacks: ['nextjs', 'rails-own-servers-eu'] }),
    ).toEqual([
      {
        field: 'stacks[1]',
        message: expect.stringMatching(
          /^rails-own-servers-eu doesn't run in ci\. Use one of empty, nextjs,/,
        ),
      },
    ]);
    expect(
      problems({
        job: 'Add flags',
        requests: { add: 'Add flags.' },
        tools: FLAGS,
        stacks: ['rails-own-servers-eu'],
      }),
    ).toEqual([
      {
        field: 'stacks[0]',
        message: expect.stringMatching(
          /^rails-own-servers-eu doesn't run a setup without from\. Use one of /,
        ),
      },
    ]);
  });
});
