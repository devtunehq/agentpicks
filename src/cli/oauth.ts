/**
 * ABOUTME: The browser sign-in `agentpicks login` runs, ported from @devtune/cli's auth.ts: OAuth
 * discovery with its trust checks, a public client registered for a loopback redirect, PKCE S256,
 * DevTune's consent page choosing the project, and the refresh that renews a saved session.
 * Provider payloads are never printed, and the browser hears that sign-in worked only after the
 * code exchange, the project check and the save have succeeded. devtune-login.ts keeps the session.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isTransientStatus, SignInError } from './errors';
import { loginPage, loginPageCsp } from './login-page';
import { discoverProject } from './upload';

/** A signed-in session bound to one project, as `agentpicks login` saves it. */
export interface OAuthSession {
  type: 'oauth';
  /** The API root the session was granted for. */
  baseUrl: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  projectId: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in milliseconds since the epoch. */
  expiresAt: number;
  /** The scopes DevTune reported the sign-in holds when it was made. */
  scopes: string[];
}

/**
 * The scopes agentpicks uses: agent_picks.run to upload runs, visibility.read to read Agent Picks
 * setups and results, and actions.write to save setups and draft jobs and tools. agentpicks can't
 * ask for them: Supabase Auth's authorize endpoint accepts only OpenID scopes. DevTune's consent
 * page offers, preselected, every scope the member's role allows, and the sign-in holds those the
 * member keeps; `login` names any of these it lacks.
 */
export const AGENTPICKS_SCOPES = [
  'agent_picks.run',
  'visibility.read',
  'actions.write',
] as const;

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', 'localhost'];

/** An HTTPS URL, or HTTP on this machine, with no credentials or fragment. */
export function isTrustedUrl(url: URL) {
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)))
  );
}

// Unknown data is checked only at the OAuth protocol boundary; provider payloads are never printed.
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SignInError(
      'DevTune sent an unexpected sign-in response. Run agentpicks login again.',
    );
  return value as Record<string, unknown>;
}
function text(value: unknown) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value))
    throw new SignInError(
      'DevTune sent an unexpected sign-in response. Run agentpicks login again.',
    );
  return value;
}

const REFUSED = (status: number) =>
  `DevTune refused the sign-in request (${status}). Run agentpicks login again.`;

/**
 * Transport failures that mean the request never reached DevTune: no connection (refused, no
 * address, no route, undici's connect timeout) or a TLS handshake that failed before it was sent.
 */
const NOT_SENT = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const notSent = (code: unknown) =>
  typeof code === 'string' &&
  (NOT_SENT.has(code) ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_'));

/** Gateway answers that can come back after the token endpoint already rotated the token. */
const MAYBE_ACTED = [502, 504];

const RENEWAL_UNKNOWN =
  "DevTune's answer to renewing the sign-in didn't arrive, so whether it was renewed is unknown. Run agentpicks login.";

/**
 * One OAuth request's JSON answer, read up to 1 MiB, within 30 seconds, with no redirects. A 400,
 * 401 or 403 throws `refused`'s message. For a request that `rotates` a credential, a failure after
 * it may have reached DevTune (a timeout, a reset, a body cut off, a 502 or 504 from a gateway) leaves the outcome unknown, so it
 * says to sign in again rather than to retry.
 */
async function json(
  url: string,
  init: RequestInit = {},
  refused: (status: number) => string = REFUSED,
  rotates = false,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const code = ((error as Error).cause as { code?: unknown } | undefined)
      ?.code;
    if (rotates && !notSent(code)) throw new SignInError(RENEWAL_UNKNOWN);
    throw new SignInError(
      error instanceof Error && error.name === 'TimeoutError'
        ? 'A sign-in request to DevTune timed out. Try again.'
        : 'A sign-in request to DevTune failed. Check the connection and try again.',
      { transient: true },
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if ([400, 401, 403].includes(response.status))
      throw new SignInError(refused(response.status));
    if (rotates && MAYBE_ACTED.includes(response.status))
      throw new SignInError(RENEWAL_UNKNOWN);
    throw new SignInError(
      `A sign-in request to DevTune failed (${response.status}). Try again later.`,
      { transient: isTransientStatus(response.status) },
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SignInError('DevTune sent an empty sign-in response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  // A body that failed mid-read is already closed, and cancelling it would only throw its error again.
  let failed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > RESPONSE_MAX_BYTES)
        throw new SignInError('A sign-in response exceeded its size limit.');
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof SignInError) throw error;
    failed = true;
    if (rotates) throw new SignInError(RENEWAL_UNKNOWN);
    throw new SignInError(
      'A sign-in request to DevTune failed. Check the connection and try again.',
      { transient: true },
    );
  } finally {
    if (!failed) await reader.cancel();
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof SignInError) throw error;
    throw new SignInError('DevTune sent a sign-in response that is not JSON.');
  }
}

/** An endpoint discovery names, refused unless it is on the issuer's origin over a trusted URL. */
function endpoint(value: unknown, issuer: string) {
  const url = new URL(text(value));
  if (url.origin !== new URL(issuer).origin || !isTrustedUrl(url))
    throw new SignInError('OAuth discovery returned an untrusted endpoint.');
  return url.href;
}

async function discover(base: string) {
  const metadata = await json(
    new URL('/.well-known/oauth-protected-resource/api/v2', base).href,
  );
  if (
    metadata.resource !== base ||
    !Array.isArray(metadata.authorization_servers) ||
    metadata.authorization_servers.length !== 1
  )
    throw new SignInError(
      `DevTune doesn't offer browser sign-in at ${base}. Use agentpicks login --api-key.`,
    );
  const issuer = endpoint(
    metadata.authorization_servers[0],
    text(metadata.authorization_servers[0]),
  );
  const config = await json(
    issuer.replace(/\/$/, '') + '/.well-known/oauth-authorization-server',
  );
  if (
    config.issuer !== issuer ||
    !Array.isArray(config.code_challenge_methods_supported) ||
    !config.code_challenge_methods_supported.includes('S256') ||
    !Array.isArray(config.token_endpoint_auth_methods_supported) ||
    !config.token_endpoint_auth_methods_supported.includes('none')
  )
    throw new SignInError(
      'The authorization server must support public clients with PKCE S256.',
    );
  return {
    issuer,
    authorizationEndpoint: endpoint(config.authorization_endpoint, issuer),
    tokenEndpoint: endpoint(config.token_endpoint, issuer),
    registrationEndpoint: endpoint(config.registration_endpoint, issuer),
  };
}

function tokens(payload: Record<string, unknown>, oldRefresh?: string) {
  if (
    typeof payload.token_type !== 'string' ||
    payload.token_type.toLowerCase() !== 'bearer' ||
    typeof payload.expires_in !== 'number' ||
    !Number.isFinite(payload.expires_in) ||
    payload.expires_in <= 0
  )
    throw new SignInError(
      'DevTune sent an unexpected sign-in response. Run agentpicks login again.',
    );
  return {
    accessToken: text(payload.access_token),
    refreshToken: text(payload.refresh_token ?? oldRefresh),
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
}

function exchange(
  tokenEndpoint: string,
  params: Record<string, string>,
  refused?: (status: number) => string,
  rotates = false,
) {
  return json(
    tokenEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    },
    refused,
    rotates,
  );
}

type CallbackOutcome = { code: string; issuer?: string } | SignInError;

/**
 * Starts listening before the browser opens, and accepts only the matching single-use callback.
 * `received` settles with the first outcome: the code, a refusal, or the timeout. The outcome is
 * held until something awaits it, so a failure before then (discovery's, say) leaves no rejected
 * promise unhandled.
 */
export async function callback(state: string, timeoutMs = LOGIN_TIMEOUT_MS) {
  let outcome: CallbackOutcome | undefined;
  let deliver: ((value: CallbackOutcome) => void) | undefined;
  const settle = (value: CallbackOutcome) => {
    if (outcome) return;
    outcome = value;
    deliver?.(value);
  };
  let received: Promise<{ code: string; issuer?: string }> | undefined;
  const wait = () =>
    (received ??= new Promise((resolve, reject) => {
      const handle = (value: CallbackOutcome) =>
        value instanceof SignInError ? reject(value) : resolve(value);
      if (outcome) handle(outcome);
      else deliver = handle;
    }));
  let consumed = false;
  let expectedHost = '';
  let browserResponse: ServerResponse | undefined;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', loginPageCsp);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    // A request target URL can't parse, which any local process can send, is refused rather than thrown.
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      response.writeHead(400);
      response.end(loginPage('invalid'));
      return;
    }
    const supplied = url.searchParams.get('state') ?? '';
    const validState =
      Buffer.byteLength(supplied) === Buffer.byteLength(state) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(state));
    if (
      consumed ||
      request.method !== 'GET' ||
      request.headers.host !== expectedHost ||
      url.pathname !== '/oauth/callback' ||
      !validState ||
      url.searchParams.getAll('state').length !== 1 ||
      url.searchParams.getAll('code').length > 1 ||
      url.searchParams.getAll('error').length > 1 ||
      url.searchParams.getAll('iss').length > 1
    ) {
      response.writeHead(400);
      response.end(loginPage('invalid'));
      return;
    }
    consumed = true;
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      response.writeHead(400);
      response.end(loginPage('denied'));
      settle(
        new SignInError(
          'Sign-in was not approved. Run agentpicks login to try again.',
        ),
      );
      return;
    }
    // Confirm in the browser only after the exchange, the project check and the save.
    browserResponse = response;
    settle({
      code: url.searchParams.get('code')!,
      issuer: url.searchParams.get('iss') ?? undefined,
    });
  });
  const timer = setTimeout(
    () =>
      settle(new SignInError('Sign-in timed out. Run agentpicks login again.')),
    timeoutMs,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch {
    clearTimeout(timer);
    server.close();
    throw new SignInError(
      'Could not open the local sign-in callback. Try again.',
    );
  }
  const port = (server.address() as AddressInfo).port;
  expectedHost = `127.0.0.1:${port}`;
  return {
    url: `http://${expectedHost}/oauth/callback`,
    get received() {
      return wait();
    },
    complete: async (success: boolean) => {
      const response = browserResponse;
      if (!response || response.destroyed || response.writableEnded) return;
      response.statusCode = success ? 200 : 400;
      await new Promise<void>((resolve) => {
        response.once('close', resolve);
        response.end(loginPage(success ? 'success' : 'failed'), () => {
          response.removeListener('close', resolve);
          resolve();
        });
      });
    },
    close: () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Opens the address in the default browser; rejects when there is none to open. */
export async function openBrowser(url: string) {
  const [program, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program as string, args as string[], {
      stdio: 'ignore',
    });
    child.unref();
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('browser unavailable')),
    );
  });
}

export interface BrowserLoginOptions {
  /** The API root, as apiBaseUrl returns it. */
  baseUrl: string;
  /** Shows the authorize address, which works in any browser when none opens here. */
  notify: (url: string) => void;
  /** Opens the authorize address; null leaves it to the person to open. */
  openBrowser: ((url: string) => Promise<void>) | null;
  /** Called when openBrowser fails, so the person opens the address themselves. */
  browserUnavailable: () => void;
  /** Saves the session; the browser hears the sign-in worked only once this resolves. */
  save: (session: OAuthSession) => Promise<void>;
}

/**
 * Signs in through the browser and saves a session for the project chosen on DevTune's consent
 * page, with the scopes DevTune reports it holds, whichever the member's role allowed. Resolves to
 * that project and those scopes.
 */
export async function browserLogin(options: BrowserLoginOptions) {
  const { baseUrl } = options;
  const config = await discover(baseUrl);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const listener = await callback(state);
  try {
    const registration = await json(config.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Agent Picks CLI',
        redirect_uris: [listener.url],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    });
    const clientId = text(registration.client_id);
    const url = new URL(config.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: listener.url,
      scope: 'email offline_access',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: baseUrl,
    }).toString();
    options.notify(url.href);
    if (options.openBrowser)
      void options.openBrowser(url.href).catch(options.browserUnavailable);
    const authorization = await listener.received;
    if (authorization.issuer && authorization.issuer !== config.issuer)
      throw new SignInError('The OAuth issuer did not match discovery.');
    const token = tokens(
      await exchange(config.tokenEndpoint, {
        grant_type: 'authorization_code',
        client_id: clientId,
        code: authorization.code,
        code_verifier: verifier,
        redirect_uri: listener.url,
        resource: baseUrl,
      }),
    );
    const connection = await discoverProject({
      baseUrl,
      session: { accessToken: async () => token.accessToken },
    });
    if (connection.credential.type !== 'oauth')
      throw new SignInError(
        'DevTune did not return a signed-in project. Run agentpicks login again.',
      );
    await options.save({
      type: 'oauth',
      ...token,
      baseUrl,
      issuer: config.issuer,
      tokenEndpoint: config.tokenEndpoint,
      clientId,
      projectId: connection.project.id,
      scopes: connection.scopes,
    });
    await listener.complete(true);
    return { project: connection.project, scopes: connection.scopes };
  } catch (error) {
    await listener.complete(false);
    throw error;
  } finally {
    listener.close();
  }
}

/**
 * New tokens for a saved session, from its refresh token, which DevTune rotates. A refusal means
 * the session has expired or been revoked, and an answer lost after the request was sent means the
 * old refresh token may already be spent; both say to sign in again.
 */
export async function refreshSession(session: OAuthSession) {
  const payload = await exchange(
    session.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      client_id: session.clientId,
      refresh_token: session.refreshToken,
      resource: session.baseUrl,
    },
    () =>
      'Your DevTune sign-in has expired or was revoked. Run agentpicks login again.',
    true,
  );
  return tokens(payload, session.refreshToken);
}
