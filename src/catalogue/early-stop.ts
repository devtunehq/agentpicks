/** ABOUTME: The patterns the in-sandbox early-stop watcher reads to tell that a pick has landed. */

/**
 * POSIX extended regexes (`grep -E`) for the in-sandbox early-stop watcher: one matched
 * case-insensitively against `+` lines of the manifest diff, one against changed source files.
 */
export interface EarlyStopPatterns {
  installPattern: string;
  codePattern: string;
  /**
   * Matched against the paths of files the agent created, for tools wired in by a config file
   * (`.circleci/config.yml`). A file the starter already had is read by `codePattern` alone, so
   * a starter's own workflow never stops a run.
   */
  pathPattern?: string;
}
