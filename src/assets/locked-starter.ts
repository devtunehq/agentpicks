/** ABOUTME: Looks up a committed starter, or the agent tools, by key. */
import { LOCKED_STARTERS } from '../locks';
import type { LockedStarter } from '../locks/locked-files';

/** The committed starter (or agent tools) by key; a missing one is a catalogue bug. */
export function lockedStarter(key: string): LockedStarter {
  const locked = LOCKED_STARTERS[key];
  if (!locked)
    throw new Error(
      `No committed starter ${key}: run pnpm --filter web agent-picks:lock-environments`,
    );
  return locked;
}
