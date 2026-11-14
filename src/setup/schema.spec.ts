/**
 * ABOUTME: Holds `schema/setup.v1.json`, the JSON Schema the package publishes, to the setup file
 * schema it is generated from (run with UPDATE_SETUP_SCHEMA=1 to rewrite it; the commit hook formats
 * it), and checks every setup example in the README parses and resolves against the catalogue.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { resolveSetup } from './resolve';
import { setupFileSchema, setupJsonSchema } from './schema';

const PACKAGE_ROOT = join(__dirname, '../..');

/** The YAML blocks in the README that follow a line naming a setup file (`agentpicks/<name>.yaml`). */
function readmeSetups(): { name: string; text: string }[] {
  const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
  return [
    ...readme.matchAll(
      /`agentpicks\/([a-z0-9-]+)\.yaml`[^\n]*\n\n```yaml\n([\s\S]*?)```/g,
    ),
  ].map((match) => ({ name: match[1]!, text: match[2]! }));
}

describe('the setup file schema', () => {
  it('is published as schema/setup.v1.json (rerun with UPDATE_SETUP_SCHEMA=1 after changing the schema)', () => {
    const path = join(PACKAGE_ROOT, 'schema/setup.v1.json');
    if (process.env.UPDATE_SETUP_SCHEMA)
      writeFileSync(path, `${JSON.stringify(setupJsonSchema(), null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(setupJsonSchema());
  });

  it('accepts every setup example in the README, which resolves with no problems', () => {
    const examples = readmeSetups();
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const { name, text } of examples) {
      const parsed = setupFileSchema.safeParse(parse(text));
      expect(parsed.error?.issues, name).toBeUndefined();
      expect(resolveSetup(name, parsed.data!).problems, name).toEqual([]);
    }
  });
});
