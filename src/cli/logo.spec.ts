/**
 * ABOUTME: Tests the DevTune mark `agentpicks` plays for help and a login: its frames, its length,
 * and where it doesn't play.
 */
import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json';
import { FRAME_MS, LOGO_COLUMNS, logoFrames, logoPlayer } from './logo';

/** The line as a terminal shows its text, without colour codes. */
const plain = (line: string) =>
  line
    .split('\x1b[')
    .map((part, i) => (i === 0 ? part : part.replace(/^[\d;]*m/, '')))
    .join('');

function terminal(columns = 80) {
  const writes: string[] = [];
  return {
    isTTY: true,
    columns,
    write: (text: string) => void writes.push(text),
    writes,
  };
}

describe('the DevTune mark', () => {
  it('grows from the centre outward and ends as the mark beside its name', () => {
    const frames = logoFrames('9.9.9').map((frame) => frame.map(plain));
    expect(frames[0]).toEqual(Array(5).fill('          ·'));
    expect(frames.at(-1)).toEqual([
      '    ●     ●     ●',
      '  ●     ● ● ●     ●     DevTune',
      '●       ● ● ●       ●   Agent Picks',
      '  ●     ● ● ●     ●     9.9.9',
      '    ●     ●     ●',
    ]);
    for (const frame of frames) {
      expect(frame).toHaveLength(5);
      for (const line of frame)
        expect(line.length).toBeLessThanOrEqual(LOGO_COLUMNS);
    }
  });

  it('plays once in at most 600 ms, redrawing in place', async () => {
    const out = terminal();
    const start = Date.now();
    await logoPlayer({}, out)!();
    const frames = logoFrames(packageJson.version);
    expect(frames.length * FRAME_MS).toBeLessThanOrEqual(600);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(out.writes.filter((w) => w === '\x1b[5A')).toHaveLength(
      frames.length - 1,
    );
    expect(out.writes.at(-1)).toBe('\n');
  });

  it.each([
    ['piped output', {}, { isTTY: false }],
    ['a terminal narrower than the mark', {}, { columns: LOGO_COLUMNS - 1 }],
    ['CI', { CI: 'true' }, {}],
    ['a dumb terminal', { TERM: 'dumb' }, {}],
    ['NO_COLOR', { NO_COLOR: '1' }, {}],
    ['AGENTPICKS_NO_LOGO', { AGENTPICKS_NO_LOGO: '1' }, {}],
  ])("doesn't play for %s", (_, env, stdout) => {
    expect(logoPlayer(env, { ...terminal(), ...stdout })).toBeUndefined();
  });
});
