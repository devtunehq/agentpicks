/**
 * ABOUTME: Where `agentpicks run` and `upload` send bundles, and with what: the DevTune API root, a
 * project, and a project API key or a browser sign-in. `agentpicks login` saves either to a file only
 * the user can read; a saved sign-in is renewed under a kernel file lock, and once a renewal starts
 * it is saved before an interrupt ends the process, so no command loses the newest refresh token.
 * DEVTUNE_API_KEY, DEVTUNE_PROJECT_ID and DEVTUNE_API_BASE_URL, the names
 * `@devtune/cli` reads, take precedence, so CI needs no login. Keys and tokens are never printed.
 */
import { randomBytes } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import {
  ApiKeyFormatError,
  NotLoggedInError,
  SignInError,
  UnsafeConfigDirectoryError,
  UsageError,
} from './errors';
import type { HostIo } from './host';
import { isTrustedUrl, refreshSession, type OAuthSession } from './oauth';

export const DEFAULT_API_BASE_URL = 'https://devtune.ai/api/v2';

/** A saved sign-in's access token, renewed when it is about to expire. */
export interface SessionTokens {
  accessToken(): Promise<string>;
}

/** What an API v2 call authenticates with: a project API key or a signed-in session. */
export type DevtuneCredential = { apiKey: string } | { session: SessionTokens };

export type DevtuneTarget = {
  /** The API root, ending in /api/v2, without a trailing slash. */
  baseUrl: string;
  projectId: string;
} & DevtuneCredential;

/** A DevTune API key: `dtk_live_` and letters and digits, so nothing in it can break or leak through a header. */
const API_KEY = /^dtk_live_[0-9A-Za-z]+$/;

/** Refuses a key that isn't a DevTune API key, naming where it came from and never the key. */
export function assertApiKey(apiKey: string, source: string): void {
  if (!API_KEY.test(apiKey))
    throw new ApiKeyFormatError(
      `${source} isn't a DevTune API key: a key is dtk_live_ followed by letters and digits. Copy it again from API Keys in DevTune.`,
    );
}

/** Visible ASCII only, so a token can't break or leak through a header. */
const TOKEN = /^[\x21-\x7e]+$/;

const savedKeySchema = z.object({
  projectId: z.uuid(),
  apiKey: z.string().regex(API_KEY),
});

/** The saved file is a local trust boundary: its URLs are checked before a token goes to them. */
const savedSessionSchema = z
  .object({
    type: z.literal('oauth'),
    baseUrl: z.string(),
    issuer: z.url(),
    tokenEndpoint: z.url(),
    clientId: z.string().regex(TOKEN),
    projectId: z.uuid(),
    accessToken: z.string().regex(TOKEN),
    refreshToken: z.string().regex(TOKEN),
    expiresAt: z.number(),
    scopes: z.array(z.string()),
  })
  .refine(
    (session) =>
      apiRoot(session.baseUrl) === session.baseUrl &&
      new URL(session.tokenEndpoint).origin ===
        new URL(session.issuer).origin &&
      isTrustedUrl(new URL(session.tokenEndpoint)),
  );

/** A login as saved: a key and its project, as 0.2.0 wrote it too, or a browser sign-in. */
const savedLoginSchema = z.union([savedSessionSchema, savedKeySchema]);
export type SavedLogin = z.infer<typeof savedLoginSchema>;

/**
 * The saved login's path: `agentpicks/credentials.json` under XDG_CONFIG_HOME, or else under
 * %APPDATA% on Windows and ~/.config elsewhere.
 */
export function loginPath(io: Pick<HostIo, 'env' | 'home' | 'platform'>) {
  const config =
    io.env.XDG_CONFIG_HOME ||
    (io.platform === 'win32' && io.env.APPDATA) ||
    join(io.home, '.config');
  return join(config, 'agentpicks', 'credentials.json');
}

/** The API root without a trailing slash, or null when it isn't HTTPS (HTTP on loopback) ending in /api/v2. */
function apiRoot(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.search ||
    !url.pathname.replace(/\/$/, '').endsWith('/api/v2') ||
    !isTrustedUrl(url)
  )
    return null;
  return url.href.replace(/\/$/, '');
}

/**
 * DEVTUNE_API_BASE_URL, or devtune.ai's API. HTTPS only, except on loopback, since the key or
 * token goes with every request.
 */
export function apiBaseUrl(env: HostIo['env']): string {
  const value = env.DEVTUNE_API_BASE_URL || DEFAULT_API_BASE_URL;
  const root = apiRoot(value);
  if (!root)
    throw new UsageError(
      `DEVTUNE_API_BASE_URL must be an HTTPS address ending in /api/v2 (HTTP only on this machine), not ${value}.`,
    );
  return root;
}

/** The saved login in `text`, refused by name when it can't be read. */
function parseSavedLogin(text: string, path: string): SavedLogin {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Refused below.
  }
  const result = savedLoginSchema.safeParse(parsed);
  if (!result.success)
    throw new NotLoggedInError(
      `The saved login in ${path} can't be read. Run agentpicks login again.`,
    );
  return result.data;
}

/**
 * The DevTune project bundles go to: the environment's key and project, else the saved login's. A
 * saved sign-in is used only for the API root and project it was granted for, and only when
 * DEVTUNE_API_KEY isn't set. Refuses, saying how to log in and that --no-upload keeps bundles on
 * disk, when there is nothing to upload with.
 */
export function devtuneTarget(
  io: HostIo,
  purpose: 'upload' | 'setups' = 'upload',
): DevtuneTarget {
  const path = loginPath(io);
  const baseUrl = apiBaseUrl(io.env);
  // With both set, the environment overrides the saved login entirely, so it isn't read.
  const text =
    io.env.DEVTUNE_API_KEY && io.env.DEVTUNE_PROJECT_ID
      ? null
      : io.readFile(path);
  const saved = text === null ? null : parseSavedLogin(text, path);
  if (saved && 'type' in saved && !io.env.DEVTUNE_API_KEY) {
    if (saved.baseUrl !== baseUrl)
      throw new NotLoggedInError(
        `The saved sign-in is for ${saved.baseUrl}, and uploads go to ${baseUrl}. Run agentpicks login to sign in there, or set DEVTUNE_API_BASE_URL to ${saved.baseUrl}.`,
      );
    const project = io.env.DEVTUNE_PROJECT_ID;
    if (project && project !== saved.projectId)
      throw new NotLoggedInError(
        `DEVTUNE_PROJECT_ID is ${project}, and the saved sign-in is for project ${saved.projectId}. Run agentpicks login and choose that project, or set DEVTUNE_API_KEY too.`,
      );
    return {
      baseUrl,
      projectId: saved.projectId,
      session: sessionTokens(path, saved),
    };
  }
  const apiKey =
    io.env.DEVTUNE_API_KEY ||
    (saved && 'apiKey' in saved ? saved.apiKey : undefined);
  const projectId = io.env.DEVTUNE_PROJECT_ID || saved?.projectId;
  if (!apiKey || !projectId)
    throw new NotLoggedInError(
      purpose === 'setups'
        ? 'Pushing or pulling setups needs a DevTune sign-in or project API key. Run agentpicks login, or set DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID.'
        : 'Uploading needs a DevTune sign-in or project API key. Run agentpicks login, or set DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID. To keep bundles on this machine only, pass --no-upload.',
    );
  if (io.env.DEVTUNE_API_KEY) assertApiKey(apiKey, 'DEVTUNE_API_KEY');
  if (!z.uuid().safeParse(projectId).success)
    throw new NotLoggedInError(
      `DEVTUNE_PROJECT_ID must be a project id, not ${projectId}.`,
    );
  return { baseUrl, projectId, apiKey };
}

/** How long before it expires an access token is renewed, so a request never carries a lapsing one. */
const RENEW_BEFORE_MS = 60_000;

/**
 * The saved sign-in's access token, renewed and saved when it expires within a minute. The file is
 * read again under the login lock each time, so a token another process renewed is used rather
 * than renewed again. A sign-in another login replaced meanwhile, even for the same project, is
 * refused.
 */
export function sessionTokens(
  path: string,
  initial: Pick<OAuthSession, 'baseUrl' | 'projectId' | 'clientId'>,
): SessionTokens {
  return {
    accessToken: () =>
      withLoginLock(path, async () => {
        let text: string | null = null;
        try {
          text = readFileSync(path, 'utf8');
        } catch {
          // Removed meanwhile: refused below.
        }
        const current = text === null ? null : parseSavedLogin(text, path);
        if (
          !current ||
          !('type' in current) ||
          current.baseUrl !== initial.baseUrl ||
          current.projectId !== initial.projectId ||
          current.clientId !== initial.clientId
        )
          throw new SignInError(
            'The saved login changed while agentpicks was running. Run the command again.',
          );
        if (current.expiresAt > Date.now() + RENEW_BEFORE_MS)
          return current.accessToken;
        // An interrupted command ends soon after; a renewal it started now could be cut off.
        if (stopped)
          throw new SignInError(
            'Stopping: the DevTune sign-in was not renewed.',
          );
        // Renewing rotates the refresh token on DevTune's side, so the new one is saved before an
        // interrupt may end the process.
        return finishBeforeExit(async () => {
          const renewed = { ...current, ...(await refreshSession(current)) };
          await saveLogin(path, renewed);
          return renewed.accessToken;
        });
      }),
  };
}

let unfinished = 0;
let finished: (() => void)[] = [];
let stopped = false;

/**
 * Stops this process from starting another renewal, which `run`'s interrupt handler calls before it
 * ends the process: one already started still finishes and is saved (see loginSaved).
 */
export function stopRenewing() {
  stopped = true;
}

/**
 * Resolves once no renewed sign-in is waiting to be saved. An interrupt handler that ends the
 * process, as `run`'s does, awaits this first.
 */
export function loginSaved(): Promise<void> {
  if (unfinished === 0) return Promise.resolve();
  return new Promise((resolve) => finished.push(resolve));
}

/**
 * Runs `work` to the end even when SIGINT or SIGTERM arrives meanwhile, however many times: while
 * it runs, no such signal takes Node's default action of ending the process at once. Afterwards a
 * held signal that nothing else handled when `work` began is raised again; one another handler
 * took (as `run`'s does, waiting on loginSaved) is left to it.
 */
async function finishBeforeExit<T>(work: () => Promise<T>): Promise<T> {
  const held: NodeJS.Signals[] = [];
  const hold = (signal: NodeJS.Signals) => held.push(signal);
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const unhandled = signals.filter(
    (signal) => process.listenerCount(signal) === 0,
  );
  for (const signal of signals) process.on(signal, hold);
  unfinished++;
  try {
    return await work();
  } finally {
    for (const signal of signals) process.off(signal, hold);
    if (--unfinished === 0) {
      for (const resolve of finished) resolve();
      finished = [];
    }
    const raise = held.find((signal) =>
      (unhandled as readonly string[]).includes(signal),
    );
    if (raise) process.kill(process.pid, raise);
  }
}

/**
 * How long a command waits for another holding the login lock: well past a holder's longest hold,
 * a renewal whose request and answer take up to 30 seconds, then a save.
 */
const LOCK_WAIT_MS = 90_000;

const NO_LOCK =
  "agentpicks can't lock its saved login on this machine, which a browser sign-in needs. Set DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID, or save a project API key with agentpicks login --api-key.";

/**
 * Runs `action` holding the login lock, a kernel advisory lock on `<path>.lock`, which serializes
 * saving and renewing the login across agentpicks processes. The kernel releases it when the
 * process ends, however it ends, so no lock outlives its holder. The lock file stays, empty, and
 * is never removed while another process may hold it. Waits up to 90 seconds for another holder.
 *
 * Where locking can't work (the native addon has no build for this platform, or the file system
 * refuses locks), `unlockedIfUnsupported` runs `action` without it; only saving a key passes it.
 * It refuses when the file holds a browser sign-in, which a machine that can lock may have saved
 * into a shared directory and may be renewing, so the unlocked save only ever replaces a key.
 */
export async function withLoginLock<T>(
  path: string,
  action: () => Promise<T>,
  options: { unlockedIfUnsupported?: boolean } = {},
): Promise<T> {
  await ensureLoginDirectory(dirname(path));
  const unsupported = () => {
    if (!options.unlockedIfUnsupported) throw new SignInError(NO_LOCK);
    let saved: unknown = null;
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Nothing saved, or nothing readable: the key replaces it.
    }
    if ((saved as { type?: unknown } | null)?.type === 'oauth')
      throw new SignInError(
        `A browser sign-in is saved here; run agentpicks login --api-key where it was signed in, or remove ${path}.`,
      );
    return action();
  };
  let tryLock: (fd: number) => boolean;
  try {
    ({ tryLock } = await import('fs-native-extensions'));
  } catch {
    return unsupported();
  }
  const lockPath = `${path}.lock`;
  let file;
  try {
    // O_CREAT without O_TRUNC keeps the one file every contender locks.
    file = await open(lockPath, constants.O_CREAT | constants.O_RDWR, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new SignInError(
      code === 'EACCES' || code === 'EPERM'
        ? `agentpicks can't open its lock file ${lockPath} (${code}). Remove it, or make your user its owner, then run the command again.`
        : `agentpicks can't open its lock file ${lockPath} (${code}). Fix it, or set XDG_CONFIG_HOME to another directory.`,
    );
  }
  try {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      let locked: boolean;
      try {
        locked = tryLock(file.fd);
      } catch {
        return await unsupported();
      }
      if (locked) return await action();
      if (Date.now() >= deadline)
        throw new SignInError(
          'Another agentpicks command is using the saved login. Try again when it finishes.',
        );
      await sleep(100);
    }
  } finally {
    await file.close();
  }
}

/**
 * Makes the login's directory if needed, refusing one another user could swap the file in: a
 * symlink, or one this user doesn't own or that group or others can write.
 */
export async function ensureLoginDirectory(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o022) !== 0))
  )
    throw new UnsafeConfigDirectoryError(
      `${dir} must be a directory you own that no other user can write to, not a symlink. Fix it, or set XDG_CONFIG_HOME to another directory, then run agentpicks login again.`,
    );
}

/**
 * Saves the login, replacing any other, in a file only this user can read and write (mode 0600),
 * in a directory ensureLoginDirectory accepts. The file is written under a fresh random name,
 * created exclusively, then renamed into place, so a reader never sees half a file.
 */
export async function saveLogin(path: string, login: SavedLogin) {
  const dir = dirname(path);
  await ensureLoginDirectory(dir);
  const partial = join(
    dir,
    `.credentials.${randomBytes(16).toString('hex')}.partial`,
  );
  try {
    await writeFile(partial, `${JSON.stringify(login, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(partial, path);
  } catch (error) {
    // A half-written or unrenamed file holds the sign-in's tokens; none is left behind.
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * Reads one line from standard input. From a terminal it prompts on standard error and doesn't
 * echo what is typed; from a pipe it reads the first line.
 */
export async function readSecretLine(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    // Stops at the first line, so a pipe that stays open after the key doesn't hang login.
    let text = '';
    for await (const chunk of stdin) {
      text += (chunk as Buffer).toString('utf8');
      const end = text.search(/\r?\n/);
      if (end !== -1) return text.slice(0, end);
    }
    return text;
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  try {
    return await new Promise<string>((resolve, reject) => {
      let line = '';
      const onData = (text: string) => {
        for (const c of text) {
          if (c === '\r' || c === '\n') {
            stdin.off('data', onData);
            return resolve(line);
          }
          if (c === '\u0003') {
            stdin.off('data', onData);
            return reject(new UsageError('Login canceled.'));
          }
          line = c === '\u007f' || c === '\b' ? line.slice(0, -1) : line + c;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write('\n');
  }
}
