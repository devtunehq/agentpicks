/**
 * ABOUTME: Covers how a self-run's agent gets its credentials: environment keys pass through,
 * file sign-ins are copied without their refresh tokens, and Keychain-only, missing and
 * expiring sign-ins are refused by name.
 */
import { describe, expect, it } from 'vitest';

import type { AgentPlan } from './agent-plan';
import { jwtExpiry, resolveCredentials } from './credentials';
import type { HostAgent } from './discover';
import {
  KeychainLoginError,
  LoginExpiringError,
  MissingCredentialsError,
} from './errors';
import { FAKE_HOME, FAKE_NOW, fakeHost } from './fake-host';

function plan(
  kind: HostAgent['kind'],
  provider: AgentPlan['provider'] = null,
): AgentPlan {
  const agent: HostAgent = {
    kind,
    name: {
      claude_code: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode',
      pi: 'Pi',
    }[kind],
    path: `/usr/local/bin/${kind}`,
    version: '1.0.0',
    model: 'default',
    modelSource: "the agent's default",
  };
  return { agent, model: 'm', provider, modelArg: 'm' };
}

const CLAUDE_CREDENTIALS = `${FAKE_HOME}/.claude/.credentials.json`;
const CODEX_AUTH = `${FAKE_HOME}/.codex/auth.json`;
const HOUR = 3_600_000;

function jwt(expMs: number) {
  const part = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ exp: expMs / 1000 })}.sig`;
}

describe('Claude Code credentials', () => {
  it('passes keys from the environment, and from settings.json, for the run only', () => {
    const io = fakeHost({
      env: { ANTHROPIC_API_KEY: 'sk-ant-env-0000000000' },
      files: {
        [`${FAKE_HOME}/.claude/settings.json`]: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'token-from-settings-000',
            ANTHROPIC_BASE_URL: 'http://gateway.internal:8317',
          },
        }),
      },
    });
    const credentials = resolveCredentials(plan('claude_code'), io);
    expect(credentials.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'token-from-settings-000',
      ANTHROPIC_API_KEY: 'sk-ant-env-0000000000',
      ANTHROPIC_BASE_URL: 'http://gateway.internal:8317',
    });
    expect(credentials.files).toEqual([]);
    expect(credentials.secrets).toEqual([
      'token-from-settings-000',
      'sk-ant-env-0000000000',
    ]);
    expect(credentials.summary).toEqual([
      `Passes ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL from ${FAKE_HOME}/.claude/settings.json to Claude Code, for each run only.`,
      'Passes ANTHROPIC_API_KEY from your environment to Claude Code, for each run only.',
    ]);
  });

  it('copies the Linux credentials file without its refresh token', () => {
    const io = fakeHost({
      files: {
        [CLAUDE_CREDENTIALS]: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-access',
            refreshToken: 'sk-ant-ort01-refresh',
            expiresAt: FAKE_NOW + 8 * HOUR,
            scopes: ['user:inference'],
          },
          mcpOAuth: { server: { accessToken: 'unrelated' } },
        }),
      },
    });
    const credentials = resolveCredentials(plan('claude_code'), io);
    expect(credentials.env).toEqual({});
    expect(credentials.files).toEqual([
      {
        source: CLAUDE_CREDENTIALS,
        path: '/root/.claude/.credentials.json',
        content: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-access',
            expiresAt: FAKE_NOW + 8 * HOUR,
            scopes: ['user:inference'],
          },
        }),
      },
    ]);
    expect(credentials.secrets).toEqual(['sk-ant-oat01-access']);
    expect(credentials.summary[0]).toContain('without its refresh token');
    expect(credentials.summary[0]).toContain('deleted with the container');
  });

  it('refuses a sign-in that expires before a run could finish', () => {
    const io = fakeHost({
      files: {
        [CLAUDE_CREDENTIALS]: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-access',
            expiresAt: FAKE_NOW + 10 * 60_000,
          },
        }),
      },
    });
    expect(() => resolveCredentials(plan('claude_code'), io)).toThrow(
      new LoginExpiringError(
        "Claude Code's sign-in on this machine expires in 10 min, before a run could finish. Run `claude` here so it renews, then try again, or set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.",
      ),
    );
  });

  it('refuses a Keychain-only sign-in on macOS, naming claude setup-token', () => {
    const io = fakeHost({ platform: 'darwin' });
    expect(() => resolveCredentials(plan('claude_code'), io)).toThrow(
      KeychainLoginError,
    );
    expect(() => resolveCredentials(plan('claude_code'), io)).toThrow(
      /Keychain, which agentpicks doesn't read. Run `claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  it('uses a setup token on macOS without reading anything else', () => {
    const io = fakeHost({
      platform: 'darwin',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-setup-token' },
    });
    expect(resolveCredentials(plan('claude_code'), io).env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-setup-token',
    });
  });

  it('refuses when Linux has no sign-in, and treats an empty access token as none', () => {
    const io = fakeHost({
      files: {
        [CLAUDE_CREDENTIALS]: JSON.stringify({
          claudeAiOauth: { accessToken: '', expiresAt: 0 },
        }),
      },
    });
    expect(() => resolveCredentials(plan('claude_code'), io)).toThrow(
      MissingCredentialsError,
    );
  });
});

describe('Codex credentials', () => {
  it('passes an API key from the environment', () => {
    const io = fakeHost({ env: { OPENAI_API_KEY: 'sk-proj-0000000000' } });
    expect(resolveCredentials(plan('codex'), io).env).toEqual({
      OPENAI_API_KEY: 'sk-proj-0000000000',
    });
  });

  it('copies auth.json with the refresh token blanked and marked renewed, so the container never renews it', () => {
    const access = jwt(FAKE_NOW + 24 * HOUR);
    const io = fakeHost({
      files: {
        [CODEX_AUTH]: JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: 'id-token-0000000000',
            access_token: access,
            refresh_token: 'refresh-token-0000000000',
            account_id: 'acct',
          },
          last_refresh: '2026-11-02T19:23:22Z',
        }),
      },
    });
    const credentials = resolveCredentials(plan('codex'), io);
    expect(credentials.files).toHaveLength(1);
    expect(credentials.files[0]!.path).toBe('/root/.codex/auth.json');
    expect(JSON.parse(credentials.files[0]!.content)).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id-token-0000000000',
        access_token: access,
        refresh_token: '',
        account_id: 'acct',
      },
      last_refresh: new Date(FAKE_NOW).toISOString(),
    });
    expect(credentials.secrets).toEqual([
      access,
      'id-token-0000000000',
      'refresh-token-0000000000',
    ]);
  });

  it('refuses an access token that expires before a run could finish', () => {
    const io = fakeHost({
      files: {
        [CODEX_AUTH]: JSON.stringify({
          tokens: { access_token: jwt(FAKE_NOW + 5 * 60_000) },
        }),
      },
    });
    expect(() => resolveCredentials(plan('codex'), io)).toThrow(
      LoginExpiringError,
    );
  });

  it('refuses a sign-in kept in the system keyring', () => {
    const io = fakeHost({
      files: {
        [`${FAKE_HOME}/.codex/config.toml`]:
          'cli_auth_credentials_store = "keyring"\n',
      },
    });
    expect(() => resolveCredentials(plan('codex'), io)).toThrow(
      KeychainLoginError,
    );
    const auto = fakeHost({
      files: {
        [`${FAKE_HOME}/.codex/config.toml`]:
          'cli_auth_credentials_store = "auto"\n',
      },
    });
    expect(() => resolveCredentials(plan('codex'), auto)).toThrow(
      /system keyring \(cli_auth_credentials_store = "auto"/,
    );
  });

  it('refuses when there is no sign-in', () => {
    expect(() => resolveCredentials(plan('codex'), fakeHost())).toThrow(
      MissingCredentialsError,
    );
  });
});

describe('OpenCode and Pi credentials', () => {
  it("pass the provider's key from the environment and refuse without it", () => {
    const io = fakeHost({ env: { OPENAI_API_KEY: 'sk-proj-0000000000' } });
    expect(resolveCredentials(plan('pi', 'openai'), io).env).toEqual({
      OPENAI_API_KEY: 'sk-proj-0000000000',
    });
    expect(() => resolveCredentials(plan('opencode', 'anthropic'), io)).toThrow(
      new MissingCredentialsError(
        "OpenCode runs here use ANTHROPIC_API_KEY from your environment, which isn't set. Set it and try again.",
      ),
    );
  });
});

describe('jwtExpiry', () => {
  it('reads exp in milliseconds, and null for anything else', () => {
    expect(jwtExpiry(jwt(FAKE_NOW))).toBe(FAKE_NOW);
    expect(jwtExpiry('not-a-jwt')).toBeNull();
  });
});
