/**
 * ABOUTME: The DevTune mark, played once in about half a second when `agentpicks` runs bare or with
 * --help, and when a login succeeds: its dots grow from the centre outward, then the name appears.
 * It only plays on a terminal at least 40 columns wide, never in CI, or under TERM=dumb, NO_COLOR or
 * AGENTPICKS_NO_LOGO.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import packageJson from '../../package.json';

/** The mark in apps/docs/logo: green brackets (b) around the core (c), 11 dots by 5. */
const MARK = [
  '  b  c  b  ',
  ' b  ccc  b ',
  'b   ccc   b',
  ' b  ccc  b ',
  '  b  c  b  ',
];
const CENTRE = 5;
const LAST_STEP = CENTRE + 1;
export const FRAME_MS = 55;
/** The narrowest terminal the mark and its name fit. */
export const LOGO_COLUMNS = 40;

const GREEN = '\x1b[38;5;36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Every frame of the animation, each the mark's five lines. A dot further from the centre column
 * than `step` isn't drawn yet, one at `step` is small and one nearer is whole; the name follows.
 */
export function logoFrames(version: string): string[][] {
  const text = [
    '',
    `${BOLD}DevTune${RESET}`,
    'Agent Picks',
    `${DIM}${version}${RESET}`,
    '',
  ];
  const frame = (step: number, words: number) =>
    MARK.map((row, r) => {
      const dots = [...row]
        .map((cell, col) => {
          const distance = Math.abs(col - CENTRE);
          if (cell === ' ' || distance > step) return ' ';
          const dot = distance === step ? '·' : '●';
          return cell === 'b' ? `${GREEN}${dot}${RESET}` : dot;
        })
        .join(' ');
      return r < words + 1 && text[r] ? `${dots}   ${text[r]}` : dots.trimEnd();
    });
  return [
    ...Array.from({ length: LAST_STEP + 1 }, (_, step) => frame(step, 0)),
    frame(LAST_STEP, 1),
    frame(LAST_STEP, 3),
  ];
}

/**
 * Plays the mark on standard output, or is undefined where it shouldn't: output that isn't a
 * terminal, CI, a dumb terminal, NO_COLOR, AGENTPICKS_NO_LOGO or fewer than 40 columns.
 */
export function logoPlayer(
  env: Record<string, string | undefined>,
  stdout: { isTTY?: boolean; columns?: number; write(text: string): unknown },
): (() => Promise<void>) | undefined {
  if (
    !stdout.isTTY ||
    (stdout.columns ?? 0) < LOGO_COLUMNS ||
    env.CI ||
    env.TERM === 'dumb' ||
    env.NO_COLOR ||
    env.AGENTPICKS_NO_LOGO
  )
    return undefined;
  return async () => {
    const frames = logoFrames(packageJson.version);
    for (const [i, lines] of frames.entries()) {
      // After the first frame, the cursor goes back up to redraw the mark in place.
      if (i > 0) {
        await sleep(FRAME_MS);
        stdout.write(`\x1b[${lines.length}A`);
      }
      stdout.write(lines.map((line) => `\r\x1b[2K${line}\n`).join(''));
    }
    stdout.write('\n');
  };
}
