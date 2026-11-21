/**
 * ABOUTME: Checks which `.git` makes a directory a repository root for setup files: a folder with
 * `HEAD` or a `.git` file counts, and an empty `.git` folder above it, like a sandbox's leftover
 * mount point in /tmp, doesn't.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitRoot, setupsRoot } from './files';

let top: string;
let project: string;
beforeEach(() => {
  top = mkdtempSync(join(tmpdir(), 'agentpicks-git-root-'));
  project = join(top, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
});
afterEach(() => rmSync(top, { recursive: true, force: true }));

describe('gitRoot', () => {
  it('skips an empty .git folder and finds the repository above it', () => {
    mkdirSync(join(top, '.git'));
    writeFileSync(join(top, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(project, '.git'));
    expect(gitRoot(join(project, 'src'))).toBe(top);
    expect(setupsRoot(project)).toBe(top);
  });

  it('finds a .git folder that holds HEAD', () => {
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    expect(gitRoot(join(project, 'src'))).toBe(project);
  });

  it("finds a linked worktree's or submodule's .git file", () => {
    writeFileSync(
      join(project, '.git'),
      'gitdir: /elsewhere/.git/worktrees/project\n',
    );
    expect(gitRoot(join(project, 'src'))).toBe(project);
  });
});
