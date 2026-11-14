/**
 * ABOUTME: Where uploads go and how the login is kept: the environment overriding a saved login
 * without reading it, a key saved by 0.2.0 still read, a saved sign-in used only for its API root
 * and project, keys refused by name (never echoed) when they aren't DevTune's format, a saved
 * login refused in a directory another user could reach, and, across real processes, a login lock
 * that excludes another process and is released when its holder is killed, a sign-in renewed once
 * by concurrent commands, and a renewal saved even when an interrupt arrives during it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { build } from 'esbuild';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  devtuneTarget,
  loginPath,
  saveLogin,
  sessionTokens,
  withLoginLock,
} from './devtune-login';
import {
  ApiKeyFormatError,
  NotLoggedInError,
  SignInError,
  UnsafeConfigDirectoryError,
} from './errors';
import { stubFetch, TARGET } from './fake-devtune';
import { FAKE_HOME, fakeHost } from './fake-host';
import { issued, savedSession, TOKEN } from './fake-oauth';

const SAVED = `${FAKE_HOME}/.config/agentpicks/credentials.json`;
const BAD_KEY = `${TARGET.apiKey}\0`;

describe('devtuneTarget', () => {
  it('takes DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID without reading a saved login, even a malformed one', () => {
    const io = fakeHost({
      env: {
        DEVTUNE_API_KEY: TARGET.apiKey,
        DEVTUNE_PROJECT_ID: TARGET.projectId,
      },
      files: { [SAVED]: 'not json' },
    });
    expect(devtuneTarget(io)).toEqual({
      baseUrl: 'https://devtune.ai/api/v2',
      projectId: TARGET.projectId,
      apiKey: TARGET.apiKey,
    });
  });

  it('refuses a DEVTUNE_API_KEY that is not a DevTune key by name, without echoing it', () => {
    const io = fakeHost({
      env: { DEVTUNE_API_KEY: BAD_KEY, DEVTUNE_PROJECT_ID: TARGET.projectId },
    });
    expect(() => devtuneTarget(io)).toThrow(ApiKeyFormatError);
    expect(() => devtuneTarget(io)).toThrow(
      /^DEVTUNE_API_KEY isn't a DevTune API key/,
    );
    try {
      devtuneTarget(io);
    } catch (error) {
      expect((error as Error).message).not.toContain(TARGET.apiKey);
    }
  });

  it('reads a key and project saved by 0.2.0 unchanged', () => {
    const io = fakeHost({
      files: {
        [SAVED]: `${JSON.stringify(
          { projectId: TARGET.projectId, apiKey: TARGET.apiKey },
          null,
          2,
        )}\n`,
      },
    });
    expect(devtuneTarget(io)).toEqual({
      baseUrl: 'https://devtune.ai/api/v2',
      projectId: TARGET.projectId,
      apiKey: TARGET.apiKey,
    });
  });

  it('refuses a saved key that is not a DevTune key, without echoing it', () => {
    const io = fakeHost({
      files: {
        [SAVED]: JSON.stringify({
          projectId: TARGET.projectId,
          apiKey: BAD_KEY,
        }),
      },
    });
    expect(() => devtuneTarget(io)).toThrow(
      new NotLoggedInError(
        `The saved login in ${SAVED} can't be read. Run agentpicks login again.`,
      ),
    );
  });
});

describe('saveLogin', () => {
  let config: string;
  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'agentpicks-config-'));
  });
  afterEach(() => rmSync(config, { recursive: true, force: true }));
  const path = () =>
    loginPath({
      env: { XDG_CONFIG_HOME: config },
      home: '/',
      platform: 'linux',
    });
  const LOGIN = { projectId: TARGET.projectId, apiKey: TARGET.apiKey };

  it('writes the login at mode 0600 and leaves no temporary file', async () => {
    await saveLogin(path(), LOGIN);
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual(LOGIN);
    expect(statSync(path()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(config, 'agentpicks'))).toEqual([
      'credentials.json',
    ]);
  });

  it('refuses a directory group or others can write to', async () => {
    mkdirSync(join(config, 'agentpicks'));
    chmodSync(join(config, 'agentpicks'), 0o777);
    await expect(saveLogin(path(), LOGIN)).rejects.toThrow(
      UnsafeConfigDirectoryError,
    );
    expect(existsSync(path())).toBe(false);
  });

  it('refuses a directory that is a symlink', async () => {
    mkdirSync(join(config, 'real'), { mode: 0o700 });
    symlinkSync(join(config, 'real'), join(config, 'agentpicks'));
    await expect(saveLogin(path(), LOGIN)).rejects.toThrow(
      UnsafeConfigDirectoryError,
    );
    expect(existsSync(join(config, 'real', 'credentials.json'))).toBe(false);
  });
});

describe('devtuneTarget with a saved sign-in', () => {
  const session = savedSession(Date.now() + 3_600_000);
  const host = (env: Record<string, string> = {}, saved: unknown = session) =>
    fakeHost({
      env: { DEVTUNE_API_BASE_URL: TARGET.baseUrl, ...env },
      files: { [SAVED]: JSON.stringify(saved) },
    });

  it('uploads to the signed-in project with the session', async () => {
    const target = devtuneTarget(host());
    expect(target).toMatchObject({
      baseUrl: TARGET.baseUrl,
      projectId: TARGET.projectId,
    });
    expect('session' in target).toBe(true);
  });

  it('leaves what the sign-in may do to DevTune, not to the scopes saved with it', () => {
    const target = devtuneTarget(
      host({}, { ...session, scopes: ['visibility.read'] }),
    );
    expect('session' in target).toBe(true);
  });

  it('takes DEVTUNE_API_KEY over the sign-in, for the signed-in project', () => {
    expect(devtuneTarget(host({ DEVTUNE_API_KEY: TARGET.apiKey }))).toEqual({
      baseUrl: TARGET.baseUrl,
      projectId: TARGET.projectId,
      apiKey: TARGET.apiKey,
    });
  });

  it('refuses a DEVTUNE_PROJECT_ID the sign-in is not for', () => {
    const other = '99999999-2222-4333-8444-555555555555';
    expect(() => devtuneTarget(host({ DEVTUNE_PROJECT_ID: other }))).toThrow(
      new NotLoggedInError(
        `DEVTUNE_PROJECT_ID is ${other}, and the saved sign-in is for project ${TARGET.projectId}. Run agentpicks login and choose that project, or set DEVTUNE_API_KEY too.`,
      ),
    );
  });

  it('refuses a sign-in made for another API root', () => {
    const io = fakeHost({ files: { [SAVED]: JSON.stringify(session) } });
    expect(() => devtuneTarget(io)).toThrow(
      new NotLoggedInError(
        `The saved sign-in is for ${TARGET.baseUrl}, and uploads go to https://devtune.ai/api/v2. Run agentpicks login to sign in there, or set DEVTUNE_API_BASE_URL to ${TARGET.baseUrl}.`,
      ),
    );
  });

  it.each([
    [
      'a token endpoint off the issuer',
      { tokenEndpoint: 'https://evil.test/token' },
    ],
    [
      'plain HTTP off this machine',
      {
        issuer: 'http://devtune.test/auth/v1',
        tokenEndpoint: 'http://devtune.test/token',
      },
    ],
    ['a token a header cannot carry', { accessToken: 'access one' }],
  ])('refuses a saved sign-in with %s', (_case, change) => {
    expect(() => devtuneTarget(host({}, { ...session, ...change }))).toThrow(
      new NotLoggedInError(
        `The saved login in ${SAVED} can't be read. Run agentpicks login again.`,
      ),
    );
  });
});

describe('sessionTokens', () => {
  let config: string;
  let path: string;
  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'agentpicks-session-'));
    path = join(config, 'agentpicks', 'credentials.json');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(config, { recursive: true, force: true });
  });
  const saved = () => JSON.parse(readFileSync(path, 'utf8'));

  it('uses an access token that outlasts the next minute without renewing it', async () => {
    const calls = stubFetch({});
    const session = savedSession(Date.now() + 3_600_000);
    await saveLogin(path, session);
    expect(await sessionTokens(path, session).accessToken()).toBe('access-one');
    expect(calls).toEqual([]);
  });

  it('renews an expired token once across concurrent commands, saving the new refresh token at mode 0600', async () => {
    const calls = stubFetch({
      [`POST ${TOKEN}`]: [issued('access-two', 'refresh-two')],
    });
    const session = savedSession(0);
    await saveLogin(path, session);
    const a = sessionTokens(path, session);
    const b = sessionTokens(path, session);
    expect(await Promise.all([a.accessToken(), b.accessToken()])).toEqual([
      'access-two',
      'access-two',
    ]);
    expect(calls.filter((c) => c.url === TOKEN)).toHaveLength(1);
    expect(saved()).toMatchObject({
      accessToken: 'access-two',
      refreshToken: 'refresh-two',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(path)).sort()).toEqual([
      'credentials.json',
      'credentials.json.lock',
    ]);
  });

  it('keeps the saved sign-in when DevTune refuses to renew it, saying to log in again', async () => {
    stubFetch({
      [`POST ${TOKEN}`]: [{ status: 400, body: { error: 'invalid_grant' } }],
    });
    const session = savedSession(0);
    await saveLogin(path, session);
    await expect(sessionTokens(path, session).accessToken()).rejects.toThrow(
      new SignInError(
        'Your DevTune sign-in has expired or was revoked. Run agentpicks login again.',
      ),
    );
    expect(saved()).toEqual(session);
  });

  it('refuses a sign-in saved again for another client meanwhile, without renewing it', async () => {
    const calls = stubFetch({});
    const session = savedSession(0);
    await saveLogin(path, { ...session, clientId: 'another-client' });
    await expect(sessionTokens(path, session).accessToken()).rejects.toThrow(
      'The saved login changed while agentpicks was running. Run the command again.',
    );
    expect(calls).toEqual([]);
  });

  it('refuses when another login replaced the sign-in meanwhile', async () => {
    stubFetch({});
    const session = savedSession(0);
    await saveLogin(path, {
      projectId: TARGET.projectId,
      apiKey: TARGET.apiKey,
    });
    await expect(sessionTokens(path, session).accessToken()).rejects.toThrow(
      'The saved login changed while agentpicks was running. Run the command again.',
    );
  });
});

describe('withLoginLock', () => {
  let config: string;
  let path: string;
  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'agentpicks-lock-'));
    path = join(config, 'agentpicks', 'credentials.json');
    mkdirSync(dirname(path), { mode: 0o700 });
  });
  afterEach(() => {
    vi.doUnmock('fs-native-extensions');
    rmSync(config, { recursive: true, force: true });
  });

  it('runs one holder at a time, leaving only the empty lock file', async () => {
    const order: string[] = [];
    const hold = (name: string) =>
      withLoginLock(path, async () => {
        order.push(`${name} in`);
        await sleep(30);
        order.push(`${name} out`);
      });
    await Promise.all([hold('a'), hold('b')]);
    // Whichever holds it first leaves before the other enters.
    expect(order.map((step) => step.split(' ')[1])).toEqual([
      'in',
      'out',
      'in',
      'out',
    ]);
    expect(order[0]!.split(' ')[0]).toBe(order[1]!.split(' ')[0]);
    expect(readdirSync(dirname(path))).toEqual(['credentials.json.lock']);
    expect(statSync(`${path}.lock`).mode & 0o777).toBe(0o600);
  });

  const NO_LOCK = new SignInError(
    "agentpicks can't lock its saved login on this machine, which a browser sign-in needs. Set DEVTUNE_API_KEY and DEVTUNE_PROJECT_ID, or save a project API key with agentpicks login --api-key.",
  );

  it.each([
    [
      'the native addon has no build for this platform',
      () => {
        throw new Error(
          'No native build was found for platform=linux libc=musl',
        );
      },
    ],
    [
      'the file system refuses locks',
      () => ({
        tryLock: () => {
          throw new Error('ENOTSUP');
        },
      }),
    ],
  ])(
    'where %s, refuses a sign-in, naming the environment and --api-key, and saves a key unlocked',
    async (_case, addon) => {
      vi.doMock('fs-native-extensions', addon);
      await expect(withLoginLock(path, async () => 'held')).rejects.toThrow(
        NO_LOCK,
      );
      expect(
        await withLoginLock(path, async () => 'saved', {
          unlockedIfUnsupported: true,
        }),
      ).toBe('saved');
    },
  );

  it('refuses to save a key unlocked over a browser sign-in another machine saved here', async () => {
    vi.doMock('fs-native-extensions', () => {
      throw new Error('No native build was found for platform=linux libc=musl');
    });
    await saveLogin(path, savedSession(Date.now() + 3_600_000));
    const before = readFileSync(path, 'utf8');
    const save = vi.fn();
    await expect(
      withLoginLock(path, save, { unlockedIfUnsupported: true }),
    ).rejects.toThrow(
      new SignInError(
        `A browser sign-in is saved here; run agentpicks login --api-key where it was signed in, or remove ${path}.`,
      ),
    );
    expect(save).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('saves a key unlocked over a saved key', async () => {
    vi.doMock('fs-native-extensions', () => {
      throw new Error('No native build was found for platform=linux libc=musl');
    });
    await saveLogin(path, {
      projectId: TARGET.projectId,
      apiKey: TARGET.apiKey,
    });
    expect(
      await withLoginLock(path, async () => 'saved', {
        unlockedIfUnsupported: true,
      }),
    ).toBe('saved');
  });

  it('names the code and XDG_CONFIG_HOME when the lock file fails to open otherwise', async () => {
    mkdirSync(`${path}.lock`);
    await expect(withLoginLock(path, async () => 'held')).rejects.toThrow(
      new SignInError(
        `agentpicks can't open its lock file ${path}.lock (EISDIR). Fix it, or set XDG_CONFIG_HOME to another directory.`,
      ),
    );
  });

  it('names a lock file it cannot open, even for a key', async () => {
    writeFileSync(`${path}.lock`, '', { mode: 0o000 });
    for (const options of [{}, { unlockedIfUnsupported: true }])
      await expect(
        withLoginLock(path, async () => 'held', options),
      ).rejects.toThrow(
        new SignInError(
          `agentpicks can't open its lock file ${path}.lock (EACCES). Remove it, or make your user its owner, then run the command again.`,
        ),
      );
  });
});

/**
 * Other agentpicks processes: fake-login-process.ts bundled where Node finds this package's
 * fs-native-extensions, then spawned with an IPC channel.
 */
describe('the login across processes', () => {
  const bundle = join(
    import.meta.dirname,
    '../../node_modules/.cache/agentpicks-test/fake-login-process.mjs',
  );
  beforeAll(async () => {
    await build({
      entryPoints: [join(import.meta.dirname, 'fake-login-process.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      external: ['fs-native-extensions'],
      logLevel: 'silent',
    });
  });

  let config: string;
  let path: string;
  const children: ChildProcess[] = [];
  let server: Server | undefined;
  beforeEach(() => {
    config = mkdtempSync(join(tmpdir(), 'agentpicks-processes-'));
    path = join(config, 'agentpicks', 'credentials.json');
  });
  afterEach(async () => {
    for (const child of children.splice(0))
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    server?.close();
    server = undefined;
    rmSync(config, { recursive: true, force: true });
  });

  const start = (mode: string) => {
    const child = spawn(process.execPath, [bundle, mode, path], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk));
    const exited = once(child, 'exit').then(([code, signal]) => ({
      code: code as number | null,
      signal: signal as NodeJS.Signals | null,
      stdout,
    }));
    return { child, exited };
  };

  /**
   * DevTune's token endpoint on loopback, renewing to access-two and refresh-two. Each request is
   * counted, and answered once `answer` resolves for it.
   */
  const tokenServer = async (answer: () => Promise<void> = async () => {}) => {
    const requests: string[] = [];
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk));
      request.on('end', () => {
        requests.push(body);
        void answer().then(() => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify(issued('access-two', 'refresh-two').body),
          );
        });
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as { port: number };
    const issuer = `http://127.0.0.1:${port}/auth/v1`;
    await saveLogin(path, {
      ...savedSession(0),
      issuer,
      tokenEndpoint: `${issuer}/oauth/token`,
    });
    return requests;
  };
  const saved = () => JSON.parse(readFileSync(path, 'utf8'));

  it('keeps another process out while it holds the lock, and lets it in once that process is killed', async () => {
    const holder = start('hold');
    expect((await once(holder.child, 'message'))[0]).toBe('locked');
    let entered = false;
    const waiting = withLoginLock(path, async () => {
      entered = true;
    });
    await sleep(300);
    expect(entered).toBe(false);
    expect(holder.child.exitCode).toBeNull();
    holder.child.kill('SIGKILL');
    await waiting;
    expect(entered).toBe(true);
  });

  it('renews the sign-in once when two processes need it at the same time', async () => {
    const requests = await tokenServer(() => sleep(200));
    const [a, b] = await Promise.all([
      start('renew').exited,
      start('renew').exited,
    ]);
    expect([a.stdout, b.stdout]).toEqual(['access-two', 'access-two']);
    expect(requests).toHaveLength(1);
    expect(saved().refreshToken).toBe('refresh-two');
  });

  it.each([
    [
      'ends the process by default',
      'renew',
      1,
      { code: null, signal: 'SIGINT' },
    ],
    ['is handled, as in run', 'renew-handled', 1, { code: 130, signal: null }],
    [
      'is handled, as in run, then repeated',
      'renew-handled',
      2,
      { code: 130, signal: null },
    ],
  ])(
    'saves the rotated refresh token when an interrupt that %s arrives during the renewal',
    async (_case, mode, interrupts, ending) => {
      let renewing!: () => void;
      const reached = new Promise<void>((resolve) => (renewing = resolve));
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const requests = await tokenServer(() => {
        renewing();
        return answered;
      });
      const renewal = start(mode);
      await reached;
      for (let i = 0; i < interrupts; i++) {
        renewal.child.kill('SIGINT');
        await sleep(100);
      }
      answer();
      expect(await renewal.exited).toMatchObject(ending);
      expect(requests).toHaveLength(1);
      expect(saved()).toMatchObject({
        accessToken: 'access-two',
        refreshToken: 'refresh-two',
      });
    },
  );

  it('starts no renewal once an interrupt has stopped renewing', async () => {
    const requests = await tokenServer();
    const before = readFileSync(path, 'utf8');
    expect(await start('stopped').exited).toEqual({
      code: 2,
      signal: null,
      stdout: 'Stopping: the DevTune sign-in was not renewed.',
    });
    expect(requests).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
