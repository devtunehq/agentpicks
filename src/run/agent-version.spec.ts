/** ABOUTME: Covers installing the host's agent version in the sandbox, and that runs without one keep the managed assets. */
import { describe, expect, it } from 'vitest';

import { buildSandboxAssets } from '../assets/sandbox-assets';
import { CATEGORY_EARLY_STOP } from '../catalogue/early-stop.generated';
import { findEnvironment } from '../catalogue/environments';
import { agentVersionInstallScript } from './agent-version';

const environment = findEnvironment('nextjs')!;
const signals = { earlyStop: CATEGORY_EARLY_STOP['error-tracking']! };

describe('agentVersionInstallScript', () => {
  it('installs the npm package at the version, links its command and checks the version', () => {
    const script = agentVersionInstallScript('claude_code', '2.1.322');
    expect(script).toContain(
      "npm install --no-audit --no-fund '@anthropic-ai/claude-code@2.1.322'",
    );
    expect(script).toContain(
      'ln -sf $S/agent-version/node_modules/.bin/claude $S/node/bin/claude',
    );
    expect(script).toContain(
      `case "$(claude --version 2>&1)" in\n  *'2.1.322'*) ;;`,
    );
  });

  it('refuses an agent with no npm release and a version npm could not publish', () => {
    expect(() => agentVersionInstallScript('muse_code', '1.0.0')).toThrow(
      'muse_code has no npm release',
    );
    expect(() =>
      agentVersionInstallScript('codex', "1.0.0'; rm -rf /"),
    ).toThrow('is not an agent version');
  });
});

describe('buildSandboxAssets with an agent version', () => {
  it('adds the install and sources it from setup.sh before the proxy step', () => {
    const managed = buildSandboxAssets(environment, signals, 'codex');
    const selfRun = buildSandboxAssets(environment, signals, 'codex', {
      agentVersion: '0.167.1',
    });
    const setup = selfRun.find((a) => a.path.endsWith('/setup.sh'))!.content;
    expect(setup).toContain(
      'source $S/install-agent-version.sh\nt1=$(date +%s)',
    );
    expect(selfRun.map((a) => a.path)).toEqual([
      '/opt/agent-picks/install-agent-version.sh',
      ...managed.map((a) => a.path),
    ]);
    // Every other asset is the managed run's.
    expect(
      selfRun.slice(1).filter((a) => !a.path.endsWith('/setup.sh')),
    ).toEqual(managed.filter((a) => !a.path.endsWith('/setup.sh')));
  });

  it("installs after OpenCode's pinned install, so the host's version is the one on PATH", () => {
    const setup = buildSandboxAssets(environment, signals, 'opencode', {
      agentVersion: '2.2.7',
    }).find((a) => a.path.endsWith('/setup.sh'))!.content;
    expect(setup).toContain(
      'source $S/install-opencode.sh\nsource $S/install-agent-version.sh\nt1=$(date +%s)',
    );
  });

  it('leaves the assets unchanged without one', () => {
    expect(buildSandboxAssets(environment, signals, 'claude_code', {})).toEqual(
      buildSandboxAssets(environment, signals, 'claude_code'),
    );
  });
});
