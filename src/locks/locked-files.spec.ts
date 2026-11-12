/**
 * ABOUTME: Checks a committed starter survives every hop byte for byte: the sandbox capture
 * parsed into entries, the generated module's literals, and the packed upload that setup's
 * `unpack` lays down.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { UNPACK_FN } from '../assets/static-scripts';
import { STARTERS } from '../catalogue/environments';
import { LOCKED_STARTERS } from './index';
import {
  entryBytes,
  packEntries,
  parsePackedEntries,
  renderLockedIndexModule,
  renderLockedStarterModule,
  type LockedEntry,
  type LockedStarter,
} from './locked-files';

const binary = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
const tricky =
  'a `tick` and ${notInterpolated} and \\backslash\\ and\r\nCRLF\ttab\n';

const entries: LockedEntry[] = [
  { path: 'empty-dir', kind: 'dir' },
  {
    path: 'bin/run',
    kind: 'file',
    executable: true,
    text: '#!/bin/sh\necho hi\n',
  },
  { path: 'empty.txt', kind: 'file', executable: false, text: '' },
  {
    path: 'icon.ico',
    kind: 'file',
    executable: false,
    base64: binary.toString('base64'),
  },
  {
    path: 'nested/deep/tricky.txt',
    kind: 'file',
    executable: false,
    text: tricky,
  },
  { path: 'CLAUDE.md', kind: 'link', target: 'nested/deep/tricky.txt' },
];

/** Evaluates a rendered module's `LOCKED` value, as the TypeScript compiler would read it. */
function evaluate(source: string): LockedStarter {
  const body = source
    .replace(/^import type .*$/m, '')
    .replace('export const LOCKED: LockedStarter =', 'return');
  return new Function(body)() as LockedStarter;
}

describe('locked files', () => {
  it('parses what it packs, keeping text as text and binary as base64', () => {
    const parsed = parsePackedEntries(packEntries(entries));
    expect(parsed).toEqual(entries);
  });

  it('renders a module whose literals hold the exact bytes', () => {
    const source = renderLockedStarterModule('demo', {
      files: entries,
      locks: [entries[1]!],
    });
    const back = evaluate(source);
    expect(back.files).toEqual(entries);
    expect(back.locks).toEqual([entries[1]]);
    const file = back.files.find((e) => e.path === 'nested/deep/tricky.txt');
    expect(file && file.kind === 'file' && entryBytes(file).toString()).toBe(
      tricky,
    );
  });

  it('is laid down byte for byte by unpack, modes and links included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-picks-unpack-'));
    const packed = join(dir, 'starter.tsv');
    writeFileSync(packed, packEntries(entries));
    const root = join(dir, 'app');
    execFileSync('bash', [
      '-c',
      `set -euo pipefail\n${UNPACK_FN}\nmkdir -p "$1"\nunpack "$1" "$2"`,
      'unpack',
      root,
      packed,
    ]);
    expect(statSync(join(root, 'empty-dir')).isDirectory()).toBe(true);
    expect(statSync(join(root, 'bin/run')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'empty.txt')).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(root, 'empty.txt'))).toHaveLength(0);
    expect(readFileSync(join(root, 'icon.ico')).equals(binary)).toBe(true);
    expect(readFileSync(join(root, 'nested/deep/tricky.txt'), 'utf8')).toBe(
      tricky,
    );
    expect(readlinkSync(join(root, 'CLAUDE.md'))).toBe(
      'nested/deep/tricky.txt',
    );
  });

  it('refuses a malformed capture', () => {
    expect(() => parsePackedEntries('600\tsecret\t\n')).toThrow(/unknown mode/);
    expect(() => parsePackedEntries('nonsense\n')).toThrow(/malformed/);
  });
});

describe('locks index', () => {
  const recipeKeys = [
    'agent-tools',
    'pi-tools',
    ...Object.keys(STARTERS),
  ].sort();

  it('commits exactly one lock per recipe', () => {
    expect(Object.keys(LOCKED_STARTERS).sort()).toEqual(recipeKeys);
  });

  it('renders imports for the recipe keys only, never helper modules', () => {
    const rendered = renderLockedIndexModule(recipeKeys);
    const imported = [...rendered.matchAll(/from '\.\/([a-z0-9-]+)'/g)]
      .map((m) => m[1])
      .filter((k) => k !== 'locked-files');
    expect(imported.sort()).toEqual(recipeKeys);
  });
});
