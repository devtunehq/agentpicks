/**
 * ABOUTME: `agentpicks catalogue [<category>] [--json]`: the keys `agentpicks init`'s flags take.
 * With no category, every category and the stacks a job line can run in; with one, its tool keys
 * and the stacks it runs in, as `setupEnvironments` gives them to init. Plain aligned columns
 * (slug, then name), or one JSON object with --json.
 */
import { parseArgs } from 'node:util';

import {
  CATEGORY_REQUESTS,
  findCategoryRequests,
} from '../catalogue/categories';
import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';
import { setupEnvironments } from '../catalogue/environments';
import { UsageError } from './errors';

interface CatalogueContext {
  out: (line: string) => void;
}

/** Runs `agentpicks catalogue`; an unknown category is a `UsageError` naming how to list them. */
export function catalogueCommand(
  argv: string[],
  ctx: CatalogueContext,
): number {
  const { json, slug } = parseCatalogueArgs(argv);
  const pairs = (items: { slug: string; name: string }[]) =>
    items.map(({ slug, name }) => ({ slug, name }));
  if (slug === null) {
    const categories = pairs(CATEGORY_REQUESTS);
    const stacks = pairs(setupEnvironments('job-'));
    if (json) ctx.out(JSON.stringify({ categories, stacks }, null, 2));
    else
      for (const line of [
        'Categories:',
        ...columns(categories),
        '',
        'Stacks a job line can run in:',
        ...columns(stacks),
      ])
        ctx.out(line);
    return 0;
  }
  const found = findCategoryRequests(slug);
  if (!found)
    throw new UsageError(
      `There is no category ${slug}. List them with: agentpicks catalogue`,
    );
  const category = { slug: found.slug, name: found.name };
  const tools = CATEGORY_TOOLS[found.slug] ?? [];
  const stacks = pairs(setupEnvironments(found.slug));
  if (json) ctx.out(JSON.stringify({ category, tools, stacks }, null, 2));
  else
    for (const line of [
      ...columns([category]),
      '',
      'Tools:',
      ...tools.map((key) => `  ${key}`),
      '',
      'Stacks:',
      ...columns(stacks),
    ])
      ctx.out(line);
  return 0;
}

/** Each item as an indented row: its slug padded to the longest, then its name. */
function columns(items: { slug: string; name: string }[]): string[] {
  const width = Math.max(...items.map((item) => item.slug.length));
  return items.map((item) => `  ${item.slug.padEnd(width)}  ${item.name}`);
}

function parseCatalogueArgs(argv: string[]): {
  json: boolean;
  slug: string | null;
} {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parsed.positionals.length > 1)
    throw new UsageError(
      'Name one category, or none to list them: agentpicks catalogue [<category>] [--json]',
    );
  return { json: parsed.values.json, slug: parsed.positionals[0] ?? null };
}
