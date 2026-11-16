/**
 * ABOUTME: The `agentpicks` command. `init` writes a setup file from a wizard; `run` tests a coding agent installed on this machine against
 * a committed starter, or the customer's own repository at one commit, in fresh Docker containers, one run after another, and writes a bundle per
 * completed run, which it uploads to the customer's DevTune project unless --no-upload; `upload`
 * sends bundles written earlier; `login` signs in through the browser, or saves a project API key,
 * for uploads; `list`, `pull` and `push` link setup files to the project's DevTune setups;
 * `cleanup` removes every container and image agentpicks made. Everything is checked, and what a run copies and
 * needs is printed, before the first container starts.
 */
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import packageJson from '../../package.json';
import { DockerSandboxProvider } from '../sandbox/docker';
import type { SandboxPlatform } from '../sandbox/platform';
import type { Sandbox, SandboxProvider } from '../sandbox/provider';
import {
  findSetup,
  formatProblem,
  readSetupFile,
  readSetupFiles,
  SETUPS_DIR,
  setupsRoot,
  WRITE_ONE,
  type SetupOnDisk,
} from '../setup/files';
import type { ResolvedSetup } from '../setup/resolve';
import type { SetupFile } from '../setup/schema';
import { planAgent } from './agent-plan';
import {
  assertRepositoryRuns,
  assertStackRuns,
  categoryPlan,
  parseRunCommand,
  parseUploadArgs,
  setupPlan,
  type RunPlan,
} from './args';
import { CUSTOM_SETUP_CATEGORY_PREFIX } from './bundle';
import { categoryCopyPlan } from './category-copy';
import { resolveCredentials } from './credentials';
import {
  devtuneTarget,
  loginSaved,
  stopRenewing,
  type DevtuneTarget,
} from './devtune-login';
import { chooseAgent } from './discover';
import {
  BundleError,
  NotLoggedInError,
  RepositoryRemoteError,
  UploadError,
  UsageError,
} from './errors';
import { hostIo, type HostIo } from './host';
import {
  cleanupDocker,
  ensureSandboxImage,
  removeSessionContainers,
  runRequirements,
  SESSION_LABEL,
  type DockerBuild,
  type DockerRun,
} from './image';
import { initCommand } from './init';
import { listCommand } from './list-command';
import { assertSignedIn, loginCommand } from './login-command';
import { logoPlayer } from './logo';
import { pullCommand } from './pull-command';
import { pushCommand } from './push-command';
import { describeRepository, readRepository } from './repository';
import { resultsCommand } from './results';
import { selfRun } from './self-run';
import {
  devtuneRunSetup,
  heldTools,
  linkedBundle,
  linkUploads,
  readSetups,
} from './setup-links';
import { isFormatControl } from './terminal-text';
import {
  findBundles,
  readBundle,
  uploadBundle,
  type BundleOnDisk,
} from './upload';

export const RUNNER = {
  name: '@devtune/agentpicks',
  version: packageJson.version,
} as const;

export const USAGE = `Usage:
  agentpicks init [--yes] [--force]
  agentpicks run [<setup>] [--stack <stack> | --repo <path> [--ref <commit>]]
                 [--runs <n>] [--agent claude-code|codex|opencode|pi] [--model <model>]
                 [--out <dir>] [--no-upload]
  agentpicks run --category <category> (--stack <stack> | --repo <path> [--ref <commit>])
                 [--runs <n>] [--agent claude-code|codex|opencode|pi] [--model <model>]
                 [--out <dir>] [--no-upload]
  agentpicks list
  agentpicks pull [<setup>] [--force]
  agentpicks push [<setup>]
  agentpicks validate [<setup>...]
  agentpicks upload <dir>
  agentpicks results [<dir>...] [--json]
  agentpicks login [--no-browser]
  agentpicks login --api-key [--project <project id>]
  agentpicks cleanup
  agentpicks --version

init      Writes a setup file, agentpicks/<name>.yaml, from questions whose defaults come from
          this repository. --yes takes every default without asking. --force replaces a setup
          of the same name. Signed in, DevTune drafts the requests and tools of your own job.
run       Tests the coding agent installed here in a fresh Docker container per run, writes
          one bundle per completed run to --out (default ./agentpicks-runs), and uploads it to
          your DevTune project. --no-upload keeps bundles on this machine only. --repo tests
          your repository's committed files at HEAD, or at --ref; uncommitted changes aren't
          included. Uploading a --repo run needs the repository to have a remote.
          <setup> is a setup file's name in the repository's agentpicks folder, or its path,
          or signed in, the name of a DevTune setup with no file that asks its category's
          add request as published (pull a job or an edited copy and run the file). The setup says what to
          test; flags override it. On a terminal, run with no setup and no --category
          offers the setups to choose from. A setup linked to DevTune (it has an id)
          uploads under its DevTune setup. An unlinked setup from: a category, with no
          requests or tool signals of its own, uploads as that category; any other is
          custom and uploads once agentpicks push links it. Uploading, --category runs
          the project's copy of the category as run <copy> would, creating the copy
          first when the project has none; with --no-upload it runs the category itself.
list      Lists the setup files in agentpicks/*.yaml at the repository root, flagging any
          that fails its checks. Signed in, it lists the project's DevTune setups too:
          where each lives (local, DevTune or both) and whether a linked pair is in sync.
pull      Writes a DevTune setup into its linked file, or agentpicks/<name>.yaml, or every
          DevTune setup when none is named. A file with changes not pushed is replaced
          only with --force.
push      Saves a setup file, or every one, to DevTune and links it. A setup changed in
          DevTune since the file last saw it is refused as setup_changed: pull first.
validate  Checks every setup file, or the ones named, against the setup schema and the
          catalogue. Exits non-zero if any fails, naming the file and field.
upload    Uploads a bundle directory, or every bundle in an --out directory. Uploading again
          sends only what isn't stored yet. A custom setup's bundle, or one of changes not
          pushed, uploads once agentpicks push has saved the add request and tools it tested.
results   Shows which tool each run in ./agentpicks-runs, or the directories named, picked: the
          packages it added, or the code or config file that shows the pick, read from its
          bundle as the run's early stop reads it. A run with no pick shows none, and one whose
          bundle can't settle its pick shows Unmeasured, with why. --json prints the rows as JSON.
login     Signs in to DevTune in your browser, where you choose the project run and upload
          send bundles to. --no-browser prints the sign-in address without opening it.
          --api-key saves a project API key with the Agent Picks Run scope instead, read from
          standard input. DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID override the login, and
          DEVTUNE_API_BASE_URL sets the API address.
cleanup   Removes every container and image agentpicks made.

A setup file, agentpicks/error-tracking.yaml:

  job: Add error tracking
  from: error-tracking
  stacks: [nextjs]

Its schema is schema/setup.v1.json in this package; the README describes every field.
`;

/** What `agentpicks` on its own prints: the commands to start with, then where the rest are. */
export const INTRO = `Test which tools coding agents pick when they build your kind of app.

  agentpicks login     Sign in to your DevTune project
  agentpicks init      Write a setup file for this repository
  agentpicks run       Run a setup with the coding agent installed here
  agentpicks results   Show which tool each run picked
  agentpicks list      List this repository's setups and your project's

agentpicks --help lists every command and flag.`;

export interface CliContext {
  io: HostIo;
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
  /** The directory holding the sandbox Dockerfile shipped with the package. */
  dockerfileDir: string;
  /** Whether stdin and stdout are a terminal, so `run` with nothing named offers the setups and `init` asks. */
  interactive?: boolean;
  /** Reads one answer from the terminal; tests replace it. */
  ask?: (question: string) => Promise<string>;
  /** Reads the API key `login --api-key` saves; tests replace it. */
  readSecret?: (prompt: string) => Promise<string>;
  /** Opens the browser sign-in address; tests replace it. */
  openBrowser?: (url: string) => Promise<void>;
  /** Whether standard input is a terminal; a key piped to `login` needs --api-key. */
  stdinIsTerminal: boolean;
  /** The terminal's width when standard output is one, so `list` fits it; unset when output is piped. */
  columns?: number;
  /** Plays the DevTune mark once, for help and a login; unset where it shouldn't play (logo.ts says where). */
  logo?: () => Promise<void>;
  /** Docker access; tests replace it. */
  docker?: {
    version(): Promise<string>;
    platform(): Promise<SandboxPlatform>;
    run?: DockerRun;
    build?: DockerBuild;
    provider(image: string, labels: Record<string, string>): SandboxProvider;
  };
}

export function defaultContext(dockerfileDir: string): CliContext {
  return {
    io: hostIo(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    cwd: process.cwd(),
    dockerfileDir,
    stdinIsTerminal: Boolean(process.stdin.isTTY),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    columns: process.stdout.isTTY ? process.stdout.columns : undefined,
    logo: logoPlayer(process.env, process.stdout),
  };
}

/**
 * The line without terminal controls (escape sequences, carriage returns, C1 codes), keeping tabs
 * and newlines. Container output reaches the CLI's lines, so nothing it prints may drive the
 * host's terminal or clipboard.
 */
export function printable(line: string): string {
  return Array.from(line)
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return (
        code === 9 ||
        code === 10 ||
        (code >= 0x20 && code < 0x7f) ||
        (code > 0x9f && !isFormatControl(code))
      );
    })
    .join('');
}

/** Runs one command and resolves to the process's exit code; refusals print their message alone. */
export async function main(argv: string[], given: CliContext): Promise<number> {
  // Questions carry repository and DevTune text (a package name, a drafted request), so they are
  // made printable like every other line before they reach the terminal.
  const ctx: CliContext = {
    ...given,
    out: (line) => given.out(printable(line)),
    err: (line) => given.err(printable(line)),
    ask: (question) => (given.ask ?? askLine)(printable(question)),
  };
  const [command, ...rest] = argv;
  try {
    if (command === '--version' || command === '-v') {
      ctx.out(RUNNER.version);
      return 0;
    }
    if (!command) {
      await ctx.logo?.();
      ctx.out(INTRO);
      return 0;
    }
    if (
      command === 'help' ||
      command === '--help' ||
      command === '-h' ||
      rest.includes('--help')
    ) {
      await ctx.logo?.();
      ctx.out(USAGE);
      return 0;
    }
    if (command === 'init')
      return await initCommand(rest, { ...ctx, ask: ctx.ask ?? askLine });
    if (command === 'run') return await runCommand(rest, ctx);
    if (command === 'upload') return await uploadCommand(rest, ctx);
    if (command === 'login') return await loginCommand(rest, ctx);
    if (command === 'cleanup') return await cleanupCommand(ctx);
    if (command === 'list') return await listCommand(rest, ctx);
    if (command === 'pull') return await pullCommand(rest, ctx);
    if (command === 'push') return await pushCommand(rest, ctx);
    if (command === 'validate') return validateCommand(rest, ctx);
    if (command === 'results') return resultsCommand(rest, ctx);
    ctx.err(`agentpicks has no ${command} command.\n\n${USAGE}`);
    return 1;
  } catch (error) {
    ctx.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function docker(ctx: CliContext) {
  const real = new DockerSandboxProvider();
  return (
    ctx.docker ?? {
      version: () => real.dockerVersion(),
      platform: () => real.platform(),
      provider: (image: string, labels: Record<string, string>) =>
        new DockerSandboxProvider({ image, labels }),
    }
  );
}

async function runCommand(argv: string[], ctx: CliContext): Promise<number> {
  const command = parseRunCommand(argv, { picker: Boolean(ctx.interactive) });
  // Uploading, a category runs as the project's copy of it, linked once the sign-in is checked.
  if (command.kind === 'category')
    return runPlan(categoryPlan(command.args, ctx.cwd), ctx, () =>
      categoryCopyPlan(command.args, ctx),
    );
  const file = await runnableSetup(command.setup, ctx);
  if (file === null) return 1;
  const shown = relative(ctx.cwd, file.path) || file.path;
  const plan = setupPlan(file, command.flags, ctx.cwd);
  return runPlan(
    await linkUploads(plan, file.setup, file.content, shown, ctx),
    ctx,
  );
}

/**
 * The setup `run` names: a setup file, else a DevTune setup with that name when signed in, or the
 * one chosen from the picker; null after printing why when there is none to run.
 */
async function runnableSetup(
  name: string | null,
  ctx: CliContext,
): Promise<{
  path: string;
  name: string;
  root: string;
  setup: ResolvedSetup;
  content?: SetupFile;
} | null> {
  let path: string | null;
  try {
    path = name === null ? await pickSetup(ctx) : findSetup(name, ctx.cwd);
  } catch (error) {
    const bare = name !== null && !/[/\\]|\.ya?ml$/.test(name);
    const devtune =
      bare && error instanceof UsageError
        ? await devtuneRunSetup(name, setupsRoot(ctx.cwd), ctx)
        : null;
    if (devtune) return devtune;
    throw error;
  }
  if (path === null) return null;
  let file = readSetupFile(path);
  // A linked file may name a catalogue tool this version doesn't know, which its DevTune setup holds.
  if (!file.setup && file.content?.id) {
    const devtune = await readSetups(ctx).catch((error: unknown) => {
      if (error instanceof NotLoggedInError || error instanceof UploadError)
        return null;
      throw error;
    });
    if (devtune) file = readSetupFile(path, heldTools(devtune));
  }
  if (!file.setup) {
    for (const problem of file.problems)
      ctx.err(formatProblem(path, problem, ctx.cwd));
    ctx.err('Fix the setup file, then run it again.');
    return null;
  }
  return { ...file, setup: file.setup };
}

/**
 * Offers the repository's setups on a terminal and resolves to the chosen file, or null (after
 * saying how to write one) when there are none.
 */
async function pickSetup(ctx: CliContext): Promise<string | null> {
  const root = setupsRoot(ctx.cwd);
  const files = readSetupFiles(root);
  if (files.length === 0) {
    ctx.err(
      `${join(root, SETUPS_DIR)} holds no setup files. Write one with: agentpicks init\n\nOr run a built-in category: agentpicks run --category <category> --stack <stack>.`,
    );
    return null;
  }
  ctx.out('Setups:');
  files.forEach((file, i) =>
    ctx.out(
      `  ${String(i + 1).padStart(2)}  ${file.name}  ${file.setup ? file.setup.job : 'invalid; agentpicks validate says why'}`,
    ),
  );
  const answer = (
    await (ctx.ask ?? askLine)(`Run which setup? (1-${files.length}) `)
  ).trim();
  const chosen = /^\d+$/.test(answer) ? files[Number(answer) - 1] : undefined;
  if (!chosen)
    throw new UsageError(
      `Choose a setup by its number, 1 to ${files.length}, or name it: agentpicks run <setup>.`,
    );
  return chosen.path;
}

/** One line read from the terminal after `question`. */
async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Runs each test with each agent, `runs` times, uploading each bundle unless the plan says not to.
 * `link`, given, replaces an uploading plan once the sign-in is checked, before anything starts;
 * it keeps the plan's repository and ref.
 */
async function runPlan(
  given: RunPlan,
  ctx: CliContext,
  link?: (plan: RunPlan) => Promise<RunPlan>,
): Promise<number> {
  // Read once, so every run tests the same commit whatever happens to the checkout meanwhile.
  const repository =
    given.repo === undefined
      ? undefined
      : readRepository(given.repo, given.ref);
  const target = given.upload ? devtuneTarget(ctx.io) : null;
  // DevTune keys a repository's series by its remote, and refuses an upload without one.
  if (target && repository && repository.remoteUrl === null)
    throw new RepositoryRemoteError(
      `DevTune groups a repository's runs by its remote, and ${repository.root} has none agentpicks can record. Add an origin remote with a network address, or pass --no-upload to keep the bundles on this machine only.`,
    );
  // A link reads DevTune next, which refuses a sign-in no longer valid before anything starts; agent_picks.run is checked at upload.
  if (target) await assertSignedIn(target, ctx, { quiet: link !== undefined });
  const plan = target && link ? await link(given) : given;
  const agentPlans = plan.agents.map((choice) =>
    planAgent(chooseAgent(ctx.io, choice)),
  );
  const credentials = agentPlans.map((agentPlan) =>
    resolveCredentials(agentPlan, ctx.io),
  );
  const dockerAccess = docker(ctx);
  const dockerVersion = await dockerAccess.version();
  const platform = await dockerAccess.platform();
  for (const test of plan.tests) assertStackRuns(test.environment, platform);
  if (repository) assertRepositoryRuns(repository.install, platform);
  const outDir = resolve(ctx.cwd, plan.out);
  const { runs } = plan;
  const cells = agentPlans.flatMap((agentPlan, a) =>
    plan.tests.map((test) => ({ agentPlan, a, test })),
  );
  const total = cells.length * runs;

  ctx.out(`agentpicks ${RUNNER.version}, Docker ${dockerVersion}`);
  for (const { agent } of agentPlans)
    ctx.out(
      `Agent: ${agent.name} ${agent.version} at ${agent.path}, model ${agent.model} (from ${agent.modelSource})`,
    );
  if (repository)
    for (const line of describeRepository(repository)) ctx.out(line);
  for (const test of plan.tests)
    ctx.out(
      `Test: the ${plan.setup ? `${plan.setup.record.name} setup's` : test.category.slug} ${test.intent} request on ${repository ? 'your repository' : test.environment.slug}, ${runs} run${runs === 1 ? '' : 's'}${agentPlans.length > 1 ? ' with each agent' : ''}, one after another`,
    );
  for (const each of credentials)
    for (const line of each.summary) ctx.out(line);
  if (target)
    ctx.out(
      `Uploads each bundle to DevTune project ${target.projectId} once it is written.`,
    );
  ctx.out(runRequirements());

  const image = await ensureSandboxImage({
    version: RUNNER.version,
    platform,
    dockerfileDir: ctx.dockerfileDir,
    run: dockerAccess.run,
    build: dockerAccess.build,
  });
  if (image.built) ctx.out(`Built the sandbox image ${image.tag}.`);
  if (image.removed.length > 0)
    ctx.out(`Removed older sandbox images: ${image.removed.join(', ')}.`);

  // Every container this invocation makes carries its session, so an interrupt can find one
  // whose `docker run` it cut off before the container's id came back.
  const session = randomUUID();
  const tracked = trackSandboxes(
    dockerAccess.provider(image.tag, { [SESSION_LABEL]: session }),
  );
  const interrupt = () => {
    ctx.err(
      'Stopping: removing the run’s container. No bundle is written for it.',
    );
    // An upload still going could start renewing the sign-in, and exiting mid-renewal would lose
    // the rotated refresh token: none starts from here, and one already started is saved first.
    stopRenewing();
    void cancelSandboxes(tracked, session, dockerAccess.run).finally(
      async () => {
        await loginSaved();
        process.exit(130);
      },
    );
  };
  process.once('SIGINT', interrupt);
  let started = 0;
  let written = 0;
  let uploaded = 0;
  try {
    runs: for (const { agentPlan, a, test } of cells)
      for (let i = 1; i <= runs; i++) {
        started++;
        ctx.out('');
        ctx.out(`Run ${started} of ${total}`);
        if (cells.length > 1)
          ctx.out(
            `  ${agentPlan.agent.name} on ${repository ? 'your repository' : test.environment.slug}`,
          );
        // Only the first run uses the credentials checked before Docker; a sign-in can lapse by any later run,
        // another agent's first included.
        const runCredentials =
          started === 1
            ? credentials[a]!
            : resolveCredentials(agentPlan, ctx.io);
        const outcome = await selfRun({
          test,
          setup: plan.setup?.record,
          plan: agentPlan,
          credentials: runCredentials,
          repository,
          provider: tracked.provider,
          outDir,
          runner: RUNNER,
          host: { os: ctx.io.platform, arch: ctx.io.arch },
          platform,
          log: ctx.out,
        });
        for (const line of describeOutcome(outcome)) ctx.out(line);
        if (!outcome.bundle) continue;
        written++;
        if (!target) continue;
        // A refusal would refuse every later run's bundle too, so no further runs start.
        if (!(await uploadPrinted(outcome.bundle.dir, target, ctx))) break runs;
        uploaded++;
      }
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
  ctx.out('');
  ctx.out(
    `${written} of ${total} run${total === 1 ? '' : 's'} written to ${outDir}`,
  );
  if (target) ctx.out(`${uploaded} uploaded to DevTune.`);
  return written === total && (!target || uploaded === written) ? 0 : 1;
}

/**
 * Uploads one bundle and prints where it went; on a refusal, prints DevTune's message and how to
 * send the bundle later. Resolves whether it uploaded.
 */
async function uploadPrinted(
  dir: string,
  target: DevtuneTarget,
  ctx: CliContext,
  bundle?: BundleOnDisk,
): Promise<boolean> {
  try {
    const sent = await uploadBundle(bundle ?? readBundle(dir), target);
    ctx.out(
      `  Uploaded run ${sent.runId} to DevTune${sent.analysis ? `; analysis ${sent.analysis}` : ''}.`,
    );
    ctx.out(`  Upload status: ${sent.statusUrl}`);
    return true;
  } catch (error) {
    // A bundle that fails its own checks fails the same way on every retry, so it gets no retry hint.
    if (error instanceof BundleError) {
      ctx.err(error.message);
      return false;
    }
    if (!(error instanceof UploadError)) throw error;
    ctx.err(error.message);
    ctx.err(
      `The bundle stays in ${dir}. Send it with: agentpicks upload ${dir}`,
    );
    return false;
  }
}

async function uploadCommand(argv: string[], ctx: CliContext): Promise<number> {
  const dirs = findBundles(resolve(ctx.cwd, parseUploadArgs(argv).dir));
  // Read at the first bundle that can upload, so a custom setup's bundle is refused without a login.
  let target: DevtuneTarget | undefined;
  let uploaded = 0;
  for (const dir of dirs) {
    // One bundle that fails its checks is reported and skipped, so the rest of an --out directory still uploads.
    let bundle: BundleOnDisk;
    try {
      bundle = readBundle(dir);
    } catch (error) {
      if (!(error instanceof BundleError)) throw error;
      ctx.err(error.message);
      continue;
    }
    // A linked setup's bundle uploads under its DevTune setup; a custom setup's from before bundles recorded
    // what their file said names no DevTune category, so it can't upload.
    const { category } = bundle.manifest.request;
    let linked: BundleOnDisk | null;
    try {
      linked = await linkedBundle(bundle, ctx);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      ctx.err(error.message);
      continue;
    }
    if (linked) bundle = linked;
    else if (category.startsWith(CUSTOM_SETUP_CATEGORY_PREFIX)) {
      ctx.err(
        `${dir} is a run of the custom setup ${bundle.setup?.name ?? category.slice(CUSTOM_SETUP_CATEGORY_PREFIX.length)}, which isn't linked to a DevTune setup, so it can't upload. Run agentpicks push to save the setup to DevTune, then run it again.`,
      );
      continue;
    }
    if (!target) {
      target = devtuneTarget(ctx.io);
      await assertSignedIn(target, ctx);
    }
    for (const line of describeBundle(bundle)) ctx.out(line);
    if (await uploadPrinted(dir, target, ctx, bundle)) uploaded++;
  }
  if (dirs.length > 1)
    ctx.out(`${uploaded} of ${dirs.length} bundles uploaded to DevTune.`);
  return uploaded === dirs.length ? 0 : 1;
}

/**
 * `agentpicks validate [setup…]`: checks every setup file in the repository, or the ones named, against
 * the schema and the catalogue. Exits non-zero when any fails, naming its file and field.
 */
function validateCommand(argv: string[], ctx: CliContext): number {
  const flag = argv.find((arg) => arg.startsWith('-'));
  if (flag)
    throw new UsageError(`agentpicks validate takes no flags, not ${flag}.`);
  const root = setupsRoot(ctx.cwd);
  // A file named by path is read alone, as `run <path>` reads it, so a twin name doesn't fail it.
  const files: (SetupOnDisk | { path: string; error: string })[] =
    argv.length > 0
      ? argv.map((arg) => {
          try {
            return readSetupFile(findSetup(arg, ctx.cwd));
          } catch (error) {
            if (!(error instanceof UsageError)) throw error;
            return { path: arg, error: error.message };
          }
        })
      : readSetupFiles(root);
  if (files.length === 0) {
    ctx.out(`${join(root, SETUPS_DIR)} holds no setup files. ${WRITE_ONE}`);
    return 0;
  }
  let failed = 0;
  for (const file of files) {
    if ('error' in file) {
      failed++;
      ctx.err(file.error);
      continue;
    }
    if (file.problems.length === 0) {
      ctx.out(`${relative(ctx.cwd, file.path) || file.path}: valid`);
      continue;
    }
    failed++;
    for (const problem of file.problems)
      ctx.err(formatProblem(file.path, problem, ctx.cwd));
  }
  const count = files.length;
  ctx.out(
    `${count - failed} of ${count} setup file${count === 1 ? '' : 's'} valid.`,
  );
  return failed === 0 ? 0 : 1;
}

async function cleanupCommand(ctx: CliContext): Promise<number> {
  const dockerAccess = docker(ctx);
  await dockerAccess.version();
  const removed = await cleanupDocker(dockerAccess.run);
  ctx.out(
    `Removed ${removed.containers.length} container${removed.containers.length === 1 ? '' : 's'} and ${removed.images.length} image${removed.images.length === 1 ? '' : 's'}${removed.images.length ? `: ${removed.images.join(', ')}` : ''}.`,
  );
  return 0;
}

/** The lines printed for one run: how it ended, and for a written bundle its files, sizes and redactions. */
export function describeOutcome(
  outcome: Awaited<ReturnType<typeof selfRun>>,
): string[] {
  const { run, bundle } = outcome;
  const seconds = Math.round(run.timing.totalMs / 1000);
  if (!bundle)
    return [
      `  Failed at ${run.failedStage ?? 'an unknown stage'} after ${seconds} s: ${run.error ?? 'no error recorded'}`,
      '  No bundle was written for this run.',
    ];
  const meta = parseJsonObject(run.artifacts['meta.json']);
  const early = parseJsonObject(run.artifacts['earlystop.json']);
  return [
    `  Finished in ${seconds} s. The agent exited ${String(meta?.exitCode ?? 'unknown')}${early?.killed === true ? `; it was stopped ${String(early.graceSec)} s after a pick landed` : ''}.`,
    ...describeBundle(bundle),
  ];
}

/** A bundle's directory, each file with its size, and the redactions it holds. */
export function describeBundle(
  bundle: Pick<BundleOnDisk, 'dir' | 'files' | 'redactions'>,
): string[] {
  const width = Math.max(...bundle.files.map((f) => f.path.length));
  const { redactions } = bundle;
  return [
    `  Bundle: ${bundle.dir}`,
    ...bundle.files.map(
      (f) => `    ${f.path.padEnd(width)}  ${formatBytes(f.bytes)}`,
    ),
    `  Redactions: ${redactions.total}${
      redactions.total
        ? ` (${Object.entries(redactions.byArtifact)
            .map(([name, n]) => `${name} ${n}`)
            .join(', ')})`
        : ''
    }`,
  ];
}

function parseJsonObject(
  text: string | undefined,
): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text ?? '');
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * Removes every sandbox an interrupted invocation made: the ones it tracked (waiting for any
 * still being created), then any other container carrying its session label.
 */
export async function cancelSandboxes(
  tracked: ReturnType<typeof trackSandboxes>,
  session: string,
  run?: DockerRun,
): Promise<void> {
  await tracked.destroyAll();
  await removeSessionContainers(session, run);
}

/**
 * The provider, recording every sandbox from the moment its creation starts until its destroy
 * succeeds, so an interrupt can remove it: `destroyAll` waits for creations in flight, then
 * destroys every sandbox still recorded, including one whose own destroy failed or is running.
 */
export function trackSandboxes(inner: SandboxProvider) {
  const creating = new Set<Promise<Sandbox>>();
  const live = new Set<Sandbox>();
  const provider: SandboxProvider = {
    name: inner.name,
    create(options) {
      const created = inner.create(options).then((box) => {
        const tracked: Sandbox = {
          ...box,
          async destroy() {
            await box.destroy();
            live.delete(tracked);
          },
        };
        live.add(tracked);
        return tracked;
      });
      creating.add(created);
      void Promise.allSettled([created]).then(() => creating.delete(created));
      return created;
    },
    get: (id) => inner.get(id),
  };
  return {
    provider,
    async destroyAll() {
      await Promise.allSettled([...creating]);
      return Promise.allSettled([...live].map((box) => box.destroy()));
    },
  };
}
