/**
 * ABOUTME: Bundles the agentpicks CLI into one runnable CommonJS file, dist/cli.js, with its
 * dependencies inlined except the native file-lock addon, and marks it executable.
 */
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const outfile = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Prefer a package's ES module build: jsonc-parser's `main` is a UMD build whose requires
  // esbuild cannot follow.
  mainFields: ['module', 'main'],
  // A native addon can't be inlined; npm installs it beside the CLI as a dependency.
  external: ['fs-native-extensions'],
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'linked',
  logLevel: 'warning',
});
await chmod(outfile, 0o755);
