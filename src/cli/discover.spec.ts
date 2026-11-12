/** ABOUTME: Covers agent discovery: versions and configured models per agent, the choice rules and the refusals. */
import { describe, expect, it } from 'vitest';

import { chooseAgent, discoverAgents, topLevelTomlString } from './discover';
import { AgentSelectionError, UnsupportedAgentError } from './errors';
import { FAKE_HOME, fakeHost } from './fake-host';
import { parseVersion } from './host';

const ALL = {
  claude: '2.1.322 (Claude Code)\n',
  codex: 'codex-cli 0.167.1\n',
  opencode: 'opencode v2.2.7\n',
  pi: '1.5.2\n',
};

describe('discoverAgents', () => {
  it('finds each supported agent with its version and configured model', () => {
    const io = fakeHost({
      commands: { ...ALL, 'cursor-agent': '2026.11.01\n' },
      files: {
        [`${FAKE_HOME}/.claude/settings.json`]: JSON.stringify({
          model: 'opus[1m]',
        }),
        [`${FAKE_HOME}/.codex/config.toml`]:
          'model = "gpt-6.1-sol"\n[profiles.fast]\nmodel = "other"\n',
        [`${FAKE_HOME}/.config/opencode/opencode.json`]: JSON.stringify({
          model: 'anthropic/claude-sonnet-5',
        }),
        [`${FAKE_HOME}/.pi/agent/settings.json`]: JSON.stringify({
          defaultProvider: 'openai',
          defaultModel: 'gpt-6-luna',
        }),
      },
    });
    const { agents, refused } = discoverAgents(io);
    expect(
      agents.map(({ kind, version, model }) => [kind, version, model]),
    ).toEqual([
      ['claude_code', '2.1.322', 'opus[1m]'],
      ['codex', '0.167.1', 'gpt-6.1-sol'],
      ['opencode', '2.2.7', 'anthropic/claude-sonnet-5'],
      ['pi', '1.5.2', 'openai/gpt-6-luna'],
    ]);
    expect(refused.map((r) => r.name)).toEqual(['Cursor']);
  });

  it("falls back to the agent's default model, and prefers ANTHROPIC_MODEL for Claude Code", () => {
    const io = fakeHost({
      commands: { claude: ALL.claude, codex: ALL.codex },
      env: { ANTHROPIC_MODEL: 'claude-sonnet-5' },
      files: {
        [`${FAKE_HOME}/.claude/settings.json`]: JSON.stringify({
          model: 'opus',
        }),
      },
    });
    expect(
      discoverAgents(io).agents.map((a) => [a.model, a.modelSource]),
    ).toEqual([
      ['claude-sonnet-5', 'ANTHROPIC_MODEL'],
      ['default', "the agent's default"],
    ]);
  });

  it('reads the config each agent names in its environment', () => {
    const io = fakeHost({
      commands: { claude: ALL.claude, codex: ALL.codex },
      env: { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' },
      files: {
        '/cfg/claude/settings.json': JSON.stringify({
          env: { ANTHROPIC_MODEL: 'haiku' },
        }),
        '/cfg/codex/config.toml': "model = 'gpt-6'\n",
      },
    });
    expect(discoverAgents(io).agents.map((a) => a.model)).toEqual([
      'haiku',
      'gpt-6',
    ]);
  });

  it("reads OpenCode's config as JSONC, with comments and trailing commas", () => {
    const config = `{
  // The model every session starts with.
  "model": "anthropic/claude-sonnet-5", /* pinned */
  "autoupdate": false,
}`;
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const io = fakeHost({
        commands: { opencode: ALL.opencode },
        files: { [`${FAKE_HOME}/.config/opencode/${name}`]: config },
      });
      expect(discoverAgents(io).agents[0]).toMatchObject({
        model: 'anthropic/claude-sonnet-5',
        modelSource: `${FAKE_HOME}/.config/opencode/${name}`,
      });
    }
  });

  it('ignores a malformed config rather than reading part of it', () => {
    const io = fakeHost({
      commands: { opencode: ALL.opencode },
      files: {
        [`${FAKE_HOME}/.config/opencode/opencode.json`]:
          '{ "model": "anthropic/claude-sonnet-5" "share": }',
      },
    });
    expect(discoverAgents(io).agents[0]!.model).toBe('default');
  });

  it('skips a command whose version cannot be read', () => {
    const io = fakeHost({ commands: { claude: 'no version here' } });
    expect(discoverAgents(io).agents).toEqual([]);
  });
});

describe('chooseAgent', () => {
  it('uses the one supported agent installed, and --model over its config', () => {
    const io = fakeHost({ commands: { claude: ALL.claude } });
    expect(chooseAgent(io, {})).toMatchObject({
      kind: 'claude_code',
      version: '2.1.322',
      model: 'default',
    });
    expect(chooseAgent(io, { model: 'sonnet' })).toMatchObject({
      model: 'sonnet',
      modelSource: '--model',
    });
  });

  it('refuses to pick between several installed agents, naming them', () => {
    const io = fakeHost({ commands: ALL });
    expect(() => chooseAgent(io, {})).toThrow(AgentSelectionError);
    expect(() => chooseAgent(io, {})).toThrow(
      'Several agents are installed: Claude Code 2.1.322, Codex 0.167.1, OpenCode 2.2.7, Pi 1.5.2. Choose one with --agent (claude-code, codex, opencode, pi).',
    );
    expect(chooseAgent(io, { agent: 'codex' }).kind).toBe('codex');
    expect(chooseAgent(io, { agent: 'Claude' }).kind).toBe('claude_code');
  });

  it('refuses Cursor and Muse Code by name, and any agent it does not know', () => {
    const io = fakeHost({ commands: { 'cursor-agent': '1.0.0' } });
    expect(() => chooseAgent(io, { agent: 'cursor' })).toThrow(
      new UnsupportedAgentError(
        "Cursor can't be tested: agentpicks has no capture for Cursor runs yet. Choose one of: claude-code, codex, opencode, pi.",
      ),
    );
    expect(() => chooseAgent(io, { agent: 'muse' })).toThrow(
      /Muse Code can't be tested: Muse Code runs only through DevTune's model proxy/,
    );
    expect(() => chooseAgent(io, { agent: 'aider' })).toThrow(
      UnsupportedAgentError,
    );
  });

  it('names a refused agent it found when nothing it can run is installed', () => {
    const io = fakeHost({ commands: { 'cursor-agent': '1.0.0' } });
    expect(() => chooseAgent(io, {})).toThrow(
      /No agent agentpicks can run is installed here.*Cursor is installed, but agentpicks has no capture for Cursor runs yet/,
    );
  });

  it('refuses a chosen agent that is not installed', () => {
    expect(() => chooseAgent(fakeHost(), { agent: 'codex' })).toThrow(
      /Codex \(`codex`\) is not installed on this machine/,
    );
  });
});

describe('parseVersion', () => {
  it.each([
    ['2.1.322 (Claude Code)', '2.1.322'],
    ['codex-cli 0.167.1', '0.167.1'],
    ['opencode v2.2.7', '2.2.7'],
    ['pi 1.5.2-beta.1\n', '1.5.2-beta.1'],
    ['no version', null],
  ])('reads %j as %j', (output, version) => {
    expect(parseVersion(output)).toBe(version);
  });
});

describe('topLevelTomlString', () => {
  it('reads a key only before the first table', () => {
    expect(topLevelTomlString('[a]\nmodel = "x"\n', 'model')).toBeUndefined();
    expect(
      topLevelTomlString('# c\nmodel_provider = "p"\nmodel = "m"\n', 'model'),
    ).toBe('m');
  });
});
