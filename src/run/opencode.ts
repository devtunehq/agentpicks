/**
 * ABOUTME: OpenCode's pinned headless launch and isolated configuration, for a model whose provider
 * the caller has already chosen. Which models a managed run may choose is decided by DevTune's prices,
 * outside this package.
 */
import { SANDBOX_ROOT, script } from '../assets/script';
import type { ModelProvider } from './agent-kind';

export const OPENCODE_VERSION = '1.19.0';
const OPENCODE_HOME = `${SANDBOX_ROOT}/opencode-home`;
const OPENCODE_TOKEN_ENV = 'AGENT_PICKS_MODEL_TOKEN';

/**
 * OpenCode's config for `model` on `provider`. A gateway model runs only through the model proxy,
 * over Chat Completions with usage on the stream's last chunk for the proxy to meter; its provider
 * block is added only for such a run, so every other run's config is unchanged.
 */
export function opencodeProviderConfig(
  provider: ModelProvider,
  model: string,
  access?: { baseUrl: string; token: string },
): string {
  // The gateway key stays with the proxy; no sandbox holds it.
  if (provider === 'gateway' && !access)
    throw new Error(`OpenCode runs ${model} only through the model proxy`);
  const keyEnv = access
    ? OPENCODE_TOKEN_ENV
    : provider === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : 'OPENAI_API_KEY';
  const options = (id: ModelProvider) => ({
    apiKey: `{env:${keyEnv}}`,
    ...(access ? { baseURL: `${access.baseUrl}/${id}/v1` } : {}),
  });
  return JSON.stringify({
    autoupdate: false,
    share: 'disabled',
    enabled_providers: [provider],
    model: `${provider}/${model}`,
    small_model: `${provider}/${model}`,
    provider: {
      anthropic: {
        npm: '@ai-sdk/anthropic',
        options: options('anthropic'),
      },
      openai: {
        npm: '@ai-sdk/openai',
        options: options('openai'),
      },
      ...(provider === 'gateway'
        ? {
            gateway: {
              npm: '@ai-sdk/openai-compatible',
              options: { ...options('gateway'), includeUsage: true },
            },
          }
        : {}),
    },
  });
}

/** The agent's environment: a fresh config and data home, and the config for `model` on `provider`. */
export function opencodeProviderEnv(
  provider: ModelProvider,
  model: string,
  access?: { baseUrl: string; token: string },
): Record<string, string> {
  return {
    XDG_CONFIG_HOME: `${OPENCODE_HOME}/config`,
    XDG_DATA_HOME: `${OPENCODE_HOME}/data`,
    XDG_CACHE_HOME: `${OPENCODE_HOME}/cache`,
    XDG_STATE_HOME: `${OPENCODE_HOME}/state`,
    OPENCODE_CONFIG_CONTENT: opencodeProviderConfig(provider, model, access),
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_MODELS_PATH: `${SANDBOX_ROOT}/opencode-models.json`,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    ...(access ? { [OPENCODE_TOKEN_ENV]: access.token } : {}),
  };
}

export const INSTALL_OPENCODE_SH = script`#!/usr/bin/env bash
# Install only the committed npm graph, including the platform binary's integrity.
set -euo pipefail
S=/opt/agent-picks
mkdir -p $S/opencode-tools
unpack $S/opencode-tools $S/opencode-tools.tsv
(cd $S/opencode-tools && npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1)
ln -sf $S/opencode-tools/node_modules/opencode-linux-x64-baseline/bin/opencode $S/opencode-tools/node_modules/opencode-ai/bin/opencode.exe
ln -sf $S/opencode-tools/node_modules/.bin/opencode $S/node/bin/opencode
# OpenCode initializes its config directory with @opencode-ai/plugin. Preseed that
# directory from the same frozen graph so its startup never resolves dependencies.
mkdir -p $S/opencode-home/config/opencode
cp $S/opencode-tools/package.json $S/opencode-tools/package-lock.json $S/opencode-home/config/opencode/
ln -sfn $S/opencode-tools/node_modules $S/opencode-home/config/opencode/node_modules
test "$(opencode --version)" = "1.19.0"
`;

const RUN_OPENCODE_SH = script`  setsid -w bash $S/agent-session.sh $S/agent.sid timeout "$TIMEOUT" opencode run --dir "$APP" --format json --auto --model "$MODEL" "$PROMPT" > $OUT/transcript.jsonl 2> $OUT/agent.err
  code=$?`;

/** Extends only OpenCode's setup. Its private tool graph stays out of the shared dependency report. */
export function opencodeSetupScript(base: string): string {
  return base.replace(
    't1=$(date +%s)',
    () => 'source $S/install-opencode.sh\nt1=$(date +%s)',
  );
}

/** Extends only OpenCode's launch; the common collector and stop session stay the same. */
export function opencodeRunScript(base: string): string {
  return base.replace(
    'else\n  printenv OPENAI_API_KEY',
    () =>
      `elif [ "$AGENT" = opencode ]; then\n${RUN_OPENCODE_SH}\nelse\n  printenv OPENAI_API_KEY`,
  );
}
