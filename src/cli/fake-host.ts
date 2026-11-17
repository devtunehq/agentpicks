/**
 * ABOUTME: A machine for CLI tests: the files, commands on PATH (with their `--version` output),
 * environment and platform a test gives it, at a fixed clock; and a Docker whose image build lands
 * the sandbox image in it.
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

/**
 * `docker` and `docker build` for CLI tests: every command succeeds, and `image inspect` finds the
 * sandbox image for `platform` once a build has run, as it does on a machine whose builds load into
 * its own Docker. `record` sees each command.
 */
export function fakeImageDocker(
  platform: string,
  record: (args: string[]) => void = () => {},
) {
  let built = false;
  return {
    run: async (args: string[]) => {
      record(args);
      const found = built && args[0] === 'image' && args[1] === 'inspect';
      return {
        exitCode: 0,
        stdout: found ? `${platform}\n` : 'sha256:image\n',
        stderr: '',
      };
    },
    build: async () => ((built = true), 0),
  };
}
