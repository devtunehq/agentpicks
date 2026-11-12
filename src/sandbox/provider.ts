/**
 * ABOUTME: The sandbox interface a run needs: create a fresh machine or reattach to one by
 * id, run shell commands as root (waiting or detached), write and read files, and destroy
 * it. Providers implement this shape.
 */

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxExecOptions {
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface Sandbox {
  /** The provider's id for the sandbox, recorded on the run. */
  readonly id: string;
  /** Runs `command` with `bash -lc` as root and waits for it. */
  exec(
    command: string,
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult>;
  /**
   * Starts `command` with `bash -lc` as root and returns without waiting. `timeoutSec`
   * kills it even though nobody waits. The caller learns it finished from files it writes.
   */
  spawn(command: string, options?: SandboxExecOptions): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  /** The file's text, or null when it does not exist. */
  readFile(path: string): Promise<string | null>;
  destroy(): Promise<void>;
}

export interface SandboxCreateOptions {
  /** The provider stops the sandbox after this long even if `destroy` is never called. */
  timeoutMin: number;
}

export interface SandboxProvider {
  readonly name: string;
  create(options: SandboxCreateOptions): Promise<Sandbox>;
  /** Reattaches to a sandbox by id; null when it no longer exists. */
  get(id: string): Promise<Sandbox | null>;
}
