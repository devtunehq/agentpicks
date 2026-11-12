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
