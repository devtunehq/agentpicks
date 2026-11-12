/**
 * ABOUTME: Every limit an Agent Picks run runs under, in one place: each agent's own limits
 * (its CLI's turn cap and early stop), the wall-clock limits on the agent and on setup, and
 * the sandbox's lifetime, plus how a limit that stopped an agent reads in a run's error.
 */
import type { AgentKind } from './agent-kind';

export interface AgentRunLimits {
  /**
   * The turn cap passed on the agent CLI's command line (Claude Code `--max-turns`); null
   * for a CLI that has none (`codex exec` takes no turn or step cap).
   */
  maxTurns: number | null;
  /** Seconds the agent runs on after a pick lands before it is stopped; null when early stop is not supported. */
  earlyStopGraceSec: number | null;
}

/** Each agent's own limits; a test records the values it runs under in its matrix. */
export const AGENT_RUN_LIMITS = {
  // At 60 turns, runs that were done stopped short; those took about 375 seconds.
  claude_code: { maxTurns: 100, earlyStopGraceSec: 60 },
  codex: { maxTurns: null, earlyStopGraceSec: null },
  opencode: { maxTurns: null, earlyStopGraceSec: null },
  pi: { maxTurns: null, earlyStopGraceSec: null },
  muse_code: { maxTurns: null, earlyStopGraceSec: null },
} satisfies Record<AgentKind, AgentRunLimits>;

/**
 * The agent CLI's wall-clock limit (`timeout` in run-agent.sh), the same for every agent
 * so each gets the same time to finish.
 */
export const AGENT_TIMEOUT_SEC = 900;

/** Setup's own limit; the spike's slowest environment (Rails) took about four minutes. */
export const SETUP_TIMEOUT_SEC = 600;

/** The sandbox's lifetime cap, after which the provider stops it whatever is running. */
export const SANDBOX_LIFETIME_MIN = 40;

/**
 * GNU `timeout`'s exit status when it stopped the command because its time ran out, as
 * run-agent.sh records it in meta.json.
 */
export const TIMEOUT_EXIT_CODE = 124;

/** A limit that stopped the agent before it finished, and its value (turns or seconds). */
export type LimitStop =
  | { limit: 'turns'; value: number }
  | { limit: 'deadline'; value: number };

/** The turn cap a run's agent runs under; null when its CLI has none. */
export function turnLimit(job: {
  agent: AgentKind;
  maxTurns?: number;
}): number | null {
  const cap = AGENT_RUN_LIMITS[job.agent].maxTurns;
  return cap === null ? null : (job.maxTurns ?? cap);
}

/** How a limit stop reads in a run's error, e.g. `limit: turns, 100`. */
export function describeLimitStop(stop: LimitStop): string {
  return stop.limit === 'turns'
    ? `limit: turns, ${stop.value}`
    : `limit: deadline, ${stop.value} s`;
}
