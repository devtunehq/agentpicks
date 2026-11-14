/**
 * ABOUTME: The coding agents a self-run can launch, by name, command and `--agent` alias. Plain
 * data with no Node imports, so the setup file schema can read it from the package's root export,
 * which the web app's client bundles load.
 */
import type { VersionedAgent } from '../run/agent-version';

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
