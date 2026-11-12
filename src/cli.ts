/**
 * ABOUTME: The `agentpicks` executable's entry point, bundled to dist/cli.js. The sandbox
 * Dockerfile ships beside dist in the package's docker directory.
 */
import { join } from 'node:path';

import { defaultContext, main } from './cli/main';

void main(
  process.argv.slice(2),
  defaultContext(join(__dirname, '..', 'docker')),
).then((code) => {
  process.exitCode = code;
});
