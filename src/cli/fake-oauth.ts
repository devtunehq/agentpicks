/**
 * ABOUTME: DevTune's browser sign-in for CLI tests: the discovery, registration, token and
 * connection answers `agentpicks login` reads through a stubbed `fetch`, a saved session, and a
 * browser that approves (or denies) on the consent page by requesting the loopback callback for real.
 */
import { request } from 'node:http';

import { TARGET } from './fake-devtune';
import type { OAuthSession } from './oauth';

export const ISSUER = 'https://devtune.test/auth/v1';
export const AUTHORIZE = 'https://devtune.test/auth/v1/oauth/authorize';
export const TOKEN = 'https://devtune.test/auth/v1/oauth/token';
export const REGISTER = 'https://devtune.test/auth/v1/oauth/clients/register';
export const CONNECTION = `${TARGET.baseUrl}/connection`;
export const CLIENT_ID = 'agentpicks-public-client';

type Reply = { status: number; body: unknown };

/** Discovery's two answers: the API's protected resource and its authorization server. */
export function discovery(
  overrides: Record<string, unknown> = {},
): Record<string, Reply[]> {
  return {
    [`GET https://devtune.test/.well-known/oauth-protected-resource/api/v2`]: [
      {
        status: 200,
        body: { resource: TARGET.baseUrl, authorization_servers: [ISSUER] },
      },
    ],
    [`GET ${ISSUER}/.well-known/oauth-authorization-server`]: [
      {
        status: 200,
        body: {
          issuer: ISSUER,
          authorization_endpoint: AUTHORIZE,
          token_endpoint: TOKEN,
          registration_endpoint: REGISTER,
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          ...overrides,
        },
      },
    ],
  };
}

/** A token endpoint answer. */
export function issued(access: string, refresh: string, expiresIn = 3600) {
  return {
    status: 200,
    body: {
      access_token: access,
      refresh_token: refresh,
      expires_in: expiresIn,
      token_type: 'bearer',
    },
  };
}

/** GET /connection's answer for a signed-in project. */
export function connection(
  scopes = [
    'agent_picks.run',
    'visibility.read',
    'actions.write',
    'project.read',
  ],
  type = 'oauth',
) {
  return {
    status: 200,
    body: {
      data: {
        project: {
          id: TARGET.projectId,
          name: 'Acme',
          paused: false,
          domains: [],
        },
        credential: { type },
        scopes,
        features: {},
        checkedAt: '2026-11-11T12:00:00Z',
      },
    },
  };
}

/** Every answer a browser sign-in that succeeds reads, in order. */
export function signInReplies(scopes?: string[]): Record<string, Reply[]> {
  return {
    ...discovery(),
    [`POST ${REGISTER}`]: [{ status: 201, body: { client_id: CLIENT_ID } }],
    [`POST ${TOKEN}`]: [issued('access-one', 'refresh-one')],
    [`GET ${CONNECTION}`]: [connection(scopes)],
  };
}

/** A saved sign-in for TARGET's project, expiring `expiresAt`. */
export function savedSession(expiresAt: number): OAuthSession {
  return {
    type: 'oauth',
    baseUrl: TARGET.baseUrl,
    issuer: ISSUER,
    tokenEndpoint: TOKEN,
    clientId: CLIENT_ID,
    projectId: TARGET.projectId,
    accessToken: 'access-one',
    refreshToken: 'refresh-one',
    expiresAt,
    scopes: ['agent_picks.run', 'visibility.read', 'actions.write'],
  };
}

export interface BrowserVisit {
  authorize: URL;
  status: number;
  html: string;
}

/**
 * A browser on the consent page: given the authorize address, it requests the redirect DevTune
 * sends back, with the authorize address's state and a code (or `error=access_denied`), over real
 * HTTP, since `fetch` is stubbed. `visit` resolves to what the callback page answered.
 */
export function consentBrowser(options: { deny?: boolean } = {}) {
  let resolveVisit!: (visit: BrowserVisit) => void;
  const visit = new Promise<BrowserVisit>((resolve) => {
    resolveVisit = resolve;
  });
  const open = async (address: string) => {
    const authorize = new URL(address);
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('state', authorize.searchParams.get('state')!);
    if (options.deny) redirect.searchParams.set('error', 'access_denied');
    else redirect.searchParams.set('code', 'single-use-code');
    const answer = await get(redirect);
    resolveVisit({ authorize, ...answer });
  };
  return { open, visit };
}

/** One GET over node:http, which a stubbed `fetch` doesn't reach. `path` sends a raw request target. */
export function get(
  url: URL,
  options: { method?: string; host?: string; path?: string } = {},
): Promise<{ status: number; html: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.host ? { host: options.host } : {},
        ...(options.path ? { path: options.path } : {}),
      },
      (res) => {
        let html = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (html += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, html, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
