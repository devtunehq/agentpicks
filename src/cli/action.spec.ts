/**
 * ABOUTME: Checks the GitHub Action in action.yml against the CLI it wraps: `setup` is the setup
 * `agentpicks run <setup>` takes, and every other run input is a flag of the same name that both
 * `run <setup>` and `run --category` accept. Runs the action's script under bash with a stand-in
 * `npx` to check that it runs this package's version, takes exactly one of setup and category,
 * resolves a setup file in the workspace, refuses a Node.js older than 20, and takes the DevTune
 * values from its inputs or from the environment, never a mix, and never as arguments.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import packageJson from '../../package.json';
import { DEFAULT_OUT_DIR, parseRunArgs, parseRunCommand } from './args';

interface ActionStep {
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
}

const action = parse(
  readFileSync(new URL('../../action.yml', import.meta.url), 'utf8'),
) as {
  inputs: Record<string, { default?: string; required?: boolean }>;
  runs: { using: string; steps: ActionStep[] };
};
const step = action.runs.steps.find((s) => s.id === 'run')!;
const script = step.run!;

/** The DevTune inputs, by the variable `devtune-login.ts` reads for each. */
const DEVTUNE_INPUTS: Record<string, string> = {
  'devtune-api-key': 'DEVTUNE_API_KEY',
  'devtune-project-id': 'DEVTUNE_PROJECT_ID',
  'devtune-api-base-url': 'DEVTUNE_API_BASE_URL',
};

/** The inputs passed as `run` flags: all but the setup, which is positional, and the DevTune values. */
const runInputs = Object.keys(action.inputs).filter(
  (name) => name !== 'setup' && !(name in DEVTUNE_INPUTS),
);

/** The variable the run step reads an input from. */
const envName = (input: string) =>
  `INPUT_${input.toUpperCase().replaceAll('-', '_')}`;

/** A valid `run` argv using the input's flag: --repo replaces --stack, which can't go with it. */
function argvWith(input: string): string[] {
  const base =
    input === 'repo'
      ? ['--category', 'error-tracking', '--repo', '.']
      : ['--category', 'error-tracking', '--stack', 'nextjs'];
  if (input === 'category' || input === 'stack' || input === 'repo')
    return base;
  if (input === 'no-upload') return [...base, '--no-upload'];
  return [...base, `--${input}`, input === 'runs' ? '3' : 'value'];
}

describe('action.yml', () => {
  it('is a composite action whose run step reads every input from its environment', () => {
    expect(action.runs.using).toBe('composite');
    for (const name of Object.keys(action.inputs))
      expect(step.env?.[envName(name)]).toBe(`\${{ inputs.${name} }}`);
    // No input is interpolated into the script itself.
    expect(script).not.toContain('${{');
  });

  it.each(runInputs)(
    'passes %s as the run flag of the same name, which the CLI accepts',
    (name) => {
      // repo and out pass the path their input names, resolved in the workspace.
      const flag =
        name === 'no-upload'
          ? 'args+=(--no-upload)'
          : name === 'out'
            ? '--out "$out"'
            : name === 'repo'
              ? `--repo "$(node -p 'require("node:path").resolve(process.env.${envName(name)})')"`
              : `--${name} "$${envName(name)}"`;
      expect(script).toContain(flag);
      expect(() => parseRunArgs(argvWith(name))).not.toThrow();
    },
  );

  it.each(runInputs.filter((name) => name !== 'category'))(
    'passes %s with a setup, which run <setup> accepts as an override',
    (name) => {
      // argvWith's flags after its --category.
      const flags = argvWith(name).slice(2);
      const command = parseRunCommand(['error-tracking', ...flags], {
        picker: false,
      });
      expect(command.kind).toBe('setup');
    },
  );

  it('takes neither setup nor category as required, since the script asks for one', () => {
    expect(action.inputs.setup).toMatchObject({ required: false });
    expect(action.inputs.category).toMatchObject({ required: false });
  });

  it('defaults out to the CLI default', () => {
    expect(action.inputs.out?.default).toBe(DEFAULT_OUT_DIR);
  });

  it('sets up nothing on the runner, so later steps keep their Node.js', () => {
    expect(action.runs.steps.filter((s) => s.uses)).toEqual([]);
  });

  it('never traces the shell, which would print the key', () => {
    expect(script).not.toMatch(/set -[a-z]*x|set -o xtrace/);
  });
});

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentpicks-action-'));
  tempDirs.push(dir);
  return dir;
}

/** A directory holding executables that print what they were given. */
function binDir(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** Stands in for npx: prints the directory it runs in, the DevTune variables it sees, then its arguments. */
const NPX = [
  `printf 'cwd=%s\\n' "$PWD"`,
  ...['DEVTUNE_API_KEY', 'DEVTUNE_PROJECT_ID', 'DEVTUNE_API_BASE_URL'].map(
    (v) => `printf '${v}=%s\\n' "\${${v}-unset}"`,
  ),
  `for a in "$@"; do printf 'arg=%s\\n' "$a"; done`,
].join('\n');

/**
 * Runs the action's script as the composite step would, with every input at its default unless
 * `inputs` sets it and `env` standing for the job's environment.
 */
function runScript({
  inputs = {},
  env = {},
  path = [binDir({ npx: NPX }), dirname(process.execPath)],
  files = [],
  danglingLinks = [],
}: {
  inputs?: Record<string, string>;
  env?: Record<string, string>;
  path?: string[];
  /** Files written into the workspace before the step runs, by their path in it. */
  files?: string[];
  /** Symlinks to a missing target, made in the workspace, by their path in it. */
  danglingLinks?: string[];
}) {
  const cwd = tempDir();
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), '');
  }
  for (const link of danglingLinks) {
    mkdirSync(dirname(join(cwd, link)), { recursive: true });
    symlinkSync(join(cwd, 'missing-target.yaml'), join(cwd, link));
  }
  const runnerTemp = tempDir();
  const output = join(cwd, 'github-output');
  writeFileSync(output, '');
  const stepEnv = Object.fromEntries(
    Object.entries(action.inputs).map(([name, input]) => [
      envName(name),
      inputs[name] ?? input.default ?? '',
    ]),
  );
  // GitHub runs a composite bash step with --noprofile --norc. Without them, bash reads the
  // developer's ~/.bashrc here (Node's stdin is a socket, which bash takes for an ssh session), and a
  // PATH it prepends puts the real npx ahead of the stand-in.
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...env,
      ...stepEnv,
      // A category unless the test sets one, or a setup in its place.
      [envName('category')]:
        inputs.category ?? (inputs.setup ? '' : 'error-tracking'),
      PATH: path.join(':'),
      GITHUB_ACTION_PATH: fileURLToPath(new URL('../..', import.meta.url)),
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: runnerTemp,
    },
  });
  const lines = r.stdout.split('\n');
  const seen = (v: string) =>
    lines.find((l) => l.startsWith(`${v}=`))?.slice(v.length + 1);
  return {
    status: r.status,
    stderr: r.stderr,
    cwd,
    runnerTemp,
    npxCwd: seen('cwd'),
    output: readFileSync(output, 'utf8'),
    args: lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4)),
    devtune: {
      key: seen('DEVTUNE_API_KEY'),
      project: seen('DEVTUNE_PROJECT_ID'),
      base: seen('DEVTUNE_API_BASE_URL'),
    },
  };
}

const JOB_ENV = {
  DEVTUNE_API_KEY: 'dtk_live_job',
  DEVTUNE_PROJECT_ID: 'job-project',
  DEVTUNE_API_BASE_URL: 'https://elsewhere.example/api/v2',
};

describe("the action's script", () => {
  it("runs this package's version of the CLI and names the out directory", () => {
    const run = runScript({ inputs: { stack: 'nextjs' } });
    expect(run.status).toBe(0);
    expect(run.args.slice(0, 3)).toEqual([
      '--yes',
      `@devtune/agentpicks@${packageJson.version}`,
      'run',
    ]);
    expect(run.output).toBe(`bundle-dir=${join(run.cwd, DEFAULT_OUT_DIR)}\n`);
  });

  it('takes every DevTune value from the inputs when the key is set, never as an argument', () => {
    const run = runScript({
      inputs: {
        'devtune-api-key': 'dtk_live_input',
        'devtune-project-id': 'input-project',
      },
      env: JOB_ENV,
    });
    expect(run.devtune).toEqual({
      key: 'dtk_live_input',
      project: 'input-project',
      base: 'unset',
    });
    expect(run.args.join(' ')).not.toMatch(/dtk_live|input-project/);
  });

  it('refuses one DevTune input without the other before running anything', () => {
    const run = runScript({
      inputs: { 'devtune-api-key': 'dtk_live_input' },
      env: JOB_ENV,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'Set both devtune-api-key and devtune-project-id, or neither',
    );
    expect(run.args).toEqual([]);
  });

  it('runs npx outside the checkout, with the repository and out paths resolved in it', () => {
    const run = runScript({ inputs: { repo: '.' } });
    expect(run.status).toBe(0);
    expect(run.npxCwd).toBe(run.runnerTemp);
    expect(run.args).toContain(run.cwd);
    expect(run.args).toContain(join(run.cwd, DEFAULT_OUT_DIR));
  });

  it("keeps the job's DevTune values when the key and project inputs are empty", () => {
    const run = runScript({
      inputs: { 'devtune-api-base-url': 'https://ignored.example/api/v2' },
      env: JOB_ENV,
    });
    expect(run.devtune).toEqual({
      key: 'dtk_live_job',
      project: 'job-project',
      base: 'https://elsewhere.example/api/v2',
    });
  });

  it('refuses a Node.js older than 20 before running anything', () => {
    const run = runScript({
      path: [binDir({ npx: NPX, node: 'echo 18.20.4' })],
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'needs Node.js 20 or later on the runner, not 18.20.4',
    );
    expect(run.args).toEqual([]);
  });

  it('refuses a runner without Node.js', () => {
    const run = runScript({ path: [binDir({ npx: NPX })] });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'needs Node.js 20 or later on the runner, which has none',
    );
  });

  it('runs a setup file by its path in the workspace, with no --category', () => {
    const run = runScript({
      inputs: { setup: 'agentpicks/error-tracking.yaml', repo: '.' },
    });
    expect(run.status).toBe(0);
    expect(run.args.slice(2)).toEqual([
      'run',
      join(run.cwd, 'agentpicks/error-tracking.yaml'),
      '--out',
      join(run.cwd, DEFAULT_OUT_DIR),
      '--repo',
      run.cwd,
    ]);
  });

  it('passes a setup name as it is, for the DevTune setup of that name', () => {
    const run = runScript({ inputs: { setup: 'add-feature-flags' } });
    expect(run.status).toBe(0);
    expect(run.args.slice(2, 4)).toEqual(['run', 'add-feature-flags']);
    expect(run.args).not.toContain('--category');
  });

  it('refuses a setup name that is also a setup file in the workspace, naming its path', () => {
    const run = runScript({
      inputs: { setup: 'error-tracking' },
      files: ['agentpicks/error-tracking.yml'],
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('set setup: agentpicks/error-tracking.yml');
    expect(run.args).toEqual([]);
  });

  it('refuses a setup name whose file in the workspace is a dangling symlink', () => {
    const run = runScript({
      inputs: { setup: 'error-tracking' },
      danglingLinks: ['agentpicks/error-tracking.yaml'],
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('set setup: agentpicks/error-tracking.yaml');
    expect(run.args).toEqual([]);
  });

  it('refuses both a setup and a category before running anything', () => {
    const run = runScript({
      inputs: { setup: 'error-tracking', category: 'error-tracking' },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Set setup or category, not both');
    expect(run.args).toEqual([]);
  });

  it('refuses neither a setup nor a category before running anything', () => {
    const run = runScript({ inputs: { category: '' } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Set setup to a setup file');
    expect(run.args).toEqual([]);
  });
});
