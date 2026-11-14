/**
 * ABOUTME: Fails when the package's root export (`src/index.ts`) reaches a Node built-in other
 * than `node:crypto` through its value imports. The web app's client components import the root
 * export, and a browser bundle cannot load modules such as `node:child_process`, so one such
 * import fails the production build. Type-only imports are skipped: they are erased before
 * bundling. It follows static `import` and `export ... from` between files in this package only,
 * not `import()`, `require()` or the code of other packages.
 */
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript5';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(__dirname, '..');
const BUILTINS = new Set(builtinModules);

/**
 * Built-ins a client bundle already loaded through the root export on a passing web build
 * (`locks/starter-check.ts`). Anything else, such as `node:child_process`, fails the build.
 */
const BUNDLED_BUILTINS = new Set(['node:crypto']);

/** The modules one file loads at runtime: static imports and re-exports that are not type-only. */
function runtimeImports(text: string): string[] {
  const source = ts.createSourceFile('file.ts', text, ts.ScriptTarget.Latest);
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const typeOnly =
        clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
        (clause !== undefined &&
          !clause.name &&
          clause.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      return typeOnly
        ? []
        : [(statement.moduleSpecifier as ts.StringLiteral).text];
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const typeOnly =
        statement.isTypeOnly ||
        (statement.exportClause !== undefined &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.length > 0 &&
          statement.exportClause.elements.every(
            (element) => element.isTypeOnly,
          ));
      return typeOnly
        ? []
        : [(statement.moduleSpecifier as ts.StringLiteral).text];
    }
    return [];
  });
}

function isBuiltin(name: string): boolean {
  return name.startsWith('node:') || BUILTINS.has(name.split('/')[0]!);
}

function resolveRelative(from: string, name: string): string {
  const base = resolve(dirname(from), name);
  const candidate = [
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
  ].find(existsSync);
  if (!candidate) throw new Error(`cannot resolve ${name} from ${from}`);
  return candidate;
}

/** Each Node built-in the entry reaches, with the import chain that reaches it. */
function builtinChains(entry: string): string[] {
  const seen = new Set<string>();
  const chains: string[] = [];
  const visit = (file: string, path: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const chain = [...path, relative(PACKAGE_ROOT, file)];
    for (const name of runtimeImports(readFileSync(file, 'utf8'))) {
      if (isBuiltin(name) && !BUNDLED_BUILTINS.has(name))
        chains.push(`${chain.join(' -> ')} -> ${name}`);
      else if (name.startsWith('.')) visit(resolveRelative(file, name), chain);
    }
  };
  visit(entry, []);
  return chains;
}

describe('root export', () => {
  it('skips type-only imports and keeps value imports', () => {
    expect(
      runtimeImports(
        [
          "import type { HostIo } from './host';",
          "import { type HostIo as Io } from './host-types';",
          "import { spawn } from 'node:child_process';",
          "import { parse, type Options } from './parse';",
          "export type { Setup } from './setup';",
          "export { resolveSetup } from './setup/resolve';",
        ].join('\n'),
      ),
    ).toEqual(['node:child_process', './parse', './setup/resolve']);
  });

  it('reaches no Node built-in a browser bundle cannot load', () => {
    expect(builtinChains(resolve(PACKAGE_ROOT, 'src/index.ts'))).toEqual([]);
  });
});
