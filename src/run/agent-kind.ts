/** ABOUTME: The coding agents a run can launch in the sandbox, by the kind a run records. */

/** Every agent a run can launch, in the order tests list them. */
export const AGENT_KINDS = [
  'claude_code',
  'codex',
  'opencode',
  'pi',
  'muse_code',
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** The API an agent's model is called through, which decides the key it holds. */
export type ModelProvider = 'anthropic' | 'openai' | 'gateway';
