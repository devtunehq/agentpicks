/**
 * ABOUTME: Covers `agentpicks run` argument parsing and the named refusals for an unknown
 * category or stack, and for a stack or repository the Docker host's architecture cannot run.
 */
import { describe, expect, it } from 'vitest';

import type { RepositoryInstall } from '../assets/repository-scripts';
import { CATEGORY_REQUESTS } from '../catalogue/categories';
import {
  ENVIRONMENTS,
  environmentRunsIn,
  findEnvironment,
} from '../catalogue/environments';
import type { SandboxPlatform } from '../sandbox/platform';
import {
  assertRepositoryRuns,
  assertStackRuns,
  DEFAULT_OUT_DIR,
  parseRunArgs,
  resolveTest,
} from './args';
import {
  StackArchitectureError,
  UnknownCategoryError,
  UnknownStackError,
  UsageError,
} from './errors';

describe('parseRunArgs', () => {
  it('reads every flag, with one run to ./agentpicks-runs by default', () => {
    expect(parseRunArgs(['--category', 'ci', '--stack', 'nextjs'])).toEqual({
      category: 'ci',
      stack: 'nextjs',
      runs: 1,
      agent: undefined,
      model: undefined,
      out: DEFAULT_OUT_DIR,
    });
    expect(
      parseRunArgs([
        '--category=ci',
        '--stack=rails',
        '--runs=3',
        '--agent=codex',
        '--model=gpt-6',
        '--out=/tmp/runs',
      ]),
    ).toMatchObject({
      runs: 3,
      agent: 'codex',
      model: 'gpt-6',
      out: '/tmp/runs',
    });
  });

  it.each([
    [
      ['--category', 'ci', '--stack', 'nextjs', '--runs', '0'],
      /--runs takes a whole number/,
    ],
    [
      ['--category', 'ci', '--stack', 'nextjs', '--runs', '2.5'],
      /--runs takes a whole number/,
    ],
    [
      ['--category', 'ci', '--stack', 'nextjs', '--repo', '.'],
      /Pass --stack or --repo, not both/,
    ],
    [
      ['--category', 'ci', '--stack', 'nextjs', '--ref', 'abc123'],
      /--ref names a commit of --repo; pass --repo too/,
    ],
    [
      ['--category', 'ci', '--stack', 'nextjs', '--intent', 'hosted'],
      /Unknown option '--intent'/,
    ],
  ])('refuses %j', (argv, message) => {
    expect(() => parseRunArgs(argv)).toThrow(UsageError);
    expect(() => parseRunArgs(argv)).toThrow(message);
  });

  it('asks for a missing category or stack, listing the values', () => {
    expect(() => parseRunArgs(['--stack', 'nextjs'])).toThrow(
      new UnknownCategoryError(
        'Choose a category with --category: authentication, payments, transactional-email, databases, error-tracking, ci.',
      ),
    );
    expect(() => parseRunArgs(['--category', 'ci'])).toThrow(
      /Or test your repository with --repo <path>\./,
    );
    expect(() => parseRunArgs(['--category', 'ci'])).toThrow(UnknownStackError);
  });

  it('reads --repo and --ref in place of --stack', () => {
    expect(
      parseRunArgs(['--category', 'ci', '--repo', '.', '--ref', 'v1.2']),
    ).toMatchObject({ stack: undefined, repo: '.', ref: 'v1.2' });
  });
});

describe('resolveTest', () => {
  it("resolves the category's add request for the stack", () => {
    const test = resolveTest({ category: 'error-tracking', stack: 'nextjs' });
    expect(test.category.slug).toBe('error-tracking');
    expect(test.environment.starter).toBe('nextjs');
    expect(test.intent).toBe('add');
    expect(test.prompt).toBe(
      'Add error tracking to this app: capture unhandled errors on the server and in the browser, if the app has one, and add a /debug-error route that throws.',
    );
  });

  it('asks the add request in every category and stack, which no stack leaves out', () => {
    for (const category of CATEGORY_REQUESTS)
      for (const environment of ENVIRONMENTS.filter((env) =>
        environmentRunsIn(env.slug, category.slug),
      ))
        expect(
          resolveTest({ category: category.slug, stack: environment.slug })
            .intent,
        ).toBe('add');
  });

  it('tests a repository in every category, in the shared customer_repository environment with no prefix', () => {
    for (const category of CATEGORY_REQUESTS) {
      const test = resolveTest({ category: category.slug, repo: '.' });
      expect(test.environment.slug).toBe('customer_repository');
      expect(test.environment.promptPrefix).toBeUndefined();
      expect(test.intent).toBe('add');
    }
  });

  it('refuses an unknown category, listing the categories', () => {
    expect(() => resolveTest({ category: 'logging', stack: 'nextjs' })).toThrow(
      new UnknownCategoryError(
        'There is no category logging. Choose one of: authentication, payments, transactional-email, databases, error-tracking, ci.',
      ),
    );
  });

  it('refuses an unknown stack, and a stack scoped to another category, listing the valid stacks', () => {
    expect(() => resolveTest({ category: 'ci', stack: 'django' })).toThrow(
      UnknownStackError,
    );
    // rails-own-servers-eu runs only in error tracking.
    expect(() =>
      resolveTest({ category: 'ci', stack: 'rails-own-servers-eu' }),
    ).toThrow(
      /There is no stack rails-own-servers-eu for ci\. Choose one of: .*nextjs-github-actions/,
    );
    expect(() =>
      resolveTest({ category: 'ci', stack: 'rails-own-servers-eu' }),
    ).not.toThrow(/rails-own-servers-eu,/);
  });
});

describe('assertStackRuns', () => {
  it.each(['rails', 'rails-own-servers-eu'])(
    'refuses %s on arm64, naming Rails',
    (slug) => {
      const environment = findEnvironment(slug)!;
      expect(() => assertStackRuns(environment, 'linux/arm64')).toThrow(
        StackArchitectureError,
      );
      expect(() => assertStackRuns(environment, 'linux/arm64')).toThrow(
        `Rails isn't available on arm64 machines yet, so --stack ${slug} can't run here. Choose another stack.`,
      );
      expect(() => assertStackRuns(environment, 'linux/amd64')).not.toThrow();
    },
  );

  it('runs every other stack on both platforms', () => {
    for (const environment of ENVIRONMENTS.filter((e) => e.starter !== 'rails'))
      for (const platform of ['linux/amd64', 'linux/arm64'] as const)
        expect(() => assertStackRuns(environment, platform)).not.toThrow();
  });
});

describe('assertRepositoryRuns', () => {
  it('refuses a Ruby repository on arm64, naming the fix', () => {
    expect(() =>
      assertRepositoryRuns(
        { node: null, python: null, ruby: 'bundler' },
        'linux/arm64',
      ),
    ).toThrow(/Ruby isn't available on arm64.*x86_64 machine/);
  });

  it.each([
    [{ node: null, python: null, ruby: 'bundler' }, 'linux/amd64'],
    [{ node: 'pnpm', python: 'uv', ruby: null }, 'linux/arm64'],
  ] satisfies [RepositoryInstall, SandboxPlatform][])(
    'runs %j on %s',
    (install, platform) => {
      expect(() => assertRepositoryRuns(install, platform)).not.toThrow();
    },
  );
});
