/**
 * ABOUTME: The browser sign-in, ported from @devtune/cli's auth tests: PKCE S256 on a loopback
 * redirect, a session saved only once DevTune confirms its project and the Agent Picks Run scope,
 * the browser told only after the save, refusals that leave nothing saved and print no provider
 * payload, the callback's checks, and the refresh's refusal. DevTune answers through a stubbed
 * `fetch`; the loopback callback is real.
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignInError } from './errors';
import { stubFetch, TARGET } from './fake-devtune';
import {
  CLIENT_ID,
  CONNECTION,
  consentBrowser,
  discovery,
  get,
  ISSUER,
  REGISTER,
  savedSession,
  signInReplies,
  TOKEN,
} from './fake-oauth';
import {
  browserLogin,
  callback,
  refreshSession,
  type OAuthSession,
} from './oauth';

afterEach(() => vi.unstubAllGlobals());

function signIn(
  browser: ReturnType<typeof consentBrowser>,
  save: (session: OAuthSession) => Promise<void> = async () => {},
) {
  const notified: string[] = [];
  const login = browserLogin({
    baseUrl: TARGET.baseUrl,
    notify: (url) => notified.push(url),
    openBrowser: browser.open,
    browserUnavailable: () => notified.push('no browser'),
    save,
  });
  return { login, notified };
}

describe('browserLogin', () => {
  it('proves PKCE S256 on a loopback redirect and saves the project DevTune confirms, then tells the browser', async () => {
    const calls = stubFetch(signInReplies());
    const browser = consentBrowser();
    const saved: OAuthSession[] = [];
    const { login, notified } = signIn(browser, async (session) => {
      saved.push(session);
    });
    expect(await login).toEqual({
      project: { id: TARGET.projectId, name: 'Acme' },
      scopes: [
        'agent_picks.run',
        'visibility.read',
        'actions.write',
        'project.read',
      ],
    });

    const { authorize, status, html } = await browser.visit;
    expect(notified).toEqual([authorize.href]);
    expect(authorize.origin + authorize.pathname).toBe(
      `${ISSUER}/oauth/authorize`,
    );
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: 'email offline_access',
      code_challenge_method: 'S256',
      resource: TARGET.baseUrl,
    });
    expect(new URL(params.redirect_uri!).hostname).toBe('127.0.0.1');

    const registration = JSON.parse(
      calls.find((c) => c.url === REGISTER)!.body!,
    );
    expect(registration).toMatchObject({
      redirect_uris: [params.redirect_uri],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    const exchange = new URLSearchParams(
      calls.find((c) => c.url === TOKEN)!.body!,
    );
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('single-use-code');
    expect(exchange.get('redirect_uri')).toBe(params.redirect_uri);
    expect(exchange.get('client_secret')).toBeNull();
    expect(
      createHash('sha256')
        .update(exchange.get('code_verifier')!)
        .digest('base64url'),
    ).toBe(params.code_challenge);
    expect(calls.find((c) => c.url === CONNECTION)!.headers.Authorization).toBe(
      'Bearer access-one',
    );

    expect(saved).toEqual([
      {
        type: 'oauth',
        baseUrl: TARGET.baseUrl,
        issuer: ISSUER,
        tokenEndpoint: TOKEN,
        clientId: CLIENT_ID,
        projectId: TARGET.projectId,
        accessToken: 'access-one',
        refreshToken: 'refresh-one',
        expiresAt: expect.any(Number),
        scopes: [
          'agent_picks.run',
          'visibility.read',
          'actions.write',
          'project.read',
        ],
      },
    ]);
    expect(status).toBe(200);
    expect(html).toContain("You're signed in");
    expect(html).not.toMatch(/single-use-code|access-one|refresh-one/);
  });

  it('answers the browser only once the session is saved', async () => {
    stubFetch(signInReplies());
    const browser = consentBrowser();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reachedSave!: () => void;
    const atSave = new Promise<void>((resolve) => (reachedSave = resolve));
    let answered = false;
    void browser.visit.then(() => (answered = true));
    const { login } = signIn(browser, async () => {
      reachedSave();
      await released;
    });
    await atSave;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    release();
    await login;
    expect((await browser.visit).status).toBe(200);
  });

  it('saves a sign-in holding only the scopes the member could grant', async () => {
    stubFetch(signInReplies(['project.read', 'visibility.read']));
    const browser = consentBrowser();
    const saved: OAuthSession[] = [];
    const { login } = signIn(browser, async (session) => {
      saved.push(session);
    });
    expect((await login).scopes).toEqual(['project.read', 'visibility.read']);
    expect(saved[0]!.scopes).toEqual(['project.read', 'visibility.read']);
    expect((await browser.visit).status).toBe(200);
  });

  it.each([
    ['token', `POST ${TOKEN}`],
    ['connection', `GET ${CONNECTION}`],
  ])(
    'shows the browser a failure after a %s failure, without provider data, saving nothing',
    async (_stage, key) => {
      stubFetch({
        ...signInReplies(),
        [key]: [{ status: 500, body: { error: 'private MUST NOT PRINT' } }],
      });
      const browser = consentBrowser();
      const save = vi.fn();
      const { login } = signIn(browser, save);
      const error = await login.then(
        () => null,
        (e: Error) => e,
      );
      expect(error?.message).not.toContain('MUST NOT PRINT');
      expect(save).not.toHaveBeenCalled();
      const { status, html } = await browser.visit;
      expect(status).toBe(400);
      expect(html).not.toMatch(
        /You're signed in|single-use-code|access-one|MUST NOT PRINT/,
      );
    },
  );

  it('shows the browser a failure when the save fails', async () => {
    stubFetch(signInReplies());
    const browser = consentBrowser();
    const { login } = signIn(browser, async () => {
      throw new Error('disk full');
    });
    await expect(login).rejects.toThrow('disk full');
    expect((await browser.visit).status).toBe(400);
  });

  it('never exchanges a code when consent is denied', async () => {
    const calls = stubFetch(signInReplies());
    const browser = consentBrowser({ deny: true });
    const save = vi.fn();
    const { login } = signIn(browser, save);
    await expect(login).rejects.toThrow(
      'Sign-in was not approved. Run agentpicks login to try again.',
    );
    expect(calls.map((c) => c.url)).not.toContain(TOKEN);
    expect(save).not.toHaveBeenCalled();
    expect((await browser.visit).html).toContain('Sign-in was not approved');
  });

  it('stops before registering when discovery names an endpoint off the issuer', async () => {
    const calls = stubFetch(
      discovery({ token_endpoint: 'https://unexpected.example/token' }),
    );
    const browser = consentBrowser();
    const { login } = signIn(browser);
    await expect(login).rejects.toThrow(
      'OAuth discovery returned an untrusted endpoint.',
    );
    expect(calls.map((c) => c.url)).not.toContain(REGISTER);
  });

  it('says to use --api-key where DevTune offers no browser sign-in', async () => {
    stubFetch({
      ...discovery(),
      [`GET https://devtune.test/.well-known/oauth-protected-resource/api/v2`]:
        [
          {
            status: 200,
            body: {
              resource: 'https://other.test/api/v2',
              authorization_servers: [],
            },
          },
        ],
    });
    await expect(signIn(consentBrowser()).login).rejects.toThrow(
      /Use agentpicks login --api-key\.$/,
    );
  });
});

describe('callback', () => {
  it('refuses a forged state, a second code, another path or host, and a POST, without consuming the sign-in', async () => {
    const listener = await callback('random-state');
    try {
      for (const [query, path, method, host] of [
        ['state=forged&code=x', '', 'GET', undefined],
        ['state=random-state&code=x&code=y', '', 'GET', undefined],
        ['state=random-state&code=x', '/other', 'GET', undefined],
        ['state=random-state&code=x', '', 'POST', undefined],
        ['state=random-state&code=x', '', 'GET', 'evil.example'],
      ] as const) {
        const url = new URL(listener.url);
        if (path) url.pathname = path;
        url.search = query;
        const answer = await get(url, { method, host });
        expect(answer.status).toBe(400);
        expect(answer.headers['cache-control']).toBe('no-store');
      }
      const pending = get(
        new URL(`${listener.url}?state=random-state&code=approved`),
      );
      expect(await listener.received).toEqual({
        code: 'approved',
        issuer: undefined,
      });
      await listener.complete(true);
      const answer = await pending;
      expect(answer.status).toBe(200);
      expect(answer.headers['referrer-policy']).toBe('no-referrer');
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
      expect(answer.html).not.toMatch(/random-state|approved|<script/);
      const css = answer.html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
      expect(answer.headers['content-security-policy']).toBe(
        `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      const replay = await get(
        new URL(`${listener.url}?state=random-state&code=approved`),
      );
      expect(replay.status).toBe(400);
    } finally {
      listener.close();
    }
  });

  it('refuses a request target that is not a URL, and still takes the sign-in', async () => {
    const listener = await callback('random-state');
    try {
      const answer = await get(new URL(listener.url), { path: '//[' });
      expect(answer.status).toBe(400);
      const pending = get(
        new URL(`${listener.url}?state=random-state&code=approved`),
      );
      expect(await listener.received).toEqual({
        code: 'approved',
        issuer: undefined,
      });
      await listener.complete(true);
      expect((await pending).status).toBe(200);
    } finally {
      listener.close();
    }
  });

  it('times out, saying to sign in again', async () => {
    const listener = await callback('state', 10);
    try {
      await expect(listener.received).rejects.toThrow(
        'Sign-in timed out. Run agentpicks login again.',
      );
    } finally {
      listener.close();
    }
  });
});

describe('refreshSession', () => {
  it('sends the refresh token for the session’s API root and keeps the old one when none is issued', async () => {
    const calls = stubFetch({
      [`POST ${TOKEN}`]: [
        {
          status: 200,
          body: {
            access_token: 'access-two',
            expires_in: 60,
            token_type: 'Bearer',
          },
        },
      ],
    });
    const renewed = await refreshSession(savedSession(0));
    expect(renewed).toMatchObject({
      accessToken: 'access-two',
      refreshToken: 'refresh-one',
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body!))).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: 'refresh-one',
      resource: TARGET.baseUrl,
    });
  });

  it.each([400, 401, 403])(
    'says the sign-in expired or was revoked when DevTune refuses it (%i), without its payload',
    async (status) => {
      stubFetch({
        [`POST ${TOKEN}`]: [
          { status, body: { error_description: 'refresh-one MUST NOT PRINT' } },
        ],
      });
      await expect(refreshSession(savedSession(0))).rejects.toThrow(
        new SignInError(
          'Your DevTune sign-in has expired or was revoked. Run agentpicks login again.',
        ),
      );
    },
  );

  it.each([503, 408, 425, 429])(
    'says to try again, not to sign in again, when DevTune fails or defers (%i)',
    async (status) => {
      stubFetch({ [`POST ${TOKEN}`]: [{ status, body: {} }] });
      await expect(refreshSession(savedSession(0))).rejects.toThrow(
        new SignInError(
          `A sign-in request to DevTune failed (${status}). Try again later.`,
          { transient: true },
        ),
      );
    },
  );

  it.each([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'ERR_SSL_WRONG_VERSION_NUMBER',
  ])(
    'says to try again when the renewal never reached DevTune (%s)',
    async (code) => {
      stubFetch({
        [`POST ${TOKEN}`]: [new TypeError('fetch failed', { cause: { code } })],
      });
      const error = await refreshSession(savedSession(0)).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ transient: true });
    },
  );

  const UNKNOWN = new SignInError(
    "DevTune's answer to renewing the sign-in didn't arrive, so whether it was renewed is unknown. Run agentpicks login.",
  );

  it.each([
    ['times out', new DOMException('timed out', 'TimeoutError')],
    [
      'is reset after it was sent',
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
    ],
  ])(
    'says the outcome is unknown, to sign in again, when the renewal %s',
    async (_case, failure) => {
      stubFetch({ [`POST ${TOKEN}`]: [failure] });
      const error = await refreshSession(savedSession(0)).catch(
        (e: unknown) => e,
      );
      expect(error).toEqual(UNKNOWN);
      expect(error).toMatchObject({ transient: false });
    },
  );

  it.each([502, 504])(
    'says the outcome is unknown when a gateway answers the renewal (%i)',
    async (status) => {
      stubFetch({ [`POST ${TOKEN}`]: [{ status, body: {} }] });
      const error = await refreshSession(savedSession(0)).catch(
        (e: unknown) => e,
      );
      expect(error).toEqual(UNKNOWN);
      expect(error).toMatchObject({ transient: false });
    },
  );

  it('says the outcome is unknown when the renewal’s answer is cut off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"access_'));
                controller.error(new Error('socket hang up'));
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const error = await refreshSession(savedSession(0)).catch(
      (e: unknown) => e,
    );
    expect(error).toEqual(UNKNOWN);
    expect(error).toMatchObject({ transient: false });
  });
});
