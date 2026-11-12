/**
 * ABOUTME: Runs the real agent-session.sh and stop-agent.sh against a live local process
 * session: the session is found by its recorded id (not by command line), every process in
 * it is stopped, and `killed` is true only when a live session was found and is gone.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_SESSION_SH, STOP_AGENT_SH } from './static-scripts';

const hasTools = (() => {
  try {
    for (const tool of ['setsid', 'pgrep', 'pkill', 'ps'])
      execFileSync('sh', ['-c', `command -v ${tool}`]);
    return process.platform === 'linux';
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'agent-picks-stop-'));
const sessionScript = join(dir, 'agent-session.sh');
const stopScript = join(dir, 'stop-agent.sh');
writeFileSync(sessionScript, AGENT_SESSION_SH);
writeFileSync(stopScript, STOP_AGENT_SH);

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await sleep(100);
  return check();
}

const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.split(') ')[1]?.[0] !== 'Z';
  } catch {
    return false;
  }
};

const stop = (sidFile: string) =>
  JSON.parse(
    `{${execFileSync('bash', [stopScript, sidFile], { encoding: 'utf8' }).trim()}}`,
  ) as { agentFound: boolean; killed: boolean };

describe.skipIf(!hasTools)('stop-agent.sh', () => {
  it('stops the recorded session and everything in it, wherever the command line came from', async () => {
    const sidFile = join(dir, 'agent.sid');
    const childPidFile = join(dir, 'child.pid');
    // Launched as run-agent.sh launches the agent, through a command line no pattern would
    // match, with a child that ignores SIGTERM (as an installer might).
    const agent = spawn(
      'setsid',
      [
        '-w',
        'bash',
        sessionScript,
        sidFile,
        'bash',
        '-c',
        `( trap '' TERM; echo $BASHPID > ${childPidFile}; while true; do sleep 0.2; done ) & while true; do sleep 0.2; done`,
      ],
      { stdio: 'ignore' },
    );
    await waitFor(() => existsSync(sidFile) && existsSync(childPidFile));
    const sid = Number(readFileSync(sidFile, 'utf8'));
    const child = Number(readFileSync(childPidFile, 'utf8'));
    started.push(sid);
    expect(alive(sid)).toBe(true);
    expect(alive(child)).toBe(true);

    expect(stop(sidFile)).toEqual({ agentFound: true, killed: true });

    expect(await waitFor(() => !alive(sid) && !alive(child))).toBe(true);
    agent.kill('SIGKILL');
  });

  it('reports that it found nothing when no session was recorded', () => {
    expect(stop(join(dir, 'missing.sid'))).toEqual({
      agentFound: false,
      killed: false,
    });
  });

  it('reports that it found nothing when the recorded session already ended', async () => {
    const sidFile = join(dir, 'ended.sid');
    const agent = spawn(
      'setsid',
      ['-w', 'bash', sessionScript, sidFile, 'true'],
      {
        stdio: 'ignore',
      },
    );
    await new Promise((resolve) => agent.on('exit', resolve));
    expect(existsSync(sidFile)).toBe(true);
    expect(stop(sidFile)).toEqual({ agentFound: false, killed: false });
  });
});
