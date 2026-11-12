/**
 * ABOUTME: Pi's pinned install, one-shot CLI and isolated model configuration. Pi reads one
 * provider, `agent-picks`, with the one model a run names: Anthropic Messages, OpenAI Responses
 * or Vercel AI Gateway Chat Completions, keyed by an environment variable the config names.
 * Also judges from Pi's transcript whether a run that exited zero finished.
 */
import { SANDBOX_ROOT, script } from '../assets/script';
import type { Sandbox } from '../sandbox/provider';
import type { ModelProvider } from './agent-kind';

export const PI_HOME = `${SANDBOX_ROOT}/pi-home`;
/** Conservative context limit until shared model metadata is available. */
export const PI_CONTEXT_WINDOW = 200_000;
export const PI_SETTINGS_JSON = JSON.stringify({ cacheWarming: 'off' });

export const PI_TOOLS_RECIPE = {
  generateScript: script`mkdir -p app && cd app
cat > package.json <<'JSON'
{
  "name": "agent-picks-pi-tools",
  "private": true,
  "dependencies": {
    "@earendil-works/pi-coding-agent": "1.2.0"
  }
}
JSON
npm install --package-lock-only --no-audit --no-fund >/dev/null
cd ..`,
};

/**
 * How Pi calls a gateway model over Chat Completions: no `store` or developer role, which
 * the gateway's models do not take, `max_tokens` as the output limit, usage on the stream's
 * last chunk for the proxy to meter, and no reasoning field, so each model reasons at its
 * own default.
 */
const PI_GATEWAY_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_tokens',
};

export const PI_SETUP_SH = script`#!/usr/bin/env bash
set -euo pipefail
S=/opt/agent-picks
# The unpack function comes from setup.sh, which sources this script.
mkdir -p $S/pi-tools
unpack $S/pi-tools $S/pi-tools.tsv
(cd $S/pi-tools && npm ci --no-audit --no-fund >/dev/null 2>&1)
ln -sf $S/pi-tools/node_modules/.bin/pi $S/node/bin/pi
`;

/** run-agent.sh owns the session, timeout and artifact collection around this command. */
export const PI_RUN_SH = script`#!/usr/bin/env bash
set -euo pipefail
MODEL="$\{1:?model}"; PROMPT_FILE="$\{2:?prompt file}"
export PI_CODING_AGENT_DIR=/opt/agent-picks/pi-home
export NODE_USE_ENV_PROXY=1
exec pi --print --mode json --no-session --offline --no-extensions --no-skills \
  --no-prompt-templates --approve --provider agent-picks --model "$MODEL" -- "$(cat "$PROMPT_FILE")" < /dev/null
`;

/** The provider's own API base URL, for a run that holds its key. */
export function piDirectBaseUrl(provider: 'anthropic' | 'openai'): string {
  return provider === 'anthropic'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1';
}

/** What Pi's config says about the one model a run names. */
export interface PiModelSpec {
  provider: ModelProvider;
  model: string;
  baseUrl: string;
  /** The environment variable holding the credential; the config names it, never its value. */
  apiKeyEnv: string;
  /** Send the credential as `Authorization: Bearer`, as the model proxy expects. */
  authHeader: boolean;
  /** Whether the model reasons; `adaptive` forces adaptive thinking. */
  reasoning: boolean | 'adaptive';
  /** Dollars per million tokens, which Pi reports its own spend with. */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/** Pi's models.json for one model. Config references a credential environment variable, never embeds its value. */
export function piProviderConfig(spec: PiModelSpec): string {
  const { provider, model } = spec;
  return JSON.stringify({
    providers: {
      'agent-picks': {
        baseUrl: spec.baseUrl,
        api:
          provider === 'anthropic'
            ? 'anthropic-messages'
            : provider === 'openai'
              ? 'openai-responses'
              : 'openai-completions',
        apiKey: `\${${spec.apiKeyEnv}}`,
        authHeader: spec.authHeader,
        models: [
          {
            id: model,
            name: model,
            reasoning: spec.reasoning !== false,
            ...(spec.reasoning === 'adaptive'
              ? { compat: { forceAdaptiveThinking: true } }
              : provider === 'gateway'
                ? { compat: PI_GATEWAY_COMPAT }
                : {}),
            input: provider === 'gateway' ? ['text'] : ['text', 'image'],
            contextWindow: PI_CONTEXT_WINDOW,
            maxTokens: 32_768,
            cost: spec.cost,
          },
        ],
      },
    },
  });
}

/** Writes Pi's model config and settings into a fresh per-run home, before the agent starts. */
export async function writePiConfig(box: Sandbox, modelsJson: string) {
  await box.exec(`mkdir -p ${PI_HOME}`);
  await box.writeFile(`${PI_HOME}/models.json`, modelsJson);
  await box.writeFile(`${PI_HOME}/settings.json`, PI_SETTINGS_JSON);
}

/** Extends only Pi's setup. Its separate tool graph stays out of the shared dependency report. */
export function piSetupScript(base: string): string {
  return base.replace(
    't1=$(date +%s)',
    () => '. $S/pi-setup.sh\nt1=$(date +%s)',
  );
}

/** Extends only Pi's launch, retaining the common timeout, session and collector. */
export function piRunScript(base: string): string {
  return base.replace(
    'else\n  printenv OPENAI_API_KEY',
    () => `elif [ "$AGENT" = pi ]; then
  setsid -w bash $S/agent-session.sh $S/agent.sid timeout "$TIMEOUT" bash $S/run-pi.sh "$MODEL" "$PROMPT_FILE" > $OUT/transcript.jsonl 2> $OUT/agent.err
  code=$?
else
  printenv OPENAI_API_KEY`,
  );
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Each line that parses as a JSON object; a line cut off when the agent was stopped is skipped. */
function parseJsonLines(text: string): JsonObject[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return isObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** Pi's JSON mode can exit zero on provider errors and output-token truncation. */
export function piTranscriptError(text: string): string | null {
  const events = parseJsonLines(text);
  const settledIndex = events.findLastIndex((e) => e.type === 'agent_settled');
  const settled = events[settledIndex];
  const pendingIndex = events.findLastIndex(
    (e) => e.type === 'agent_start' || e.type === 'message_end',
  );
  const message = obj(
    events.findLast(
      (e) => e.type === 'message_end' && obj(e.message).role === 'assistant',
    )?.message,
  );
  if (!settled || settledIndex < pendingIndex || !str(message.stopReason))
    return 'Pi transcript did not settle';
  if (settled.aborted === true) return 'Pi stopped: aborted';
  if (['error', 'aborted', 'length'].includes(String(message.stopReason)))
    return `Pi stopped: ${String(message.stopReason)}${str(message.errorMessage) ? `: ${str(message.errorMessage)}` : ''}`;
  return message.stopReason === 'stop'
    ? null
    : `Pi stopped: ${String(message.stopReason)}`;
}
