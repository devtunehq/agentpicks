/** ABOUTME: Exercises source capture against staged repositories and its count and byte caps. */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAPTURE_SOURCES_PY,
  SOURCE_FILE_LIMIT,
  SOURCE_FILE_BYTES,
  SOURCE_ARTIFACT_BYTES,
} from './capture-sources';
import { RUN_AGENT_SH } from './static-scripts';

function capture(
  files: Record<string, string>,
  changed: Record<string, string>,
  prepare?: (root: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'agent-picks-source-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  const write = (entries: Record<string, string>) => {
    for (const [path, contents] of Object.entries(entries)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
  };
  try {
    git('init', '--quiet');
    write(files);
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--quiet',
      '-m',
      'baseline',
    );
    write(changed);
    prepare?.(root);
    git('add', '.');
    const result = execFileSync('python3', ['-c', CAPTURE_SOURCES_PY, 'HEAD'], {
      cwd: root,
      maxBuffer: SOURCE_ARTIFACT_BYTES + 1,
    });
    return {
      files: JSON.parse(result.toString()) as Record<string, string>,
      bytes: result.length,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('post-change source capture', () => {
  it.each(['complete', 'terminated'])(
    'stores complete JSON or an empty artifact when capture is %s',
    (state) => {
      const root = mkdtempSync(join(tmpdir(), 'agent-picks-source-atomic-'));
      const start = RUN_AGENT_SH.indexOf(': > $OUT/source-files.json');
      const end = RUN_AGENT_SH.indexOf('rm -f $S/diff.full', start);
      const complete = '{"hooks.ts":"console.error(error);"}';
      try {
        writeFileSync(join(root, 'source-files.json'), 'previous artifact');
        writeFileSync(
          join(root, 'capture-sources.py'),
          state === 'complete'
            ? `import sys\nsys.stdout.write(${JSON.stringify(complete)})\n`
            : `import os, signal, sys\nsys.stdout.write('{"hooks.ts":')\nsys.stdout.flush()\nos.kill(os.getpid(), signal.SIGTERM)\n`,
        );
        execFileSync('bash', ['-c', RUN_AGENT_SH.slice(start, end)], {
          env: { ...process.env, S: root, OUT: root, BASE: 'HEAD' },
          stdio: 'pipe',
        });
        expect(readFileSync(join(root, 'source-files.json'), 'utf8')).toBe(
          state === 'complete' ? complete : '',
        );
        expect(existsSync(join(root, 'source-files.json.tmp'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('reads staged changed files and unchanged local imports, requires and re-exports', () => {
    const baseline = {
      'hooks.ts': '',
      'errors.ts': 'export const report = console.error;',
      'barrel.ts': "export { report } from './errors';",
      'lib/other.ts': 'module.exports = console.error;',
      'unused.ts': 'console.error("unused");',
    };
    const changed = {
      'hooks.ts':
        "import { report } from './barrel'; const other = require('@/lib/other'); export const onRequestError = err => report(err);",
    };
    expect(capture(baseline, changed).files).toEqual({
      'hooks.ts': changed['hooks.ts'],
      'barrel.ts': baseline['barrel.ts'],
      'errors.ts': baseline['errors.ts'],
      'lib/other.ts': baseline['lib/other.ts'],
    });
  });

  it.each([
    ['.js', '.ts'],
    ['.js', '.tsx'],
    ['.mjs', '.mts'],
    ['.cjs', '.cts'],
  ])(
    'captures an unchanged %s import from its %s source',
    (importExt, sourceExt) => {
      const imported = `import { report } from './errors${importExt}';`;
      const report = 'export function report(err) { console.error(err); }';
      const handler = 'export const onRequestError = err => report(err);';
      const result = capture(
        { 'hooks.ts': imported, [`errors${sourceExt}`]: report },
        { 'hooks.ts': imported + '\n' + handler },
      );
      expect(result.files).toEqual({
        'hooks.ts': imported + '\n' + handler,
        [`errors${sourceExt}`]: report,
      });
    },
  );

  it.each(['.js', '.mjs', '.cjs'])(
    'prefers the exact %s module over TypeScript sources',
    (extension) => {
      const imported = `import { report } from './errors${extension}';`;
      const report = 'export function report(err) { console.error(err); }';
      const handler = 'export const onRequestError = err => report(err);';
      const alternatives = Object.fromEntries(
        ['.ts', '.tsx', '.mts', '.cts'].map((ext) => [
          `errors${ext}`,
          'export const ignored = true;',
        ]),
      );
      const result = capture(
        {
          ...alternatives,
          'hooks.ts': imported,
          [`errors${extension}`]: report,
        },
        { 'hooks.ts': imported + '\n' + handler },
      );
      expect(result.files).toEqual({
        'hooks.ts': imported + '\n' + handler,
        [`errors${extension}`]: report,
      });
    },
  );

  it('caps file count and excludes oversized files and symlinks', () => {
    const changed = Object.fromEntries(
      Array.from({ length: SOURCE_FILE_LIMIT + 10 }, (_, i) => [
        `file-${i}.ts`,
        'export const value = 1;',
      ]),
    );
    const result = capture(
      { 'baseline.ts': '' },
      { ...changed, 'aaa-huge.ts': 'x'.repeat(SOURCE_FILE_BYTES + 1) },
      (root) => symlinkSync('/etc/hosts', join(root, 'linked.ts')),
    );
    expect(Object.keys(result.files)).toHaveLength(SOURCE_FILE_LIMIT);
    expect(result.files['aaa-huge.ts']).toBeUndefined();
    expect(result.files['linked.ts']).toBeUndefined();
  });

  it('caps serialized bytes and keeps complete UTF-8 files', () => {
    const contents = '// ' + 'é'.repeat((SOURCE_FILE_BYTES - 4) / 2);
    const result = capture(
      { 'baseline.ts': '' },
      {
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`file-${i}.ts`, contents]),
        ),
        'zzz-small.ts': 'export const small = true;',
      },
    );
    expect(result.bytes).toBeLessThanOrEqual(SOURCE_ARTIFACT_BYTES);
    expect(result.files['zzz-small.ts']).toBeUndefined();
    expect(Object.keys(result.files).length).toBeGreaterThan(0);
    expect(Object.keys(result.files).length).toBeLessThan(20);
    expect(Object.values(result.files).every((text) => text === contents)).toBe(
      true,
    );
  });
});
