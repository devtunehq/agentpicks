/**
 * ABOUTME: Turns the chosen agent and model into what a run launches: the model id the job
 * carries, the provider an OpenCode or Pi run calls, and the model argument run-agent.sh takes.
 * OpenCode and Pi need a provider and a named model.
 */
import type { HostAgent } from './discover';
import { AgentModelError } from './errors';

export interface AgentPlan {
  agent: HostAgent;
  /** The model the job records: the agent's id for it, or `default`. */
  model: string;
  /** The API an OpenCode or Pi run calls, which decides the key it needs. */
  provider: 'anthropic' | 'openai' | null;
  /** The model as run-agent.sh passes it to the agent's CLI. */
  modelArg: string;
}

const PROVIDERS = ['anthropic', 'openai'] as const;

export function planAgent(agent: HostAgent): AgentPlan {
  if (agent.kind === 'claude_code' || agent.kind === 'codex')
    return { agent, model: agent.model, provider: null, modelArg: agent.model };
  const [provider, model] = splitModel(agent);
  return {
    agent,
    model,
    provider,
    modelArg: agent.kind === 'opencode' ? `${provider}/${model}` : model,
  };
}

function splitModel(agent: HostAgent): ['anthropic' | 'openai', string] {
  const slash = agent.model.indexOf('/');
  const provider = slash > 0 ? agent.model.slice(0, slash) : '';
  const model = agent.model.slice(slash + 1);
  if (agent.model === 'default' || slash <= 0 || !model)
    throw new AgentModelError(
      `${agent.name} needs a provider and model, such as --model anthropic/claude-sonnet-4-5 (from ${agent.modelSource}: ${agent.model}).`,
    );
  if (!(PROVIDERS as readonly string[]).includes(provider))
    throw new AgentModelError(
      `${agent.name} runs here call Anthropic or OpenAI directly, not ${provider}. Choose a model with --model anthropic/<model> or openai/<model>.`,
    );
  return [provider as 'anthropic' | 'openai', model];
}
