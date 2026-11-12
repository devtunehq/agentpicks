/**
 * ABOUTME: Runs one Agent Picks run in a fresh sandbox and returns what it left: upload the assets
 * and prompt, set up the environment, run the agent (with optional early stop), collect the
 * artifacts and destroy the sandbox in `finally`. Managed runs and self-runs share it; each caller
 * supplies the agent's environment, the redaction and any judging of the artifacts.
 */
import type { SandboxArchitecture } from '../assets/architecture';
import type { SandboxRepository } from '../assets/repository-scripts';
import { buildSandboxAssets } from '../assets/sandbox-assets';
import { SANDBOX_ROOT, shellQuote } from '../assets/script';
import type { EarlyStopPatterns } from '../catalogue/early-stop';
import type { EnvironmentDefinition } from '../catalogue/environments';
import type {
  Sandbox,
  SandboxExecResult,
  SandboxProvider,
} from '../sandbox/provider';
import type { AgentKind } from './agent-kind';
import {
  AGENT_TIMEOUT_SEC,
  SANDBOX_LIFETIME_MIN,
  SETUP_TIMEOUT_SEC,
  describeLimitStop,
  turnLimit,
  type LimitStop,
} from './limits';
import { piTranscriptError } from './pi';

/** One run's inputs: the project it starts from, the request, the agent and its limits. */
export interface SandboxRunJob {
  id: string;
  environment: EnvironmentDefinition;
  /** The category or job being measured; supplies the early-stop watcher's patterns. */
  signals: { earlyStop: EarlyStopPatterns };
  agent: AgentKind;
  /** Model id, or `default` for the agent's own default. */
  model: string;
  /** The request text, before the environment prefix and the request ending. */
  prompt: string;
  /** Leave off the request ending. */
  noSuffix?: boolean;
  /** The setup's request ending, as its test recorded it; absent is `REQUEST_ENDING`. Empty sends the request as written. */
  requestEnding?: string;
  /** Stop the agent this many seconds after a pick lands (Claude Code only). Omit for a full run. */
  earlyStopGraceSec?: number;
  /** Agent wall-clock limit; defaults to AGENT_TIMEOUT_SEC. */
  agentTimeoutSec?: number;
  /**
   * The agent CLI's turn cap (Claude Code `--max-turns`); defaults to its AGENT_RUN_LIMITS
   * value. Ignored for an agent whose CLI has none.
   */
  maxTurns?: number;
  /** Sandbox lifetime cap; defaults to SANDBOX_LIFETIME_MIN. */
  sandboxTimeoutMin?: number;
  /** Install this version of the agent CLI over the pinned one; a self-run sets the customer's. */
  agentVersion?: string;
  /** Lay down the customer's repository instead of the environment's starter (a self-run's `--repo`). */
  repository?: SandboxRepository;
  /** The sandbox's CPU; x86_64 when absent. A self-run on an arm64 host sets aarch64. */
  architecture?: SandboxArchitecture;
}

export type RunStage =
  | 'config'
  | 'create'
  | 'upload'
  | 'setup'
  | 'agent'
  | 'collect';

/** Files collected from the sandbox's out directory, when present. */
export const RUN_ARTIFACTS = [
  'setup.json',
  'meta.json',
  'transcript.jsonl',
  'agent.err',
  'requests.jsonl',
  'requests-started.jsonl',
  'mitm.log',
  'diffstat.txt',
  'diff.patch',
  'source-files.json',
  'diff-truncated.txt',
  'ignored-env.txt',
  'package-json.txt',
  'baseline-manifests.txt',
  'lockfiles.txt',
  'manifests.txt',
  'env.json',
  'deps.txt',
  'starter-extra.txt',
  'llm-usage.jsonl',
  'earlystop.json',
] as const;

export type RunArtifactName = (typeof RUN_ARTIFACTS)[number];

export type RunArtifacts = Partial<Record<RunArtifactName, string>>;

export interface EarlyStopRecord {
  reason: string;
  triggerSec: number;
  graceSec: number;
  /**
   * True only when the watcher found the agent's session and it was gone afterwards; false
   * when the agent finished inside the grace period or the stop found nothing to stop.
   */
  killed: boolean;
  /** Whether the stop found a live agent session; null in records written before it was reported. */
  agentFound: boolean | null;
}

export interface RunOneLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Redacts a text read from the sandbox; `name` is the artifact it came from, when it is one. */
export type RunRedactor = (text: string, name?: RunArtifactName) => string;

/** What a caller adds to the shared run. */
export interface SandboxRunHooks {
  /**
   * The agent's credential environment, read at the `config` stage: throwing refuses the run
   * before a sandbox exists.
   */
  configure: () => Record<string, string>;
  /** Applied to every artifact, the agent's output and every error before they are returned. */
  redact: RunRedactor;
  logger?: RunOneLogger;
  /** Runs at the `upload` stage, after the assets and prompt are written: a self-run's sign-in files. */
  afterUpload?: (box: Sandbox) => Promise<void>;
  /** Runs at the `agent` stage, before the agent's command is built: Pi's model config. */
  beforeAgent?: (box: Sandbox) => Promise<void>;
  /** The agent's command; defaults to `agentInvocation` with the job's own model. */
  invocation?: (keyEnv: Record<string, string>) => AgentInvocation;
  /** Why the collected artifacts show the agent did not finish, or null when it did. */
  judge?: (artifacts: RunArtifacts) => string | null;
}

export interface SandboxRunResult {
  status: 'ok' | 'failed';
  failedStage: RunStage | null;
  error: string | null;
  sandboxId: string | null;
  promptText: string;
  startedAt: string;
  finishedAt: string;
  timing: {
    createMs?: number;
    setupMs?: number;
    agentMs?: number;
    destroyMs?: number;
    totalMs: number;
  };
  /** Last 300 characters of the agent command's output. */
  agentTail: string | null;
  artifacts: RunArtifacts;
  /** The provider's deadline on run-agent.sh, when it ended the command. */
  providerDeadlineStop: LimitStop | null;
  destroyError: string | null;
}

export interface AgentInvocation {
  command: string;
  env: Record<string, string>;
  agentTimeoutSec: number;
}

const CLI_NAME: Record<AgentKind, string> = {
  claude_code: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  muse_code: 'muse',
};
/**
 * How long the provider waits on run-agent.sh past the agent's own limit: room for its
 * artifact work after `timeout` stops the agent.
 */
const AGENT_EXEC_MARGIN_SEC = 100;
/**
 * Appended to every request of a public category, and of a test recorded before tests recorded their ending: the
 * agent decides alone, working for a team that will create any accounts and keys a service needs. Part of every
 * project's fingerprint.
 */
export const REQUEST_ENDING =
  " Make any decisions yourself. If a service needs an account or keys, assume I'll create them and leave placeholders.";

/** The exact prompt the agent receives. */
export function composePrompt(
  job: Pick<
    SandboxRunJob,
    'environment' | 'prompt' | 'noSuffix' | 'requestEnding'
  >,
): string {
  return (
    (job.environment.promptPrefix ?? '') +
    job.prompt +
    (job.noSuffix ? '' : (job.requestEnding ?? REQUEST_ENDING))
  );
}

/**
 * Creates a sandbox, sets it up and runs the agent in it, then collects the artifacts and
 * destroys it whatever happened. A failed stage is recorded, never thrown; the artifacts an
 * agent left behind are kept when the agent stage fails.
 */
export async function runInSandbox(
  job: SandboxRunJob,
  provider: SandboxProvider,
  hooks: SandboxRunHooks,
): Promise<SandboxRunResult> {
  const { redact, logger } = hooks;
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const promptText = composePrompt(job);
  const timing: SandboxRunResult['timing'] = { totalMs: 0 };
  const artifacts: RunArtifacts = {};
  let status: SandboxRunResult['status'] = 'failed';
  let failedStage: RunStage | null = null;
  let error: string | null = null;
  let agentTail: string | null = null;
  let destroyError: string | null = null;
  let stage: RunStage = 'config';
  let box: Sandbox | undefined;
  // The provider's deadline on run-agent.sh, when it ended the command; meta.json may never
  // have been written then, so the artifacts cannot show it.
  let providerDeadlineStop: LimitStop | null = null;

  try {
    const keyEnv = hooks.configure();

    stage = 'create';
    let t = Date.now();
    box = await provider.create({
      timeoutMin: job.sandboxTimeoutMin ?? SANDBOX_LIFETIME_MIN,
    });
    timing.createMs = Date.now() - t;
    logger?.info(
      { jobId: job.id, sandboxId: box.id, provider: provider.name },
      'agent picks sandbox created',
    );

    stage = 'upload';
    await uploadRunInputs(box, job, promptText);
    await hooks.afterUpload?.(box);

    stage = 'setup';
    t = Date.now();
    const setup = await box.exec(setupCommand(job), {
      timeoutSec: SETUP_TIMEOUT_SEC,
    });
    timing.setupMs = Date.now() - t;
    if (setup.exitCode !== 0) {
      throw new Error(
        `setup exit ${setup.exitCode}: ${(setup.stdout + setup.stderr).slice(-800)}`,
      );
    }

    stage = 'agent';
    t = Date.now();
    await hooks.beforeAgent?.(box);
    const agentRun = hooks.invocation
      ? hooks.invocation(keyEnv)
      : agentInvocation(job, keyEnv);
    const agentDeadlineSec = agentRun.agentTimeoutSec + AGENT_EXEC_MARGIN_SEC;
    const agentStart = t;
    // Read from the elapsed time, since each provider reports its own timeout differently
    // (a thrown error, or an exit code of its choosing).
    const pastDeadline = (): LimitStop | null =>
      Date.now() - agentStart >= agentDeadlineSec * 1000
        ? { limit: 'deadline', value: agentDeadlineSec }
        : null;
    const withLimit = (message: string) =>
      providerDeadlineStop
        ? `${message} (${describeLimitStop(providerDeadlineStop)})`
        : message;
    let agent: SandboxExecResult;
    try {
      agent = await box.exec(agentRun.command, {
        env: agentRun.env,
        timeoutSec: agentDeadlineSec,
      });
    } catch (e) {
      providerDeadlineStop = pastDeadline();
      throw new Error(withLimit(e instanceof Error ? e.message : String(e)));
    }
    timing.agentMs = Date.now() - t;
    agentTail = redact((agent.stdout + agent.stderr).slice(-300));
    if (agent.exitCode !== 0) {
      providerDeadlineStop = pastDeadline();
      throw new Error(withLimit(`run-agent exit ${agent.exitCode}`));
    }

    stage = 'collect';
    Object.assign(artifacts, await collectArtifacts(box, redact));
    const agentError = hooks.judge?.(artifacts) ?? null;
    if (agentError) {
      stage = 'agent';
      throw new Error(agentError);
    }
    status = 'ok';
  } catch (e) {
    failedStage = stage;
    error = redact(e instanceof Error ? e.message : String(e)).slice(0, 1500);
    logger?.warn(
      { jobId: job.id, stage, error: error.slice(0, 300) },
      'agent picks run failed',
    );
    // Keep whatever the agent left behind for diagnosis.
    if (box && stage === 'agent') {
      await collectArtifacts(box, redact)
        .then((collected) => Object.assign(artifacts, collected))
        .catch((e: unknown) =>
          logger?.warn(
            {
              jobId: job.id,
              error: redact(e instanceof Error ? e.message : String(e)).slice(
                0,
                300,
              ),
            },
            'agent picks artifacts after a failed agent could not be read',
          ),
        );
    }
  } finally {
    const td = Date.now();
    try {
      await box?.destroy();
    } catch (e) {
      destroyError = redact(e instanceof Error ? e.message : String(e)).slice(
        0,
        300,
      );
      logger?.warn(
        { jobId: job.id, destroyError },
        'agent picks sandbox destroy failed',
      );
    }
    if (box) timing.destroyMs = Date.now() - td;
  }

  timing.totalMs = Date.now() - t0;
  return {
    status,
    failedStage,
    error,
    sandboxId: box?.id ?? null,
    promptText,
    startedAt,
    finishedAt: new Date().toISOString(),
    timing,
    agentTail,
    artifacts,
    providerDeadlineStop,
    destroyError,
  };
}

/** Uploads the environment's assets and the composed prompt into a fresh sandbox. */
export async function uploadRunInputs(
  box: Sandbox,
  job: Pick<
    SandboxRunJob,
    | 'environment'
    | 'signals'
    | 'agent'
    | 'agentVersion'
    | 'repository'
    | 'architecture'
  >,
  promptText: string,
): Promise<void> {
  await box.exec(`mkdir -p ${SANDBOX_ROOT} ${SANDBOX_ROOT}/out`);
  for (const asset of buildSandboxAssets(
    job.environment,
    job.signals,
    job.agent,
    {
      agentVersion: job.agentVersion,
      repository: job.repository,
      architecture: job.architecture,
    },
  )) {
    await box.writeFile(asset.path, asset.content);
  }
  await box.writeFile(`${SANDBOX_ROOT}/prompt.txt`, promptText);
}

/** The command that installs the agent CLIs and the proxy and creates the project. */
export function setupCommand(
  job: Pick<SandboxRunJob, 'environment'> &
    Partial<Pick<SandboxRunJob, 'agent'>>,
): string {
  return `bash ${SANDBOX_ROOT}/setup.sh ${shellQuote(job.environment.slug)}${job.agent === 'opencode' ? ' opencode' : ''}`;
}

/**
 * The command and environment that run the agent once setup has finished. `modelArg` is the
 * model as the agent's CLI takes it, when that is not the job's model (OpenCode's
 * `<provider>/<model>`).
 */
export function agentInvocation(
  job: Pick<
    SandboxRunJob,
    'agent' | 'model' | 'agentTimeoutSec' | 'earlyStopGraceSec' | 'maxTurns'
  >,
  keyEnv: Record<string, string>,
  modelArg: string = job.model,
): AgentInvocation {
  const agentTimeoutSec = job.agentTimeoutSec ?? AGENT_TIMEOUT_SEC;
  const env: Record<string, string> = { ...keyEnv };
  if (job.earlyStopGraceSec !== undefined)
    env.EARLY_STOP_GRACE = String(job.earlyStopGraceSec);
  const maxTurns = turnLimit(job);
  if (maxTurns !== null) env.MAX_TURNS = String(maxTurns);
  return {
    command: `bash ${SANDBOX_ROOT}/run-agent.sh ${CLI_NAME[job.agent]} ${shellQuote(modelArg)} ${SANDBOX_ROOT}/prompt.txt ${agentTimeoutSec}`,
    env,
    agentTimeoutSec,
  };
}

/** Reads every artifact present in the sandbox's out directory, redacted. */
export async function collectArtifacts(
  box: Sandbox,
  redact: RunRedactor,
): Promise<RunArtifacts> {
  const artifacts: RunArtifacts = {};
  for (const name of RUN_ARTIFACTS) {
    const text = await box.readFile(`${SANDBOX_ROOT}/out/${name}`);
    if (text !== null) artifacts[name] = redact(text, name);
  }
  return artifacts;
}

/** The agent CLI's exit code and wall time, from meta.json; null when it is missing or unreadable. */
export function parseMeta(
  text: string | undefined,
): { exitCode: number; wallSec: number | null } | null {
  const j = parseObject(text);
  if (!j || typeof j.exitCode !== 'number') return null;
  return {
    exitCode: j.exitCode,
    wallSec: typeof j.wallSec === 'number' ? j.wallSec : null,
  };
}

export function parseEarlyStop(
  text: string | undefined,
): EarlyStopRecord | null {
  const j = parseObject(text);
  if (!j || typeof j.reason !== 'string') return null;
  return {
    reason: j.reason,
    triggerSec: typeof j.triggerSec === 'number' ? j.triggerSec : 0,
    graceSec: typeof j.graceSec === 'number' ? j.graceSec : 0,
    killed: j.killed === true,
    agentFound: typeof j.agentFound === 'boolean' ? j.agentFound : null,
  };
}

/**
 * Why the collected artifacts show the agent did not finish, or null when it did. run-agent.sh
 * exits zero so artifacts are always collected; the agent CLI's own exit is in meta.json, and a
 * missing or unreadable meta.json means nothing shows the agent finished. A nonzero exit (a
 * crash, or 124 when its time limit stopped it) fails the run unless the early-stop watcher
 * killed the agent. Pi, which can exit zero on a provider error, is judged by its transcript.
 */
export function judgeAgentExit(
  agent: AgentKind,
  artifacts: RunArtifacts,
): string | null {
  const agentExit = parseMeta(artifacts['meta.json']);
  if (!agentExit) return 'agent exit metadata missing';
  if (agent === 'pi' && agentExit.exitCode === 0)
    return piTranscriptError(artifacts['transcript.jsonl'] ?? '');
  if (
    agentExit.exitCode === 0 ||
    parseEarlyStop(artifacts['earlystop.json'])?.killed === true
  )
    return null;
  return `agent exit ${agentExit.exitCode}`;
}

function parseObject(text: string | undefined): Record<string, unknown> | null {
  if (!text?.trim()) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
