/**
 * ABOUTME: The named refusals `agentpicks` prints instead of starting a run: each says what is
 * wrong and what to do about it. The CLI prints the message alone and exits non-zero.
 */

/** An argument the CLI cannot use: a missing or malformed flag. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** `--category` names no public category. */
export class UnknownCategoryError extends Error {
  override readonly name = 'UnknownCategoryError';
}

/** `--stack` names no committed starter this category runs in. */
export class UnknownStackError extends Error {
  override readonly name = 'UnknownStackError';
}

/** `--stack` needs a runtime with no build for the Docker host's architecture. */
export class StackArchitectureError extends Error {
  override readonly name = 'StackArchitectureError';
}

/** The agent is one agentpicks cannot run, such as Cursor, whose runs it has no capture for. */
export class UnsupportedAgentError extends Error {
  override readonly name = 'UnsupportedAgentError';
}

/** No agent to run: none installed, several and none chosen, or the chosen one is missing. */
export class AgentSelectionError extends Error {
  override readonly name = 'AgentSelectionError';
}

/** The agent's model cannot be run as configured. */
export class AgentModelError extends Error {
  override readonly name = 'AgentModelError';
}

/** A carried model endpoint cannot be used from inside the sandbox. */
export class AgentEndpointError extends Error {
  override readonly name = 'AgentEndpointError';
}

/** The agent's sign-in is held where agentpicks never reads it: the macOS Keychain or a system keyring. */
export class KeychainLoginError extends Error {
  override readonly name = 'KeychainLoginError';
}

/** The agent has no sign-in or key on this machine. */
export class MissingCredentialsError extends Error {
  override readonly name = 'MissingCredentialsError';
}

/** The agent's sign-in expires before a run could finish. */
export class LoginExpiringError extends Error {
  override readonly name = 'LoginExpiringError';
}

/** `--repo` names a path that is not inside a git repository. */
export class NotARepositoryError extends Error {
  override readonly name = 'NotARepositoryError';
}

/** git is missing from this machine, or too old to read a repository safely. */
export class UnsupportedGitError extends Error {
  override readonly name = 'UnsupportedGitError';
}

/** `--ref` names no commit in the repository, or HEAD has no commit yet. */
export class UnknownCommitError extends Error {
  override readonly name = 'UnknownCommitError';
}

/** The repository installs with a package manager the sandbox has no frozen install for, or has no lockfile. */
export class UnsupportedPackageManagerError extends Error {
  override readonly name = 'UnsupportedPackageManagerError';
}

/** The repository's committed content cannot be copied into the container: too large, or a path the copy cannot carry. */
export class RepositoryContentError extends Error {
  override readonly name = 'RepositoryContentError';
}

/** The repository's commit has submodules, which a commit holds only as commit ids. */
export class SubmodulesError extends Error {
  override readonly name = 'SubmodulesError';
}

/** The repository lacks objects of the commit locally (a partial clone), and agentpicks never fetches. */
export class MissingObjectsError extends Error {
  override readonly name = 'MissingObjectsError';
}

/** Gemfile.lock names no platform the Linux sandbox runs, so Bundler can't install it frozen. */
export class GemfilePlatformsError extends Error {
  override readonly name = 'GemfilePlatformsError';
}

/** requirements.txt has a line not pinned with `==` and a `--hash`, so pip can't install it frozen. */
export class UnhashedRequirementsError extends Error {
  override readonly name = 'UnhashedRequirementsError';
}

/**
 * An upload needs a DevTune sign-in or project API key, and neither `agentpicks login` nor the
 * environment gave one, or the saved sign-in can't upload to the project it names.
 */
export class NotLoggedInError extends Error {
  override readonly name = 'NotLoggedInError';
}

/** `--repo` names a repository with no remote agentpicks records, which DevTune needs to group its runs. */
export class RepositoryRemoteError extends Error {
  override readonly name = 'RepositoryRemoteError';
}

/** A bundle on disk is not one agentpicks wrote, or changed after it was written. */
export class BundleError extends Error {
  override readonly name = 'BundleError';
}

/**
 * DevTune refused an upload or another API call, or could not be reached. The message is DevTune's
 * own where it gave one, and `reason` its refusal code (such as setup_changed). `transient` marks a
 * failure to reach DevTune or a status `isTransientStatus` names, which may pass on retry.
 */
export class UploadError extends Error {
  override readonly name = 'UploadError';
  readonly transient: boolean;
  readonly reason: string | null;
  readonly status: number | null;
  constructor(
    message: string,
    options: { transient?: boolean; reason?: string; status?: number } = {},
  ) {
    super(message);
    this.transient = options.transient ?? false;
    this.reason = options.reason ?? null;
    this.status = options.status ?? null;
  }
}

/** A DevTune API key, from standard input or DEVTUNE_API_KEY, that isn't in DevTune's key format. */
export class ApiKeyFormatError extends Error {
  override readonly name = 'ApiKeyFormatError';
}

/** The directory the login is saved in is one another user could read or replace the file in. */
export class UnsafeConfigDirectoryError extends Error {
  override readonly name = 'UnsafeConfigDirectoryError';
}

/** Statuses where a retry may pass: 408, 425, 429 and 5xx. A renewal treats 502 and 504 as outcome unknown instead. */
export function isTransientStatus(status: number) {
  return status >= 500 || [408, 425, 429].includes(status);
}

/**
 * Signing in to DevTune through the browser failed, or the saved sign-in can no longer be used.
 * `transient` marks a request that may pass on retry: one that never reached DevTune, or a status
 * `isTransientStatus` names. A renewal whose outcome is unknown is never transient.
 */
export class SignInError extends Error {
  override readonly name = 'SignInError';
  readonly transient: boolean;
  constructor(message: string, options: { transient?: boolean } = {}) {
    super(message);
    this.transient = options.transient ?? false;
  }
}
