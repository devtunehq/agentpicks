/**
 * ABOUTME: The rules a setup meets wherever it is written: the limits on its job line, requests and
 * tools, the request guard, and the formats of a tool's names (tool key, name, domain, package and
 * config names). Patterns, which need RE2, are `pattern-rules.ts`'s, so client code can load this
 * module without it. The setup file's schema and DevTune's job save, copy save and drafting parser
 * are all built from the two, so a setup one accepts the other accepts. A tool needs no package,
 * config name or pattern: one known only by name, aliases and domains is recognised in what an
 * agent says, and a run's early stop doesn't watch for it.
 */
import { z } from 'zod';

import { CATEGORY_TOOLS } from '../catalogue/category-tools.generated';

/**
 * Every tool key in DevTune's catalogue that this version knows. A setup names such a tool by key,
 * since its signals are DevTune's; any other tool is one the customer wrote, which a setup file holds
 * whole.
 */
export const CATALOGUE_TOOL_KEYS: ReadonlySet<string> = new Set(
  Object.values(CATEGORY_TOOLS).flat(),
);

/** The longest job line and request. */
export const SETUP_TEXT_MAX_LENGTH = 300;

/** The shortest request, and the shortest new or changed job line (`requestTextProblem`). */
export const SETUP_REQUEST_MIN_LENGTH = 8;

/**
 * The shortest job line a setup holds. A job saved before job lines were held to a request's length
 * may keep its shorter line, so a setup file linked to it can hold it; a new or changed line meets
 * `requestTextProblem`.
 */
export const SETUP_JOB_LINE_MIN_LENGTH = 1;

/** The shortest pattern. */
export const SETUP_PATTERN_MIN_LENGTH = 1;

/** The longest pattern, so one can't make recognition slow. */
export const SETUP_PATTERN_MAX_LENGTH = 200;

/** The most competitors a setup tracks. */
export const SETUP_MAX_COMPETITORS = 6;

/** The most tools a setup without a category compares: yours and up to six competitors. */
export const SETUP_MAX_TOOLS = SETUP_MAX_COMPETITORS + 1;

/** The most tools any built-in category compares, so a copy of it can hold its whole list. */
export const LARGEST_CATEGORY_TOOLS = Math.max(
  ...Object.values(CATEGORY_TOOLS).map((keys) => keys.length),
);

/** The most tools any setup holds: the largest category's plus as many as a setup without one. */
export const SETUP_MAX_RECORDED_TOOLS =
  LARGEST_CATEGORY_TOOLS + SETUP_MAX_TOOLS;

/**
 * The most tools a setup holds: a copy of the built-in category `categorySlug` its tools plus as
 * many as a setup without one, a setup without a category (null) `SETUP_MAX_TOOLS`.
 */
export function setupMaxTools(categorySlug: string | null) {
  return (
    (categorySlug ? (CATEGORY_TOOLS[categorySlug]?.length ?? 0) : 0) +
    SETUP_MAX_TOOLS
  );
}

/**
 * A package or config name the sandbox's early-stop watcher can carry in a single-quoted shell
 * string: no quotes, spaces, `$` or backticks.
 */
export const SAFE_SIGNAL_NAME = /^[A-Za-z0-9@._/:*-]+$/;

/**
 * A safe package name with a letter or digit, so a prefix (`@acme/`, `acme*`) still names something.
 * The leading run excludes letters and digits so only one split exists and a long refused name fails
 * in linear time.
 */
const PACKAGE_NAME = /^[@._/:*-]*[A-Za-z0-9][A-Za-z0-9@._/:*-]*$/;

/** A safe config name that `grep` never reads as an option: no leading `-`. */
const CONFIG_NAME = /^[A-Za-z0-9@._/:*][A-Za-z0-9@._/:*-]*$/;

/**
 * A signal value DevTune reviewed in its catalogue, which passes its field's format as it is. DevTune's
 * checks pass their catalogue's own patterns and config names, which its catalogue tools carry and a
 * copy holds as copied; a setup file holds no catalogue tool's signals, so it passes none.
 */
export type ReviewedSignal = (
  field: 'pattern' | 'configName',
  value: string,
) => boolean;

/**
 * A signal field's format: `format` with `message`, unless `reviewed` passes the value. Without
 * `reviewed` it is a plain regex, which the setup file's JSON Schema carries.
 */
export function signalFormat(
  base: z.ZodString,
  field: 'pattern' | 'configName',
  format: RegExp | ((value: string) => boolean),
  message: string,
  reviewed?: ReviewedSignal,
) {
  const passes = (value: string) =>
    typeof format === 'function' ? format(value) : format.test(value);
  if (!reviewed && format instanceof RegExp)
    return base.regex(format, { message });
  return base.refine(
    (value) => reviewed?.(field, value) === true || passes(value),
    { message },
  );
}

/** The longest package name, npm's own limit. */
export const PACKAGE_NAME_MAX_LENGTH = 214;

/** The shortest and longest config name. */
export const CONFIG_NAME_MIN_LENGTH = 2;
export const CONFIG_NAME_MAX_LENGTH = 100;

/** What a package name field says when its format or length refuses it. */
export const PACKAGE_NAME_MESSAGE = `A package name is up to ${PACKAGE_NAME_MAX_LENGTH} characters of letters, digits and @ . _ / : * -, with at least one letter or digit. End it with / or * to match a prefix.`;

/** What a config name field says when its format or length refuses it. */
export const CONFIG_NAME_MESSAGE = `A config name is ${CONFIG_NAME_MIN_LENGTH} to ${CONFIG_NAME_MAX_LENGTH} characters of letters, digits and @ . _ / : * -, and doesn't start with -.`;

/** The longest tool key, tool name or alias, and brand domain. */
export const TOOL_KEY_MAX_LENGTH = 63;
export const TOOL_NAME_MAX_LENGTH = 100;
export const DOMAIN_MAX_LENGTH = 253;

export const toolKeySchema = z
  .string()
  .max(TOOL_KEY_MAX_LENGTH)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, {
    message:
      'A tool key is lowercase letters and digits, joined by -, _ or . (such as sentry or my-tool).',
  });

/** A tool's name, and each of its aliases. */
export const toolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TOOL_NAME_MAX_LENGTH);

export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(DOMAIN_MAX_LENGTH)
  .regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, {
    message: 'Give a bare domain, such as example.com.',
  });

export const packageNameSchema = z
  .string()
  .trim()
  .min(1, { message: PACKAGE_NAME_MESSAGE })
  .max(PACKAGE_NAME_MAX_LENGTH, { message: PACKAGE_NAME_MESSAGE, abort: true })
  .regex(PACKAGE_NAME, { message: PACKAGE_NAME_MESSAGE });

/** An env name or a vendor host, matched as a plain substring of the change; `reviewed` as `signalFormat`. */
export function configNameSchema(reviewed?: ReviewedSignal) {
  return signalFormat(
    z
      .string()
      .trim()
      .min(CONFIG_NAME_MIN_LENGTH, { message: CONFIG_NAME_MESSAGE })
      .max(CONFIG_NAME_MAX_LENGTH, { message: CONFIG_NAME_MESSAGE }),
    'configName',
    CONFIG_NAME,
    CONFIG_NAME_MESSAGE,
    reviewed,
  );
}

/** What a pattern field says when its length or `patternProblem` (`pattern-rules.ts`) refuses it. */
export const PATTERN_MESSAGE = `A pattern is ${SETUP_PATTERN_MIN_LENGTH} to ${SETUP_PATTERN_MAX_LENGTH} characters and compiles on RE2, which has no lookarounds or backreferences. Rewrite it.`;

/** The most entries each list of a tool's signals holds; `packages` is per ecosystem. */
export const SIGNAL_LIST_LIMITS = {
  packages: 40,
  configNames: 30,
  importPatterns: 20,
  brandDomains: 10,
  aliases: 20,
  commandPatterns: 10,
  configFiles: 10,
  configPatterns: 10,
  selfHosted: 10,
} as const;

/** Every pattern a tool's signals carry. */
export function toolPatterns(signals: {
  importPatterns?: readonly string[];
  commandPatterns?: readonly string[];
  configFiles?: readonly string[];
  configPatterns?: readonly string[];
  selfHosted?: readonly string[];
}): string[] {
  return [
    ...(signals.importPatterns ?? []),
    ...(signals.commandPatterns ?? []),
    ...(signals.configFiles ?? []),
    ...(signals.configPatterns ?? []),
    ...(signals.selfHosted ?? []),
  ];
}

/**
 * Shapes a request never needs and an instruction to send an agent's keys somewhere does: a link or
 * domain, code characters or an environment reference, and an env-style name. An agent reads a
 * request as an instruction, with keys in its environment. Words aren't refused: a job can be about
 * secrets.
 */
const REQUEST_REFUSALS = [
  [
    /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|io|dev|ai|net|org|app|co|sh|xyz)\b/iu,
    'link',
  ],
  [
    /[$`|<>{};\\]|\b(?:process\.env|os\.environ|getenv|printenv|ENV\[)/iu,
    'code',
  ],
  [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/u, 'variable'],
] as const;

/** Text on one line: a job line or request is one sentence-length line. */
export const ONE_LINE = /^[^\n\r]*$/u;

export type RequestProblem = 'multiline' | (typeof REQUEST_REFUSALS)[number][1];

/** Why a job line or request can't be kept, or null when it can. */
export function requestProblem(text: string): RequestProblem | null {
  if (!ONE_LINE.test(text)) return 'multiline';
  return REQUEST_REFUSALS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export type TextProblem = 'too_short' | 'too_long' | RequestProblem;

/**
 * Why a request, or a new or changed job line, can't be saved, or null when it can: 8 to 300
 * characters and the request guard. A job line `jobLineProblem` keeps may be shorter.
 */
export function requestTextProblem(text: string): TextProblem | null {
  const value = text.trim();
  if (value.length < SETUP_REQUEST_MIN_LENGTH) return 'too_short';
  if (value.length > SETUP_TEXT_MAX_LENGTH) return 'too_long';
  return requestProblem(value);
}

/**
 * Why a job line can't be saved, or null when it can. A line in `keptLines` (the line the setup is
 * saved with, a copy's copied name) is kept whatever its length, down to `SETUP_JOB_LINE_MIN_LENGTH`,
 * and meets only the request guard; any other is new or changed and meets `requestTextProblem`.
 */
export function jobLineProblem(
  line: string,
  keptLines: readonly (string | null | undefined)[] = [],
): TextProblem | null {
  const value = line.trim();
  return keptLines.some((kept) => kept != null && value === kept.trim())
    ? requestProblem(value)
    : requestTextProblem(value);
}

/** What a text field says when it is shorter than `min` characters. */
export const tooShortMessage = (min: number) =>
  `Write at least ${min} character${min === 1 ? '' : 's'}.`;

/** What each request problem tells the person writing it. */
export const REQUEST_PROBLEM_MESSAGES: Record<RequestProblem, string> = {
  multiline: 'Write it on one line.',
  link: 'It holds a link or domain, which DevTune refuses in a request. Name the job without it.',
  code: 'It holds code characters or an environment reference, which DevTune refuses in a request. Describe the job in words.',
  variable:
    'It holds an environment variable name, which DevTune refuses in a request. Describe the job in words.',
};

/** What each problem of a request or job line tells the person writing it. */
export const TEXT_PROBLEM_MESSAGES: Record<TextProblem, string> = {
  too_short: tooShortMessage(SETUP_REQUEST_MIN_LENGTH),
  too_long: `Write at most ${SETUP_TEXT_MAX_LENGTH} characters.`,
  ...REQUEST_PROBLEM_MESSAGES,
};

/**
 * Whether the tools' `yieldsTo` loop back on themselves, through any number of tools, a tool
 * yielding to itself included. Keys of tools not in the list are ignored, as the classifier ignores
 * them.
 */
export function hasYieldsCycle(
  tools: readonly { toolKey: string; yieldsTo?: readonly string[] }[],
): boolean {
  const edges = new Map(
    tools.map((tool) => [tool.toolKey, tool.yieldsTo ?? []]),
  );
  const done = new Set<string>();
  const visiting = new Set<string>();
  const cycles = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (done.has(key) || !edges.has(key)) return false;
    visiting.add(key);
    const found = (edges.get(key) ?? []).some(cycles);
    visiting.delete(key);
    done.add(key);
    return found;
  };
  return tools.some((tool) => cycles(tool.toolKey));
}
