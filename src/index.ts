/**
 * ABOUTME: Entry point of @devtune/agentpicks, the open Agent Picks runner code: the sandbox
 * interface, the scripts a run uploads into the sandbox, each agent's launch, the run lifecycle,
 * the committed starters, the test environments and trace redaction. It imports nothing from
 * DevTune's private packages. Client components import this barrel, so it must stay free of Node
 * built-ins other than `node:crypto` (`src/root-export.spec.ts` checks it): the Docker sandbox
 * provider is exported separately as @devtune/agentpicks/sandbox/docker.
 */
export {
  BUNDLE_PATHS,
  BUNDLE_VERSION,
  bundleArtifactSchema,
  bundleManifestSchema,
  redactionSummarySchema,
  type BundleArtifact,
  type BundleManifest,
  type RedactionSummary,
} from './bundle/schema';
export { uploadArtifactByteLimit } from './bundle/artifact-limits';
export {
  CAPTURE_SOURCES_PY,
  SOURCE_ARTIFACT_BYTES,
  SOURCE_FILE_BYTES,
  SOURCE_FILE_LIMIT,
} from './assets/capture-sources';
export {
  buildLockStarterScript,
  buildMakeEnvScript,
  buildWatchPickScript,
  INSTALL_LOCKED_SH,
  INSTRUCTION_FILES,
  pinnedRuntimes,
} from './assets/environment-scripts';
export { lockedStarter } from './assets/locked-starter';
export { buildSandboxAssets, type SandboxAsset } from './assets/sandbox-assets';
export { SANDBOX_ROOT, script, shellQuote } from './assets/script';
export {
  AGENT_SESSION_SH,
  AGENT_TOOLS_RECIPE,
  LOGGER_PY,
  RUN_AGENT_SH,
  RUNTIMES_SH,
  SETUP_SH,
  STOP_AGENT_SH,
  UNPACK_FN,
} from './assets/static-scripts';
export {
  CATEGORY_REQUESTS,
  findCategoryRequests,
  type CategoryPrompt,
  type CategoryRequests,
  type JobPromptIntent,
} from './catalogue/categories';
export type { EarlyStopPatterns } from './catalogue/early-stop';
export { CATEGORY_EARLY_STOP } from './catalogue/early-stop.generated';
export { CATEGORY_TOOLS } from './catalogue/category-tools.generated';
export { resolveSetup } from './setup/resolve';
export {
  boardEnvironments,
  categoryEnvironments,
  ENVIRONMENTS,
  environmentRunsIn,
  findEnvironment,
  isCategoryScoped,
  isRetiredEnvironment,
  isSelectedByDefault,
  PREVIOUS_ENVIRONMENT_NAMES,
  RETIRED_ENVIRONMENT_SLUGS,
  STARTERS,
  type EnvironmentContext,
  type EnvironmentDefinition,
  type ProjectState,
  type StarterKey,
  type StarterRecipe,
} from './catalogue/environments';
export { PROMPT_INTENTS, type PromptIntent } from './catalogue/prompt-intents';
export { LOCKED_STARTERS } from './locks';
export {
  entryBytes,
  packEntries,
  parsePackedEntries,
  renderLockedIndexModule,
  renderLockedStarterModule,
  type LockedEntry,
  type LockedStarter,
} from './locks/locked-files';
export {
  INSTALL_OUTPUT_DIRS,
  INSTALL_OUTPUT_FILES,
  PROJECT_FILES_SH,
  starterDifferences,
} from './locks/starter-check';
export {
  AGENT_KINDS,
  type AgentKind,
  type ModelProvider,
} from './run/agent-kind';
export {
  AGENT_RUN_LIMITS,
  AGENT_TIMEOUT_SEC,
  describeLimitStop,
  SANDBOX_LIFETIME_MIN,
  SETUP_TIMEOUT_SEC,
  TIMEOUT_EXIT_CODE,
  turnLimit,
  type AgentRunLimits,
  type LimitStop,
} from './run/limits';
export {
  redactArtifacts,
  WRITTEN_SECRETS_LIMIT,
  WrittenSecretsLimitError,
} from './run/artifact-redaction';
export {
  AGENT_NPM_PACKAGES,
  agentVersionInstallScript,
  agentVersionSetupScript,
  type VersionedAgent,
} from './run/agent-version';
export { redactModelProxyTokens } from './run/model-proxy-token';
export { escapedForms, writtenSecrets } from './run/written-secrets';
export {
  INSTALL_MUSE_CODE_SH,
  museCodeRunScript,
  museCodeSetupScript,
  RUN_MUSE_SH,
} from './run/muse-code';
export { MUSE_CODE_LOCK } from './run/muse-code-lock';
export {
  INSTALL_OPENCODE_SH,
  OPENCODE_VERSION,
  opencodeProviderConfig,
  opencodeProviderEnv,
  opencodeRunScript,
  opencodeSetupScript,
} from './run/opencode';
export { OPENCODE_LOCK } from './run/opencode-lock';
export { OPENCODE_MODELS, OPENCODE_MODELS_JSON } from './run/opencode-models';
export {
  PI_CONTEXT_WINDOW,
  PI_HOME,
  PI_RUN_SH,
  PI_SETTINGS_JSON,
  PI_SETUP_SH,
  PI_TOOLS_RECIPE,
  piDirectBaseUrl,
  piProviderConfig,
  piRunScript,
  piSetupScript,
  piTranscriptError,
  writePiConfig,
  type PiModelSpec,
} from './run/pi';
export {
  agentInvocation,
  collectArtifacts,
  composePrompt,
  judgeAgentExit,
  parseEarlyStop,
  parseMeta,
  REQUEST_ENDING,
  RUN_ARTIFACTS,
  runInSandbox,
  setupCommand,
  uploadRunInputs,
  type AgentInvocation,
  type EarlyStopRecord,
  type RunArtifactName,
  type RunArtifacts,
  type RunOneLogger,
  type RunRedactor,
  type RunStage,
  type SandboxRunHooks,
  type SandboxRunJob,
  type SandboxRunResult,
} from './run/sandbox-run';
export { redactCredentialValues } from './run/trace-credentials';
export {
  createTraceRedactor,
  redactTrace,
  type TraceSecrets,
} from './run/trace-redaction';
export { traceJson, traceString } from './run/trace-text';
export {
  sandboxPlatform,
  UnsupportedArchitectureError,
  type SandboxPlatform,
} from './sandbox/platform';
export type {
  Sandbox,
  SandboxCreateOptions,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from './sandbox/provider';
