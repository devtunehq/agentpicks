/**
 * ABOUTME: The setup rules that need RE2: whether a pattern compiles and is short enough, the pattern
 * field, and a tool's signal fields, whose patterns use it. The rest of the setup rules are
 * `rules.ts`'s, which client code loads without RE2.
 */
import { RE2JS } from 're2js';
import { z } from 'zod';

import {
  configNameSchema,
  domainSchema,
  packageNameSchema,
  PATTERN_MESSAGE,
  type ReviewedSignal,
  SETUP_MAX_RECORDED_TOOLS,
  SETUP_PATTERN_MAX_LENGTH,
  SETUP_PATTERN_MIN_LENGTH,
  SIGNAL_LIST_LIMITS,
  signalFormat,
  toolKeySchema,
  toolNameSchema,
} from './rules';

/** Why a pattern can't be kept, or null when it can: it must be short and compile on RE2. */
export function patternProblem(source: string): 'too_long' | 'invalid' | null {
  if (source.length > SETUP_PATTERN_MAX_LENGTH) return 'too_long';
  try {
    RE2JS.compile(source);
    return null;
  } catch {
    return 'invalid';
  }
}

/** A pattern field; `reviewed` as `signalFormat`. */
export function patternSchema(reviewed?: ReviewedSignal) {
  return signalFormat(
    // The length is checked here, so a long pattern reads one problem.
    z
      .string()
      .min(SETUP_PATTERN_MIN_LENGTH, { message: PATTERN_MESSAGE })
      .max(SETUP_PATTERN_MAX_LENGTH, { message: PATTERN_MESSAGE }),
    'pattern',
    (source) => patternProblem(source) !== 'invalid',
    PATTERN_MESSAGE,
    reviewed,
  );
}

/**
 * A tool's signal fields with their formats and limits, in the catalogue's shape. A run's early stop
 * reads the package and config names; DevTune's classifier reads the rest. `reviewed` as
 * `signalFormat`.
 */
export function toolSignalFields(reviewed?: ReviewedSignal) {
  const max = SIGNAL_LIST_LIMITS;
  const pattern = patternSchema(reviewed);
  const packageNames = z.array(packageNameSchema).max(max.packages);
  const patterns = (limit: number) => z.array(pattern).max(limit);
  const relations = z.array(toolKeySchema).max(SETUP_MAX_RECORDED_TOOLS);
  return {
    packages: z
      .object({
        npm: packageNames.optional(),
        pypi: packageNames.optional(),
        gem: packageNames.optional(),
      })
      .strict(),
    configNames: z.array(configNameSchema(reviewed)).max(max.configNames),
    importPatterns: patterns(max.importPatterns),
    brandDomains: z.array(domainSchema).max(max.brandDomains),
    aliases: z.array(toolNameSchema).max(max.aliases).optional(),
    commandPatterns: patterns(max.commandPatterns).optional(),
    // Config files, config patterns and self-run servers, as a CI category's tools carry them.
    configFiles: patterns(max.configFiles).optional(),
    configPatterns: patterns(max.configPatterns).optional(),
    selfHosted: patterns(max.selfHosted).optional(),
    frameworkBuiltIn: z.boolean().optional(),
    // At most one per other tool the setup holds.
    yieldsTo: relations.optional(),
    receivesFrom: relations.optional(),
  };
}
