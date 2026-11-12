/**
 * ABOUTME: The files a run uploads into the sandbox before setup, built for one
 * environment, category and agent: the scripts, plus the committed starter and agent tools,
 * packed for `unpack`.
 */
import type { EarlyStopPatterns } from '../catalogue/early-stop';
import type { EnvironmentDefinition } from '../catalogue/environments';
import { packEntries } from '../locks/locked-files';
import type { AgentKind } from '../run/agent-kind';
import {
  agentVersionInstallScript,
  agentVersionSetupScript,
} from '../run/agent-version';
import {
  INSTALL_MUSE_CODE_SH,
  RUN_MUSE_SH,
  museCodeRunScript,
  museCodeSetupScript,
} from '../run/muse-code';
import {
  INSTALL_OPENCODE_SH,
  opencodeRunScript,
  opencodeSetupScript,
} from '../run/opencode';
import { OPENCODE_LOCK } from '../run/opencode-lock';
import { OPENCODE_MODELS_JSON } from '../run/opencode-models';
import { PI_RUN_SH, PI_SETUP_SH, piRunScript, piSetupScript } from '../run/pi';
import { forArchitecture, type SandboxArchitecture } from './architecture';
import { CAPTURE_SOURCES_PY } from './capture-sources';
import {
  buildMakeEnvScript,
  buildWatchPickScript,
} from './environment-scripts';
import { lockedStarter } from './locked-starter';
import {
  buildRepositoryMakeEnvScript,
  type SandboxRepository,
} from './repository-scripts';
import { SANDBOX_ROOT } from './script';
import {
  AGENT_SESSION_SH,
  LOGGER_PY,
  RUN_AGENT_SH,
  SETUP_SH,
  STOP_AGENT_SH,
} from './static-scripts';

export interface SandboxAsset {
  path: string;
  content: string;
}

export interface SandboxAssetOptions {
  /** Install this version of the agent CLI over the pinned one (a self-run tests the customer's). */
  agentVersion?: string;
  /** Lay down this repository instead of the environment's starter (`agentpicks run --repo`). */
  repository?: SandboxRepository;
  /** The sandbox's CPU; x86_64 when absent. A self-run on an arm64 host sets aarch64. */
  architecture?: SandboxArchitecture;
}

/**
 * `signals` is the category's (or job's); the sandbox reads only its early-stop patterns.
 * Without options, a run's assets are the managed pipeline's, byte for byte.
 */
export function buildSandboxAssets(
  environment: EnvironmentDefinition,
  signals: { earlyStop: EarlyStopPatterns },
  agent?: AgentKind,
  {
    agentVersion,
    repository,
    architecture = 'x86_64',
  }: SandboxAssetOptions = {},
): SandboxAsset[] {
  // The customer's own files are copied as committed, never rewritten for the architecture.
  return x86_64Assets(
    environment,
    signals,
    agent,
    agentVersion,
    repository,
  ).map((asset) =>
    asset.path === REPOSITORY_TSV
      ? asset
      : {
          path: asset.path,
          content: forArchitecture(asset.content, architecture),
        },
  );
}

const REPOSITORY_TSV = `${SANDBOX_ROOT}/repository.tsv`;

function x86_64Assets(
  environment: EnvironmentDefinition,
  signals: { earlyStop: EarlyStopPatterns },
  agent: AgentKind | undefined,
  agentVersion: string | undefined,
  repository: SandboxRepository | undefined,
): SandboxAsset[] {
  const setup =
    agent === 'opencode'
      ? opencodeSetupScript(SETUP_SH)
      : agent === 'pi'
        ? piSetupScript(SETUP_SH)
        : agent === 'muse_code'
          ? museCodeSetupScript(SETUP_SH)
          : SETUP_SH;
  return [
    ...(agent && agentVersion
      ? [
          {
            path: `${SANDBOX_ROOT}/install-agent-version.sh`,
            content: agentVersionInstallScript(agent, agentVersion),
          },
        ]
      : []),
    ...(agent === 'pi'
      ? [
          {
            path: `${SANDBOX_ROOT}/pi-tools.tsv`,
            content: packEntries(lockedStarter('pi-tools').files),
          },
          { path: `${SANDBOX_ROOT}/pi-setup.sh`, content: PI_SETUP_SH },
          { path: `${SANDBOX_ROOT}/run-pi.sh`, content: PI_RUN_SH },
        ]
      : []),
    ...(agent === 'muse_code'
      ? [
          {
            path: `${SANDBOX_ROOT}/install-muse-code.sh`,
            content: INSTALL_MUSE_CODE_SH,
          },
          { path: `${SANDBOX_ROOT}/run-muse.sh`, content: RUN_MUSE_SH },
        ]
      : []),
    ...(agent === 'opencode'
      ? [
          {
            path: `${SANDBOX_ROOT}/opencode-models.json`,
            content: OPENCODE_MODELS_JSON,
          },
          {
            path: `${SANDBOX_ROOT}/install-opencode.sh`,
            content: INSTALL_OPENCODE_SH,
          },
          {
            path: `${SANDBOX_ROOT}/opencode-tools.tsv`,
            content: packEntries(OPENCODE_LOCK.files),
          },
        ]
      : []),
    {
      path: `${SANDBOX_ROOT}/setup.sh`,
      content: agent && agentVersion ? agentVersionSetupScript(setup) : setup,
    },
    {
      path: `${SANDBOX_ROOT}/make-env.sh`,
      content: repository
        ? buildRepositoryMakeEnvScript(repository.install)
        : buildMakeEnvScript(environment),
    },
    {
      path: `${SANDBOX_ROOT}/run-agent.sh`,
      content:
        agent === 'opencode'
          ? opencodeRunScript(RUN_AGENT_SH)
          : agent === 'pi'
            ? piRunScript(RUN_AGENT_SH)
            : agent === 'muse_code'
              ? museCodeRunScript(RUN_AGENT_SH)
              : RUN_AGENT_SH,
    },
    { path: `${SANDBOX_ROOT}/agent-session.sh`, content: AGENT_SESSION_SH },
    { path: `${SANDBOX_ROOT}/stop-agent.sh`, content: STOP_AGENT_SH },
    { path: `${SANDBOX_ROOT}/logger.py`, content: LOGGER_PY },
    { path: `${SANDBOX_ROOT}/capture-sources.py`, content: CAPTURE_SOURCES_PY },
    {
      path: `${SANDBOX_ROOT}/agent-tools.tsv`,
      content: packEntries(lockedStarter('agent-tools').files),
    },
    ...(repository
      ? [{ path: REPOSITORY_TSV, content: repository.packed }]
      : starterFiles(environment)),
    {
      path: `${SANDBOX_ROOT}/watch-pick.sh`,
      content: buildWatchPickScript(signals.earlyStop),
    },
  ];
}

/** The environment's committed starter and its locks, packed for make-env.sh. */
function starterFiles(environment: EnvironmentDefinition): SandboxAsset[] {
  const starter = lockedStarter(environment.starter);
  return [
    {
      path: `${SANDBOX_ROOT}/starter.tsv`,
      content: packEntries(starter.files),
    },
    {
      path: `${SANDBOX_ROOT}/starter-locks.tsv`,
      content: packEntries(starter.locks),
    },
  ];
}
