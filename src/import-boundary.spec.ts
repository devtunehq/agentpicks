/**
 * ABOUTME: Fails when a file in this open package imports DevTune's private code, which is
 * every `@kit/*` package (including `@kit/agent-picks`) and every relative path that leaves the package.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript5';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(__dirname, '..');

/** Tooling the package may name without depending on private code. */
const ALLOWED_KIT = new Set(['@kit/tsconfig']);

/** Every module a file imports, requires or loads dynamically, outside strings and comments. */
function importedModules(text: string): string[] {
  return ts
    .preProcessFile(text, true, true)
    .importedFiles.map(({ fileName }) => fileName);
}

/** The imports in one file that cross into private code. */
export function boundaryViolations(file: string, text: string): string[] {
  return importedModules(text).filter((name) => {
    if (name.startsWith('@kit/')) return !ALLOWED_KIT.has(name);
    if (!name.startsWith('.')) return false;
    const target = relative(PACKAGE_ROOT, resolve(dirname(file), name));
    return target === '..' || target.startsWith(`..${sep}`);
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('import boundary', () => {
  it('finds private imports in any form', () => {
    const file = join(PACKAGE_ROOT, 'src/run/example.ts');
    expect(
      boundaryViolations(
        file,
        [
          "import { classifyRun } from '@kit/agent-picks';",
          "import type { Json } from '@kit/supabase/database';",
          "export { CATEGORIES } from '../../../agent-picks/src/catalogue/categories';",
          "const signals = await import('../../../agent-picks/src/catalogue/signals');",
          "import { RE2JS } from 're2js';",
          "import { SANDBOX_ROOT } from '../assets/script';",
          'const page = `import { cookies } from "@kit/next";`;',
        ].join('\n'),
      ),
    ).toEqual([
      '@kit/agent-picks',
      '@kit/supabase/database',
      '../../../agent-picks/src/catalogue/categories',
      '../../../agent-picks/src/catalogue/signals',
    ]);
  });

  it('holds for every file under src', () => {
    const violations = sourceFiles(join(PACKAGE_ROOT, 'src')).flatMap((file) =>
      boundaryViolations(file, readFileSync(file, 'utf8')).map(
        (name) => `${relative(PACKAGE_ROOT, file)} imports ${name}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
