/**
 * ABOUTME: Runs the package's own repository reader on a real older git, Ubuntu 24.04's 2.43, in
 * Docker, each read under strace. Hostile partial clones, each carrying a trap that leaves a
 * marker when git lazy-fetches (a remote helper reached through `remote.origin.vcs`, an
 * `insteadOf` rewrite or `includeIf` in `$HOME/.gitconfig`, satisfied by an alias), are refused
 * before any object is read, and no marker appears; a git that drops GIT_NO_LAZY_FETCH, as an
 * unpatched 2.43 ignores it, then fires the trap without the refusal. A full clone carrying the
 * same traps and every other config, hook and alias that could run a command reads normally and
 * runs nothing but git. Skips, printing why, when `docker info` fails.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const IMAGE = 'ubuntu:24.04';

/** Each hostile partial clone, by the trap it carries and the partial-clone key that makes it one. */
const HOSTILE = {
  'vcs-none': { key: 'remote.origin.promisor', firesUnderAllowlist: true },
  'vcs-empty': { key: 'remote.origin.promisor', firesUnderAllowlist: false },
  insteadof: { key: 'remote.origin.promisor', firesUnderAllowlist: true },
  includeif: { key: 'remote.origin.promisor', firesUnderAllowlist: true },
  partialclonefilter: {
    key: 'remote.origin.partialclonefilter',
    firesUnderAllowlist: true,
  },
  'extensions-partialclone': {
    key: 'extensions.partialclone',
    firesUnderAllowlist: true,
  },
} as const;
type Hostile = keyof typeof HOSTILE;

/** Every hook git 2.43 documents, each pointed at the trap in the full clone. */
const HOOKS =
  'applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-receive update proc-receive post-receive post-update reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist p4-pre-submit post-index-change';

/** The subcommands the reader runs; an alias or pager may be set for each. */
const READER_COMMANDS = 'version rev-parse config ls-tree cat-file remote';

/**
 * Builds the clones inside the container with the distribution's git. `/fx/unpatched/git` drops
 * GIT_NO_LAZY_FETCH, which Ubuntu backports to 2.43 and an unpatched 2.43 ignores. A partial
 * clone's alias trap touches `/fx/<kind>.marker`; the full clone's traps append their name to
 * `/fx/trap.log`.
 */
const SETUP_SH = `set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends git ca-certificates strace >/dev/null
export GIT_AUTHOR_NAME=d GIT_AUTHOR_EMAIL=d@example.com GIT_COMMITTER_NAME=d GIT_COMMITTER_EMAIL=d@example.com
mkdir -p /fx/unpatched /fx/hooks && cd /fx
printf '#!/bin/sh\\nunset GIT_NO_LAZY_FETCH\\nexec /usr/bin/git "$@"\\n' > unpatched/git
printf '#!/bin/sh\\necho "$*" >> /fx/trap.log\\n' > trap
chmod +x unpatched/git trap
git init -q -b main src
printf '{"name":"app","private":true}\\n' > src/package.json
printf '{"lockfileVersion":3}\\n' > src/package-lock.json
printf '* filter=trap diff=trap\\n' > src/.gitattributes
git -C src add -A && git -C src commit -qm first
git -C src config uploadpack.allowFilter true
partial() {
  git clone -q --filter=blob:none --no-checkout file:///fx/src "$1"
  for key in remote.origin.promisor remote.origin.partialclonefilter extensions.partialclone; do
    git -C "$1" config --unset "$key" || true
  done
}
trap_alias() { git -C "$1" config "alias.remote-$2" "!touch /fx/$1.marker; false"; }

partial vcs-none
git -C vcs-none config remote.origin.promisor true
git -C vcs-none config remote.origin.vcs none
trap_alias vcs-none none

partial vcs-empty
git -C vcs-empty config remote.origin.promisor true
git -C vcs-empty config remote.origin.vcs ''
trap_alias vcs-empty ''

partial insteadof
git -C insteadof config remote.origin.promisor true
git -C insteadof config remote.origin.url https://example.invalid/app.git
git -C insteadof config url.none://example.invalid/.insteadOf https://example.invalid/
trap_alias insteadof none

partial includeif
printf '[remote "origin"]\\n\\tpromisor = true\\n\\tvcs = none\\n[alias]\\n\\tremote-none = "!touch /fx/includeif.marker; false"\\n' > includeif.inc

partial partialclonefilter
git -C partialclonefilter config core.repositoryformatversion 0
git -C partialclonefilter config remote.origin.partialclonefilter blob:none
git -C partialclonefilter config remote.origin.vcs none
trap_alias partialclonefilter none

partial extensions-partialclone
git -C extensions-partialclone config core.repositoryformatversion 1
git -C extensions-partialclone config extensions.partialClone origin
git -C extensions-partialclone config remote.origin.vcs none
trap_alias extensions-partialclone none

git clone -q --no-checkout file:///fx/src full
f() { git -C full config "$@"; }
f remote.origin.url https://example.invalid/app.git
f url.none://example.invalid/.insteadOf https://example.invalid/
f remote.origin.vcs none
f alias.remote-none '!/fx/trap alias-remote-none'
f alias.remote- '!/fx/trap alias-remote-'
for c in ${READER_COMMANDS}; do
  f "alias.$c" "!/fx/trap alias-$c"
  f "pager.$c" "/fx/trap pager-$c"
done
f core.pager '/fx/trap core.pager'
f core.fsmonitor '/fx/trap core.fsmonitor'
f core.hooksPath /fx/hooks
for h in ${HOOKS}; do printf '#!/bin/sh\\n/fx/trap hook-%s\\n' "$h" > "hooks/$h"; chmod +x "hooks/$h"; done
f core.alternateRefsCommand '/fx/trap core.alternateRefsCommand'
echo /fx/src/.git/objects > full/.git/objects/info/alternates
f core.sshCommand '/fx/trap core.sshCommand'
f core.askPass '/fx/trap core.askPass'
f core.gitProxy '/fx/trap core.gitProxy'
f core.editor '/fx/trap core.editor'
f sequence.editor '/fx/trap sequence.editor'
f credential.helper '!/fx/trap credential.helper'
f diff.external '/fx/trap diff.external'
f diff.trap.textconv '/fx/trap diff.textconv'
f filter.trap.process '/fx/trap filter.process'
f filter.trap.smudge '/fx/trap filter.smudge'
f filter.trap.clean '/fx/trap filter.clean'
f gpg.program '/fx/trap gpg.program'
f remote.origin.uploadpack '/fx/trap remote.uploadpack'
f remote.origin.receivepack '/fx/trap remote.receivepack'
f gc.auto 1
f gc.autoDetach false
f maintenance.auto true
f protocol.allow always

# Last, so no clone above runs it: the user's global config, with a protected-only trap.
printf '[includeIf "gitdir:/fx/includeif/"]\\n\\tpath = /fx/includeif.inc\\n[uploadpack]\\n\\tpackObjectsHook = /fx/trap uploadpack.packObjectsHook\\n' > /root/.gitconfig
`;

/** Reads one repository with the package's reader and prints the outcome. */
const READ_MJS = `import { readRepository } from './repository.mjs';
const [dir, ref] = process.argv.slice(2);
try {
  const s = readRepository(dir, ref || undefined);
  console.log(JSON.stringify({ commit: s.commit, files: s.files }));
} catch (e) {
  console.log(JSON.stringify({ error: e.name, message: e.message }));
}
`;

/**
 * Runs in the container with the host's node. Each read runs under `strace -f -e trace=execve`,
 * as shipped and through the git that drops GIT_NO_LAZY_FETCH, at HEAD and at `main`. Then, on
 * each hostile clone, the controls: one object read without the reader, with its environment,
 * through each git, then with plain git.
 */
const RUNNER_MJS = `import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { hostGitEnv } from './repository.mjs';
const hostile = ${JSON.stringify(Object.keys(HOSTILE))};
const traced = (dir) =>
  [false, true].flatMap((unpatched) =>
    ['', 'main'].map((ref) => {
      const out = mkdtempSync('/tmp/trace-');
      const env = { ...process.env, PATH: (unpatched ? '/fx/unpatched:' : '') + process.env.PATH };
      const r = spawnSync('strace', ['-f', '-ff', '-qq', '-s', '1024', '-e', 'trace=execve', '-e', 'signal=none', '-o', out + '/t', process.execPath, '/fx/read.mjs', dir, ref], { env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error('strace: ' + r.stderr);
      const execs = [];
      for (const f of readdirSync(out))
        for (const line of readFileSync(out + '/' + f, 'utf8').split('\\n')) {
          const m = /^execve\\("([^"]*)", \\[(.*)\\], 0x[0-9a-f]+ \\/\\* \\d+ vars \\*\\/\\) = 0$/.exec(line);
          if (m) execs.push({ path: m[1], argv: [...m[2].matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map((x) => x[1]) });
        }
      rmSync(out, { recursive: true });
      return { unpatched, ref, result: JSON.parse(r.stdout), execs };
    }),
  );
const out = { version: spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim(), kinds: {} };
out.full = {
  head: spawnSync('git', ['-C', '/fx/src', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  reads: traced('/fx/full'),
  trapLog: existsSync('/fx/trap.log') ? readFileSync('/fx/trap.log', 'utf8') : null,
};
for (const kind of hostile) {
  const dir = '/fx/' + kind;
  const marker = dir + '.marker';
  const reads = traced(dir);
  const markerAfterReader = existsSync(marker);
  rmSync(marker, { force: true });
  const control = (bin, env) => {
    const r = spawnSync(bin, ['--no-pager', '--git-dir=' + dir + '/.git', 'cat-file', '-p', 'main:package.json'], { env, encoding: 'utf8' });
    const fired = existsSync(marker);
    rmSync(marker, { force: true });
    return { status: r.status, stderr: r.stderr.trim(), fired };
  };
  out.kinds[kind] = {
    reads,
    markerAfterReader,
    shipped: control('/usr/bin/git', hostGitEnv()),
    unpatched: control('/fx/unpatched/git', hostGitEnv()),
    plain: control('/usr/bin/git', process.env),
  };
}
console.log(JSON.stringify(out));
`;

function dockerUnavailable(): string | null {
  const r = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (r.error) return r.error.message;
  if (r.status !== 0)
    return r.stderr.trim().split('\n')[0] ?? `exit ${r.status}`;
  return null;
}

const skipReason = dockerUnavailable();
if (skipReason) {
  process.stderr.write(
    `Skipping the older-git repository spec: docker info failed (${skipReason})\n`,
  );
}

interface Exec {
  path: string;
  argv: string[];
}

interface TracedRead {
  unpatched: boolean;
  ref: string;
  result: { commit?: string; error?: string; message?: string };
  execs: Exec[];
}

interface Control {
  status: number;
  stderr: string;
  fired: boolean;
}

interface Result {
  version: string;
  full: { head: string; reads: TracedRead[]; trapLog: string | null };
  kinds: Record<
    Hostile,
    {
      reads: TracedRead[];
      markerAfterReader: boolean;
      shipped: Control;
      unpatched: Control;
      plain: Control;
    }
  >;
}

/** The programs a read may execute: node, which strace starts, and git. */
const PROGRAMS = ['/node/bin/node', '/usr/bin/git', '/fx/unpatched/git'];

/** The git subcommand of an exec, past the global options the reader passes. */
function subcommand(argv: string[]): string | undefined {
  let i = 1;
  while (argv[i]?.startsWith('-') && argv[i] !== '--version')
    i += argv[i] === '-C' ? 2 : 1;
  return argv[i];
}

function gitCommands(reads: TracedRead[]): Set<string | undefined> {
  return new Set(
    reads.flatMap((r) =>
      r.execs
        .filter((e) => e.path !== PROGRAMS[0])
        .map((e) => subcommand(e.argv)),
    ),
  );
}

describe.skipIf(skipReason !== null)(
  'the repository reader on git 2.43 in Docker',
  () => {
    let dir: string;
    let result: Result;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'agentpicks-old-git-'));
      await build({
        entryPoints: [resolve(__dirname, 'repository.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        outfile: join(dir, 'repository.mjs'),
        logLevel: 'error',
      });
      writeFileSync(join(dir, 'setup.sh'), SETUP_SH);
      writeFileSync(join(dir, 'read.mjs'), READ_MJS);
      writeFileSync(join(dir, 'runner.mjs'), RUNNER_MJS);
      const nodeHome = dirname(dirname(process.execPath));
      const r = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--volume',
          `${dir}:/t:ro`,
          '--volume',
          `${nodeHome}:/node:ro`,
          IMAGE,
          'bash',
          '-c',
          'bash /t/setup.sh && cp /t/*.mjs /fx/ && /node/bin/node /fx/runner.mjs',
        ],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
      result = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
    }, 10 * 60_000);

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('runs git 2.43', () => {
      expect(result.version).toMatch(/^git version 2\.43\./);
    });

    it.each(Object.keys(HOSTILE) as Hostile[])(
      'refuses the %s partial clone before reading any object, and its trap never fires',
      (kind) => {
        const k = result.kinds[kind];
        expect(k.reads).toHaveLength(4);
        for (const read of k.reads) {
          expect(read.result.error).toBe('UnsupportedGitError');
          expect(read.result.message).toContain(
            `/fx/${kind} is a partial clone (${HOSTILE[kind].key})`,
          );
          expect(read.execs.map((e) => e.path)).toEqual(
            expect.arrayContaining([PROGRAMS[0]]),
          );
          for (const e of read.execs) expect(PROGRAMS).toContain(e.path);
        }
        // Discovery, the version and the config; never ls-tree or cat-file.
        expect(gitCommands(k.reads)).toEqual(
          new Set(['rev-parse', '--version', 'config']),
        );
        expect(k.markerAfterReader).toBe(false);
      },
    );

    it.each(Object.keys(HOSTILE) as Hostile[])(
      'shows the %s trap is live: the reader’s environment alone stops it only where GIT_NO_LAZY_FETCH is honoured',
      (kind) => {
        const k = result.kinds[kind];
        expect(k.shipped.status).not.toBe(0);
        expect(k.shipped.fired).toBe(false);
        expect(k.unpatched.status).not.toBe(0);
        expect(k.unpatched.fired).toBe(HOSTILE[kind].firesUnderAllowlist);
        if (!HOSTILE[kind].firesUnderAllowlist)
          expect(k.unpatched.stderr).toContain("transport '' not allowed");
        expect(k.plain.fired).toBe(true);
      },
    );

    it('reads a full clone carrying every trap, and runs nothing but git', () => {
      const { head, reads, trapLog } = result.full;
      expect(reads).toHaveLength(4);
      for (const read of reads) {
        expect(read.result).toEqual({ commit: head, files: 3 });
        for (const e of read.execs) expect(PROGRAMS).toContain(e.path);
      }
      expect(gitCommands(reads)).toEqual(
        new Set([
          'rev-parse',
          '--version',
          'config',
          'ls-tree',
          'cat-file',
          'remote',
        ]),
      );
      expect(trapLog).toBeNull();
    });
  },
);
