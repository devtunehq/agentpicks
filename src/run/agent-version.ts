/**
 * ABOUTME: Installs a chosen version of the agent CLI in the sandbox over the pinned one, so a
 * self-run tests the version the customer has installed. setup.sh sources the script after the
 * pinned agent tools are in place, and the version is checked before the run goes on.
 */
import { shellQuote } from '../assets/script';
import type { AgentKind } from './agent-kind';

/** Each agent CLI's npm package and the command it installs; Muse Code is a binary with no npm release. */
export const AGENT_NPM_PACKAGES = {
  claude_code: { package: '@anthropic-ai/claude-code', bin: 'claude' },
  codex: { package: '@openai/codex', bin: 'codex' },
  opencode: { package: 'opencode-ai', bin: 'opencode' },
  pi: { package: '@earendil-works/pi-coding-agent', bin: 'pi' },
} satisfies Partial<Record<AgentKind, { package: string; bin: string }>>;

export type VersionedAgent = keyof typeof AGENT_NPM_PACKAGES;

/** A version as npm publishes one: digits, letters, dots, `+` and `-`. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function isVersionedAgent(agent: AgentKind): agent is VersionedAgent {
  return Object.hasOwn(AGENT_NPM_PACKAGES, agent);
}

/**
 * `install-agent-version.sh`, sourced by setup.sh (which sets `S` and `set -euo pipefail`):
 * installs `version` of the agent's npm package into its own prefix, links its command over
 * the pinned one, and fails setup unless the command reports that version.
 */
export function agentVersionInstallScript(
  agent: AgentKind,
  version: string,
): string {
  if (!isVersionedAgent(agent))
    throw new Error(`${agent} has no npm release to install a version of`);
  if (!VERSION.test(version))
    throw new Error(`${version} is not an agent version`);
  const { package: name, bin } = AGENT_NPM_PACKAGES[agent];
  const spec = shellQuote(`${name}@${version}`);
  return `# Installs ${name} ${version} over the pinned agent CLI.
mkdir -p $S/agent-version
echo '{"private":true}' > $S/agent-version/package.json
(cd $S/agent-version && npm install --no-audit --no-fund ${spec} >/dev/null)
ln -sf $S/agent-version/node_modules/.bin/${bin} $S/node/bin/${bin}
case "$(${bin} --version 2>&1)" in
  *${shellQuote(version)}*) ;;
  *) echo "${bin} --version does not report ${version}" >&2; exit 5 ;;
esac
`;
}

/** Extends setup.sh to install the chosen agent version once the pinned tools are in place. */
export function agentVersionSetupScript(base: string): string {
  return base.replace(
    't1=$(date +%s)',
    () => 'source $S/install-agent-version.sh\nt1=$(date +%s)',
  );
}
