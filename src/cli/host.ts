/**
 * ABOUTME: What the CLI reads from the customer's machine, behind one interface so tests can
 * supply a machine: environment, home directory, platform, files, commands on PATH and their
 * `--version` output, and the clock.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import { parse, type ParseError } from 'jsonc-parser';

export interface HostIo {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  /** The command's absolute path on PATH, or null when it is not there. */
  which(command: string): string | null;
  /** `<path> --version`'s output, or null when it could not run. */
  version(path: string): string | null;
  /** The file's text, or null when it does not exist or cannot be read. */
  readFile(path: string): string | null;
  now(): number;
}

export function hostIo(): HostIo {
  const env = process.env;
  return {
    env,
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
    which(command) {
      for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir) continue;
        const path = join(dir, command);
        try {
          accessSync(path, constants.X_OK);
          if (statSync(path).isFile()) return path;
        } catch {
          // Not in this directory; try the next.
        }
      }
      return null;
    },
    version(path) {
      const r = spawnSync(path, ['--version'], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return r.error ? null : `${r.stdout}\n${r.stderr}`;
    },
    readFile(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };
}

/** The first version number (`1.2.3`, `v1.2.3`, `1.2.3-beta.1`) in a command's `--version` output. */
export function parseVersion(output: string | null): string | null {
  return (
    output?.match(/(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0] ?? null
  );
}

/**
 * A JSON object from a config file, or null when it is missing, malformed or not an object.
 * Read as JSONC, as OpenCode writes its config: comments and trailing commas are allowed.
 */
export function readJsonObject(
  io: Pick<HostIo, 'readFile'>,
  path: string,
): Record<string, unknown> | null {
  const text = io.readFile(path);
  if (text === null) return null;
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0 &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string member of a JSON object, or undefined. */
export function stringField(
  object: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === 'string' && value ? value : undefined;
}
