/**
 * ABOUTME: How a self-run's agent reaches its model with the customer's own credentials
 * (spec 46 §3.2). API keys and tokens pass from the host environment to the agent's command for
 * that run only. A sign-in kept in a file (Claude Code's on Linux, Codex's `auth.json`) is copied
 * into the container without its refresh token, so the container can never renew, and so rotate,
 * the sign-in this machine holds; it is deleted with the container. A sign-in kept in the macOS
 * Keychain or a system keyring is never read: the run is refused, naming how to supply a token.
 */
import { join } from 'node:path';

import { SANDBOX_LIFETIME_MIN } from '../run/limits';
import { createTraceRedactor } from '../run/trace-redaction';
import type { AgentPlan } from './agent-plan';
import { claudeConfigDir, codexHome, topLevelTomlString } from './discover';
import {
  AgentEndpointError,
  KeychainLoginError,
  LoginExpiringError,
  MissingCredentialsError,
} from './errors';
import { readJsonObject, stringField, type HostIo } from './host';

/** A sign-in file written into the container before the agent starts. */
export interface CredentialFile {
  /** Where it was read on this machine. */
  source: string;
  /** Where it is written in the container. */
  path: string;
  content: string;
}

export interface AgentCredentials {
  /** Passed to the agent's command only, by name; values never appear in a process listing. */
  env: Record<string, string>;
  files: CredentialFile[];
  /** Model endpoints carried from host configuration, checked from inside each sandbox. */
  endpoints: { name: string; url: string; source: string }[];
  /** Every credential value, for redaction. */
  secrets: string[];
  /** What is passed and copied, printed before the first run. */
  summary: string[];
}

/** A sign-in must outlast a whole run: the sandbox's lifetime. */
const RUN_WINDOW_MS = SANDBOX_LIFETIME_MIN * 60_000;

/** Claude Code's variables, in the order it prefers them. */
const CLAUDE_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

const CODEX_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

export function resolveCredentials(
  plan: AgentPlan,
  io: HostIo,
): AgentCredentials {
  const { agent } = plan;
  if (agent.kind === 'claude_code') return claudeCredentials(io);
  if (agent.kind === 'codex') return codexCredentials(io);
  const key =
    plan.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const value = io.env[key];
  if (!value)
    throw new MissingCredentialsError(
      `${agent.name} runs here use ${key} from your environment, which isn't set. Set it and try again.`,
    );
  return {
    env: { [key]: value },
    files: [],
    endpoints: [],
    secrets: [value],
    summary: [passes([key], 'your environment', agent.name)],
  };
}

function claudeCredentials(io: HostIo): AgentCredentials {
  const settingsPath = join(claudeConfigDir(io), 'settings.json');
  const settings = readJsonObject(io, settingsPath);
  const settingsEnv =
    settings?.env && typeof settings.env === 'object'
      ? (settings.env as Record<string, unknown>)
      : null;
  // Claude Code applies its settings' `env` to itself, so a key there is how this machine signs in.
  const read = (key: string) =>
    io.env[key]
      ? { key, value: io.env[key]!, source: 'your environment' }
      : stringField(settingsEnv, key)
        ? { key, value: stringField(settingsEnv, key)!, source: settingsPath }
        : null;
  const keys = CLAUDE_KEYS.map(read).filter((k) => k !== null);
  if (keys.length > 0) {
    const baseUrl = read('ANTHROPIC_BASE_URL');
    if (baseUrl) assertSandboxEndpoint(baseUrl);
    const passed = baseUrl ? [...keys, baseUrl] : keys;
    return {
      env: Object.fromEntries(passed.map((k) => [k.key, k.value])),
      files: [],
      endpoints: baseUrl
        ? [{ name: baseUrl.key, url: baseUrl.value, source: baseUrl.source }]
        : [],
      secrets: keys.map((k) => k.value),
      summary: [...new Set(passed.map((k) => k.source))].map((source) =>
        passes(
          passed.filter((k) => k.source === source).map((k) => k.key),
          source,
          'Claude Code',
        ),
      ),
    };
  }

  const path = join(claudeConfigDir(io), '.credentials.json');
  const oauth = readJsonObject(io, path)?.claudeAiOauth;
  const login =
    oauth && typeof oauth === 'object'
      ? (oauth as Record<string, unknown>)
      : null;
  const accessToken = stringField(login, 'accessToken');
  if (login && accessToken) {
    const expiresAt =
      typeof login.expiresAt === 'number' && login.expiresAt > 0
        ? login.expiresAt
        : null;
    if (expiresAt !== null && expiresAt < io.now() + RUN_WINDOW_MS)
      throw new LoginExpiringError(
        `Claude Code's sign-in on this machine ${expiresIn(expiresAt, io)}, before a run could finish. Run \`claude\` here so it renews, then try again, or set CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\`.`,
      );
    const copy = Object.fromEntries(
      Object.entries(login).filter(([key]) => key !== 'refreshToken'),
    );
    return {
      env: {},
      files: [
        {
          source: path,
          path: '/root/.claude/.credentials.json',
          content: JSON.stringify({ claudeAiOauth: copy }),
        },
      ],
      endpoints: [],
      secrets: [accessToken],
      summary: [copies('Claude Code', path, '/root/.claude/.credentials.json')],
    };
  }

  if (io.platform === 'darwin')
    throw new KeychainLoginError(
      "Claude Code on macOS keeps its sign-in in the Keychain, which agentpicks doesn't read. Run `claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN to the token it prints, and try again. An ANTHROPIC_API_KEY works too.",
    );
  throw new MissingCredentialsError(
    'Claude Code has no sign-in on this machine. Run `claude` and log in, or set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`).',
  );
}

function codexCredentials(io: HostIo): AgentCredentials {
  const home = codexHome(io);
  const configPath = join(home, 'config.toml');
  const config = io.readFile(configPath);
  const provider = topLevelTomlString(config, 'model_provider');
  const ignored = [
    ...(io.env.OPENAI_BASE_URL ? ['OPENAI_BASE_URL in your environment'] : []),
    ...(provider && provider !== 'openai'
      ? [`model_provider = "${provider}" in ${configPath}`]
      : []),
  ];
  const endpointSummary = ignored.length
    ? [
        `Codex talks to OpenAI directly for this run; it doesn't use the endpoint configured by ${ignored.join(' and ')}.`,
      ]
    : [];
  const keys = CODEX_KEYS.filter((key) => io.env[key]);
  if (keys.length > 0)
    return {
      env: Object.fromEntries(keys.map((key) => [key, io.env[key]!])),
      files: [],
      endpoints: [],
      secrets: keys.map((key) => io.env[key]!),
      summary: [passes(keys, 'your environment', 'Codex'), ...endpointSummary],
    };

  const store = topLevelTomlString(config, 'cli_auth_credentials_store');
  const keyring = new KeychainLoginError(
    `Codex keeps its sign-in in the system keyring (cli_auth_credentials_store = "${store}" in ${configPath}), which agentpicks doesn't read. Set OPENAI_API_KEY, or set cli_auth_credentials_store = "file", run \`codex login\` and try again.`,
  );
  if (store === 'keyring') throw keyring;

  const path = join(home, 'auth.json');
  const auth = readJsonObject(io, path);
  const tokens =
    auth?.tokens && typeof auth.tokens === 'object'
      ? (auth.tokens as Record<string, unknown>)
      : null;
  const accessToken = stringField(tokens, 'access_token');
  const apiKey = stringField(auth, 'OPENAI_API_KEY');
  if (auth && (accessToken || apiKey)) {
    const expiresAt = accessToken ? jwtExpiry(accessToken) : null;
    if (expiresAt !== null && expiresAt < io.now() + RUN_WINDOW_MS)
      throw new LoginExpiringError(
        `Codex's sign-in on this machine ${expiresIn(expiresAt, io)}, before a run could finish. Run \`codex\` here so it renews, then try again, or set OPENAI_API_KEY.`,
      );
    // Without its refresh token, Codex in the container can't renew the sign-in; marking it
    // renewed now stops Codex trying, so the access token alone carries the run.
    const copy = tokens
      ? {
          ...auth,
          tokens: { ...tokens, refresh_token: '' },
          last_refresh: new Date(io.now()).toISOString(),
        }
      : auth;
    return {
      env: {},
      files: [
        {
          source: path,
          path: '/root/.codex/auth.json',
          content: JSON.stringify(copy),
        },
      ],
      endpoints: [],
      secrets: [
        accessToken,
        stringField(tokens, 'id_token'),
        stringField(tokens, 'refresh_token'),
        apiKey,
      ].filter((v): v is string => Boolean(v)),
      summary: [
        copies('Codex', path, '/root/.codex/auth.json'),
        ...endpointSummary,
      ],
    };
  }
  if (store === 'auto') throw keyring;
  throw new MissingCredentialsError(
    'Codex has no sign-in on this machine. Run `codex login`, or set OPENAI_API_KEY.',
  );
}

/** Reject addresses that would point back into the sandbox before building its image. */
function assertSandboxEndpoint(endpoint: {
  key: string;
  value: string;
  source: string;
}) {
  const { key, value, source } = endpoint;
  const display = createTraceRedactor({}, { names: false })(value);
  const invalidUrl = new AgentEndpointError(
    `${key} in ${source} is ${display}, which isn't an http: or https: URL. Set it to an address the sandbox can reach and try again.`,
  );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalidUrl;
  const host = url.hostname.replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '[::]' ||
    /^\[::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(host)
  )
    throw new AgentEndpointError(
      `${key} in ${source} is ${display}, which inside the sandbox is the sandbox itself. Set it to an address the sandbox can reach, such as the model server's LAN IP, and try again.`,
    );
}

/** The `exp` of a JWT, in milliseconds; null when the token is not a JWT with one. */
export function jwtExpiry(token: string): number | null {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    const exp =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).exp
        : undefined;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function expiresIn(at: number, io: Pick<HostIo, 'now'>): string {
  const minutes = Math.round((at - io.now()) / 60_000);
  return minutes <= 0 ? 'has expired' : `expires in ${minutes} min`;
}

function passes(keys: readonly string[], source: string, agent: string) {
  return `Passes ${keys.join(', ')} from ${source} to ${agent}, for each run only.`;
}

function copies(agent: string, source: string, target: string) {
  return `Copies ${agent}'s sign-in from ${source} into each run's container as ${target}, without its refresh token. It is deleted with the container.`;
}
