/**
 * ABOUTME: Checks the starter comparison passes only the committed starter: an added
 * instruction file or source file, a changed or missing file, all fail; install output
 * on the allow-list does not.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { lockedStarter } from '../assets/locked-starter';
import { entryBytes } from './locked-files';
import { PROJECT_FILES_SH, starterDifferences } from './starter-check';

const sha = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex');

/** The PROJECT_FILES_SH lines of the committed starter, plus `extra` paths with content. */
function onDisk(
  key: string,
  extra: Record<string, string> = {},
  omit: string[] = [],
) {
  const lines = lockedStarter(key)
    .files.filter((e) => e.kind === 'file' && !omit.includes(e.path))
    .map(
      (e) =>
        `${sha(entryBytes(e as Extract<typeof e, { kind: 'file' }>))}  ${e.path}`,
    );
  for (const [path, content] of Object.entries(extra))
    lines.push(`${sha(content)}  ${path}`);
  return lines.join('\n');
}

const nextjs = { starter: 'nextjs' as const, stripInstructions: false };
const noinstr = { starter: 'nextjs' as const, stripInstructions: true };

describe('starterDifferences', () => {
  it('passes the committed starter', () => {
    expect(starterDifferences(nextjs, onDisk('nextjs'))).toEqual([]);
  });

  it('fails an instruction file or source an install hook added', () => {
    expect(
      starterDifferences(
        nextjs,
        onDisk('nextjs', { 'CLAUDE.md': 'x', 'app/injected.tsx': 'y' }),
      ),
    ).toEqual(['added CLAUDE.md', 'added app/injected.tsx']);
  });

  it('allows only install output beyond the starter', () => {
    expect(
      starterDifferences(
        nextjs,
        onDisk('nextjs', {
          'node_modules/next/package.json': '{}',
          '.venv/bin/python': 'x',
          'tmp/cache/bootsnap/x': 'x',
        }),
      ),
    ).toEqual([]);
    // Only at the project root: a nested directory of that name is still project source.
    expect(
      starterDifferences(
        nextjs,
        onDisk('nextjs', { 'app/node_modules/x.js': 'x' }),
      ),
    ).toEqual(['added app/node_modules/x.js']);
  });

  it('fails a changed or missing starter file', () => {
    const changed =
      onDisk('nextjs', {}, ['app/page.tsx']) +
      '\n' +
      `${sha('edited')}  app/page.tsx`;
    expect(starterDifferences(nextjs, changed)).toEqual([
      'changed app/page.tsx',
    ]);
    expect(
      starterDifferences(nextjs, onDisk('nextjs', {}, ['app/layout.tsx'])),
    ).toEqual(['missing app/layout.tsx']);
  });

  it('requires a stripped environment to be without its instruction files', () => {
    expect(
      starterDifferences(noinstr, onDisk('nextjs', {}, ['AGENTS.md'])),
    ).toEqual([]);
    expect(starterDifferences(noinstr, onDisk('nextjs'))).toEqual([
      'added AGENTS.md',
    ]);
  });

  it('lists files outside the install output, in the format starterDifferences reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-picks-starter-check-'));
    for (const [path, content] of Object.entries({
      'app/page.tsx': 'page',
      'node_modules/next/index.js': 'x',
      '.git/HEAD': 'ref',
      'tmp/cache/boot': 'x',
      'tmp/pids/.keep': '',
    })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const listed = execFileSync('bash', ['-c', PROJECT_FILES_SH], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(listed).toEqual([
      `${sha('page')}  app/page.tsx`,
      `${sha('')}  tmp/pids/.keep`,
    ]);
  });
});
