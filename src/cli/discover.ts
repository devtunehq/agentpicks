/**
 * ABOUTME: Finds the coding agents installed on the customer's machine (spec 46 §3.2): Claude
 * Code, Codex, OpenCode and Pi, each with its version and configured model, read from the
 * agent's own config. `--agent` and `--model` override what is found. Cursor, and Muse Code,
 * which runs only through DevTune's model proxy, are refused by name.
 */
import { join } from 'node:path';

import type { VersionedAgent } from '../run/agent-version';
import { AgentSelectionError, UnsupportedAgentError } from './errors';
import { parseVersion, readJsonObject, stringField, type HostIo } from './host';

export interface SelfRunAgent {
  kind: VersionedAgent;
  name: string;
  /** The command it installs on PATH. */
  command: string;
  /** What `--agent` accepts for it. */
  aliases: string[];
}

/** The agents a self-run can launch, in the order they are listed. */
export const SELF_RUN_AGENTS: SelfRunAgent[] = [
  {
    kind: 'claude_code',
    name: 'Claude Code',
    command: 'claude',
    aliases: ['claude-code', 'claude', 'claude_code'],
  },
  {
    kind: 'codex',
    name: 'Codex',
    command: 'codex',
    aliases: ['codex'],
  },
  {
    kind: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    aliases: ['opencode'],
  },
  { kind: 'pi', name: 'Pi', command: 'pi', aliases: ['pi'] },
];

/** Agents a self-run refuses by name, and why. */
const REFUSED = [
  {
    name: 'Cursor',
    command: 'cursor-agent',
    aliases: ['cursor', 'cursor-agent', 'cursor_agent'],
    reason: 'agentpicks has no capture for Cursor runs yet',
  },
  {
    name: 'Muse Code',
    command: null,
    aliases: ['muse', 'muse-code', 'muse_code'],
    reason:
      "Muse Code runs only through DevTune's model proxy, so it cannot run on your machine",
  },
] as const;

export interface HostAgent {
  kind: SelfRunAgent['kind'];
  name: string;
  /** The command's absolute path on this machine. */
  path: string;
  /** The version installed here, which the sandbox installs too. */
  version: string;
  /** The model to ask for; `default` is the agent's own default. */
  model: string;
  /** Where the model came from: `--model`, an environment variable or a config file. */
  modelSource: string;
}

/** Every supported agent on PATH, and any refused one found there. */
export function discoverAgents(io: HostIo): {
  agents: HostAgent[];
  refused: { name: string; reason: string }[];
} {
  return {
    agents: SELF_RUN_AGENTS.flatMap((agent) => {
      const found = findAgent(io, agent);
      return found ? [found] : [];
    }),
    refused: REFUSED.filter(
      (agent) => agent.command && io.which(agent.command),
    ).map(({ name, reason }) => ({ name, reason })),
  };
}

/**
 * The agent a run uses: `--agent`'s, or the one supported agent installed here. Several
 * installed and none chosen is refused, since each run spends on the customer's account.
 */
export function chooseAgent(
  io: HostIo,
  { agent, model }: { agent?: string; model?: string },
): HostAgent {
  let chosen: HostAgent;
  if (agent) {
    const name = agent.toLowerCase();
    const refused = REFUSED.find((r) =>
      (r.aliases as readonly string[]).includes(name),
    );
    if (refused)
      throw new UnsupportedAgentError(
        `${refused.name} can't be tested: ${refused.reason}. Choose one of: ${agentChoices()}.`,
      );
    const definition = SELF_RUN_AGENTS.find((a) => a.aliases.includes(name));
    if (!definition)
      throw new UnsupportedAgentError(
        `agentpicks can't run ${agent}. Choose one of: ${agentChoices()}.`,
      );
    const found = findAgent(io, definition);
    if (!found)
      throw new AgentSelectionError(
        `${definition.name} (\`${definition.command}\`) is not installed on this machine, or its version can't be read. Install it, or choose another agent with --agent.`,
      );
    chosen = found;
  } else {
    const { agents, refused } = discoverAgents(io);
    const skipped = refused
      .map((r) => ` ${r.name} is installed, but ${r.reason}.`)
      .join('');
    if (agents.length === 0)
      throw new AgentSelectionError(
        `No agent agentpicks can run is installed here. Install one of: ${SELF_RUN_AGENTS.map((a) => a.name).join(', ')}.${skipped}`,
      );
    if (agents.length > 1)
      throw new AgentSelectionError(
        `Several agents are installed: ${agents.map((a) => `${a.name} ${a.version}`).join(', ')}. Choose one with --agent (${agents.map((a) => SELF_RUN_AGENTS.find((d) => d.kind === a.kind)!.aliases[0]).join(', ')}).`,
      );
    chosen = agents[0]!;
  }
  return model ? { ...chosen, model, modelSource: '--model' } : chosen;
}

function agentChoices(): string {
  return SELF_RUN_AGENTS.map((a) => a.aliases[0]).join(', ');
}

function findAgent(io: HostIo, agent: SelfRunAgent): HostAgent | null {
  const path = io.which(agent.command);
  if (!path) return null;
  const version = parseVersion(io.version(path));
  if (!version) return null;
  return {
    kind: agent.kind,
    name: agent.name,
    path,
    version,
    ...configuredModel(io, agent.kind),
  };
}

/** The model the agent's own config sets, or `default` for the agent's default. */
export function configuredModel(
  io: HostIo,
  kind: SelfRunAgent['kind'],
): { model: string; modelSource: string } {
  const fallback = { model: 'default', modelSource: "the agent's default" };
  if (kind === 'claude_code') {
    if (io.env.ANTHROPIC_MODEL)
      return { model: io.env.ANTHROPIC_MODEL, modelSource: 'ANTHROPIC_MODEL' };
    const path = join(claudeConfigDir(io), 'settings.json');
    const settings = readJsonObject(io, path);
    const env = settings?.env;
    const model =
      (env && typeof env === 'object'
        ? stringField(env as Record<string, unknown>, 'ANTHROPIC_MODEL')
        : undefined) ?? stringField(settings, 'model');
    return model ? { model, modelSource: path } : fallback;
  }
  if (kind === 'codex') {
    const path = join(codexHome(io), 'config.toml');
    const model = topLevelTomlString(io.readFile(path), 'model');
    return model ? { model, modelSource: path } : fallback;
  }
  if (kind === 'opencode') {
    const dir = join(
      io.env.XDG_CONFIG_HOME || join(io.home, '.config'),
      'opencode',
    );
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      const path = join(dir, name);
      const model = stringField(readJsonObject(io, path), 'model');
      if (model) return { model, modelSource: path };
    }
    return fallback;
  }
  const path = join(piAgentDir(io), 'settings.json');
  const settings = readJsonObject(io, path);
  const model = stringField(settings, 'defaultModel');
  const provider = stringField(settings, 'defaultProvider');
  return model
    ? { model: provider ? `${provider}/${model}` : model, modelSource: path }
    : fallback;
}

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(io: Pick<HostIo, 'env' | 'home'>): string {
  return io.env.CLAUDE_CONFIG_DIR || join(io.home, '.claude');
}

/** Codex's home: `CODEX_HOME`, or `~/.codex`. */
export function codexHome(io: Pick<HostIo, 'env' | 'home'>): string {
  return io.env.CODEX_HOME || join(io.home, '.codex');
}

/** Pi's agent directory: `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. */
export function piAgentDir(io: Pick<HostIo, 'env' | 'home'>): string {
  return io.env.PI_CODING_AGENT_DIR || join(io.home, '.pi', 'agent');
}

/** A string key set before the first table of a TOML file (`model = "gpt-5"`). */
export function topLevelTomlString(
  text: string | null,
  key: string,
): string | undefined {
  for (const line of (text ?? '').split('\n')) {
    if (/^\s*\[/.test(line)) return undefined;
    const match = line.match(
      new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`),
    );
    if (match) return match[1] ?? match[2] ?? undefined;
  }
  return undefined;
}
