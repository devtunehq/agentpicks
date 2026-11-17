/**
 * ABOUTME: The question machinery `agentpicks init` asks with: a question's answer from its flag,
 * its default under `--yes`, or the terminal, and the numbered lists, comma entries and ranges a
 * typed answer picks from. `init.ts` and `init-job-line.ts` build their questions on it.
 */
import { requestTextProblem } from '../setup/rules';
import { UsageError } from './errors';
import type { InitFlags } from './init';
import type { DetectedRepository } from './init-detect';
import type { Drafting } from './init-draft';

export type Answer<T> = { value: T } | { problem: string };

export interface Question<T> {
  label: string;
  /** The default, as it would be typed; null when there is none. */
  fallback: string | null;
  /** `flag` is true for a flag's value, whose refusal never offers list numbers, ranges or `.`. */
  read(answer: string, flag: boolean): Answer<T>;
  /** Why `--yes` has no default here, and how to give one. */
  missing?: string;
  /** The flag that answers it, such as --runs; unset where no flag does. */
  flag?: string;
  /** The flag's value when it was given, read as a typed answer instead of asking. */
  given?: string;
  /** For a flag taking keys, the command that lists them; a list number in its value is refused. */
  keys?: string;
}

export interface Wizard {
  yes: boolean;
  /** Whether a question no flag answers can be asked. */
  interactive: boolean;
  flags: InitFlags;
  /** Where init runs, which refusals show paths from. */
  cwd: string;
  ask: (question: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  detected: DetectedRepository;
  drafting: Drafting | null;
  /** Whether the line saying Enter takes a default has been printed. */
  hinted: boolean;
}

/**
 * Reads a flag's value as its question's answer, refusing by the flag's name: a list number or
 * range in a flag taking keys, or a value its question's read refuses.
 */
export function readGiven<T>(question: Question<T> & { given: string }): T {
  if (question.keys)
    refuseListNumbers(question.flag!, question.given, question.keys);
  const read = question.read(question.given.trim(), true);
  if ('problem' in read)
    throw new UsageError(
      `${question.flag}: ${read.problem}${question.keys ? ` List the keys with: ${question.keys}` : ''}`,
    );
  return read.value;
}

/** Refuses a list number or range in the value of `flag`, which takes keys `keys` lists. */
export function refuseListNumbers(flag: string, value: string, keys: string) {
  const number = entries(value).find((entry) => /^\d+(-\d+)?$/.test(entry));
  if (number !== undefined)
    throw new UsageError(
      `${flag} takes keys, not list numbers such as ${number}. Give them from: ${keys}`,
    );
}

/**
 * Answers one question: from its flag when given, else under --yes its default, else on a
 * terminal by asking until the answer reads. Off a terminal it refuses, naming its flag, and
 * --yes where the question has a default to take.
 */
export async function ask<T>(
  wizard: Wizard,
  question: Question<T>,
): Promise<T> {
  if (question.given !== undefined)
    return readGiven({ ...question, given: question.given });
  if (wizard.yes) {
    if (question.fallback === null)
      throw new UsageError(
        `agentpicks init --yes ${question.missing ?? `has no default for ${question.label.toLowerCase()}. Run agentpicks init on a terminal to answer it.`}`,
      );
    const read = question.read(question.fallback, false);
    if ('problem' in read) throw new UsageError(read.problem);
    return read.value;
  }
  if (!wizard.interactive) {
    const asked = `agentpicks init can't ask "${question.label}" without a terminal`;
    if (question.fallback !== null)
      throw new UsageError(
        `${asked}. Pass ${question.flag ? `${question.flag}, or --yes` : '--yes'} to take its default.`,
      );
    throw new UsageError(
      `${asked}, and ${question.missing ?? 'it has no default. Answer it on a terminal.'}${question.flag ? ` Or pass ${question.flag}.` : ''}`,
    );
  }
  hint(wizard);
  for (;;) {
    const shown = question.fallback === null ? '' : ` [${question.fallback}]`;
    const answer =
      (await wizard.ask(`${question.label}${shown}: `)).trim() ||
      question.fallback ||
      '';
    const read = question.read(answer, false);
    if ('value' in read) return read.value;
    wizard.err(read.problem);
  }
}

/** Says once, before the first list or question shown, that Enter takes a default. */
export function hint(wizard: Wizard) {
  if (wizard.hinted) return;
  wizard.out('Press Enter to take the default in brackets.');
  wizard.hinted = true;
}

/**
 * Prints `items` numbered from 1, down then across `columns`, so an answer can pick one by its
 * number. Nothing where the question isn't asked: under --yes, off a terminal, or when its flag
 * (`given`) answers it.
 */
export function showNumbered(
  wizard: Wizard,
  given: string | undefined,
  title: string,
  items: string[],
  columns = items.length > 10 ? 3 : 1,
) {
  if (wizard.yes || !wizard.interactive || given !== undefined) return;
  hint(wizard);
  wizard.out(title);
  const rows = Math.ceil(items.length / columns);
  const width = Math.max(...items.map((item) => item.length));
  for (let row = 0; row < rows; row++) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column++) {
      const i = column * rows + row;
      const item = items[i];
      if (item !== undefined)
        cells.push(`${String(i + 1).padStart(2)}  ${item.padEnd(width)}`);
    }
    wizard.out(`  ${cells.join('  ').trimEnd()}`);
  }
}

/** The key an answer names: its number on the list `keys` was shown as, or the key itself. */
export const pickKey = (answer: string, keys: string[]) =>
  /^\d+$/.test(answer)
    ? (keys[Number(answer) - 1] ?? null)
    : keys.includes(answer)
      ? answer
      : null;

/** Splits a comma-separated answer into its entries. */
export const entries = (answer: string) =>
  answer
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * A typed answer's entries, with each range `a-b` (1 <= a <= b <= `count`) as the numbers a to b.
 * Any other range stays as typed, so it is refused as an unknown entry is.
 */
export const withRanges = (answer: string, count: number) =>
  entries(answer).flatMap((entry) => {
    const range = /^(\d+)-(\d+)$/.exec(entry);
    if (!range) return [entry];
    const [from, to] = [Number(range[1]), Number(range[2])];
    return from >= 1 && from <= to && to <= count
      ? Array.from({ length: to - from + 1 }, (_, i) => String(from + i))
      : [entry];
  });

/** Whether a request or new job line is shorter or longer than the setup rules take. */
export const badLength = (text: string) => {
  const problem = requestTextProblem(text);
  return problem === 'too_short' || problem === 'too_long';
};

/** A setup or tool name from free text: lowercase letters and digits joined by hyphens. */
export function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
      .replace(/-+$/, '') || 'setup'
  );
}
