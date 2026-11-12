/**
 * ABOUTME: A machine for CLI tests: the files, commands on PATH (with their `--version` output),
 * environment and platform a test gives it, at a fixed clock.
 */
import type { HostIo } from './host';

export const FAKE_HOME = '/home/dev';
export const FAKE_NOW = Date.parse('2026-11-11T12:00:00Z');

export function fakeHost({
  files = {},
  commands = {},
  env = {},
  platform = 'linux',
}: {
  files?: Record<string, string>;
  /** Command name to its `--version` output. */
  commands?: Record<string, string>;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
} = {}): HostIo {
  return {
    env,
    home: FAKE_HOME,
    platform,
    arch: 'x64',
    which: (command) =>
      Object.hasOwn(commands, command) ? `/usr/local/bin/${command}` : null,
    version: (path) => commands[path.split('/').at(-1)!] ?? null,
    readFile: (path) => files[path] ?? null,
    now: () => FAKE_NOW,
  };
}
