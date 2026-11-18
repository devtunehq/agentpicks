/**
 * ABOUTME: The setup file's format, `agentpicks/<name>.yaml`: what the app keeps per setup (the job
 * line, a request per intent, the customer's tool and competitors with the signals that recognise
 * each, stacks or the repository, agents and runs), plus `from`, a built-in category it inherits,
 * `id`, the DevTune setup it is linked to, and `synced`, what pull or push last saw. The zod schema parses a file and is the source of the
 * JSON Schema published as `schema/setup.v1.json`.
 */
import { z } from 'zod';

import { CATEGORY_REQUESTS } from '../catalogue/categories';
import { activeEnvironments } from '../catalogue/environments';
import { SELF_RUN_AGENTS } from '../cli/self-run-agents';
import { toolSignalFields } from './pattern-rules';
import {
  domainSchema,
  ONE_LINE,
  REQUEST_PROBLEM_MESSAGES,
  SETUP_JOB_LINE_MIN_LENGTH,
  SETUP_MAX_RECORDED_TOOLS,
  SETUP_REQUEST_MIN_LENGTH,
  SETUP_TEXT_MAX_LENGTH,
  TEXT_PROBLEM_MESSAGES,
  toolKeySchema,
  toolNameSchema,
  tooShortMessage,
} from './rules';

/** The agents a setup can name, by the name `--agent` takes first. */
export const SETUP_AGENTS = SELF_RUN_AGENTS.map(
  (agent) => agent.aliases[0]!,
) as [string, ...string[]];

/** A SHA-256 digest in hex, as DevTune's setup snapshot digest and a file's content digest are. */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, {
  message: 'agentpicks writes this digest. Pull the setup again to restore it.',
});

/** One line of text, at least `min` characters; the request guard is `resolveSetup`'s, to name the field it refuses. */
const text = (min: number) =>
  z
    .string({ error: 'Write it as one line of text.' })
    .trim()
    .min(min, { message: tooShortMessage(min) })
    .max(SETUP_TEXT_MAX_LENGTH, { message: TEXT_PROBLEM_MESSAGES.too_long })
    .regex(ONE_LINE, { message: REQUEST_PROBLEM_MESSAGES.multiline });

const line = text(SETUP_JOB_LINE_MIN_LENGTH);
const request = text(SETUP_REQUEST_MIN_LENGTH);

const signalFields = toolSignalFields();

/**
 * How a tool is recognised, in the shape of the catalogue's tool signals, every field optional. A
 * tool may give only a name, aliases and brand domains.
 */
export const toolSignalsSchema = z
  .object({
    ...signalFields,
    packages: signalFields.packages.optional(),
    configNames: signalFields.configNames.optional(),
    importPatterns: signalFields.importPatterns.optional(),
    brandDomains: signalFields.brandDomains.optional(),
  })
  .strict();

/** A tool with its own signals, for a tool the catalogue doesn't hold or one recognised differently. */
export const toolEntrySchema = z
  .object({
    key: toolKeySchema,
    name: toolNameSchema,
    domain: domainSchema.optional(),
    signals: toolSignalsSchema,
  })
  .strict();

export type SetupToolEntry = z.infer<typeof toolEntrySchema>;

/** A tool of DevTune's catalogue by key, or a full entry. */
const toolRef = z.union([toolKeySchema, toolEntrySchema]);

export type SetupToolRef = z.infer<typeof toolRef>;

const stackSlugs = activeEnvironments().map((env) => env.slug) as [
  string,
  ...string[],
];

const categorySlugs = CATEGORY_REQUESTS.map((c) => c.slug) as [
  string,
  ...string[],
];

export const setupFileSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('The DevTune setup this file is linked to.'),
    synced: z
      .object({
        setup: sha256,
        file: sha256,
      })
      .strict()
      .optional()
      .describe(
        "What agentpicks pull or push last saw: the DevTune setup's snapshot digest (setup) and this file's content digest (file). agentpicks writes it; leave it as it is.",
      ),
    from: z
      .enum(categorySlugs, {
        error: `Use a built-in category: ${categorySlugs.join(', ')}.`,
      })
      .optional()
      .describe(
        'A built-in category whose job, requests and tools the setup inherits.',
      ),
    job: line
      .optional()
      .describe(
        'The job line, which labels the setup; a run asks requests.add. Required without from.',
      ),
    requests: z
      .object({
        add: request.nullable().optional(),
        recommend: request.nullable().optional(),
        hosted: request.nullable().optional(),
        improve: request.nullable().optional(),
      })
      .strict()
      .optional()
      .describe(
        "One request per intent. A run asks the add request, which a setup without from must give. With from, null leaves out the category's request of that intent.",
      ),
    tools: z
      .object({
        own: toolRef.optional(),
        competitors: z.array(toolRef).max(SETUP_MAX_RECORDED_TOOLS).optional(),
      })
      .strict()
      .optional()
      .describe(
        "Your tool and its competitors: the key of a tool in DevTune's catalogue (such as sentry), or a full entry with key, name and signals, and optionally domain.",
      ),
    stacks: z
      .array(
        z.enum(stackSlugs, {
          error: `Use a stack: ${stackSlugs.join(', ')}.`,
        }),
      )
      .min(1)
      .max(20)
      .optional()
      .describe('Starter apps to test in. Give stacks or repo, not both.'),
    repo: z
      .union([
        z.string().min(1),
        z
          .object({
            path: z.string().min(1),
            ref: z.string().min(1).optional(),
          })
          .strict(),
      ])
      .optional()
      .describe(
        'Your repository, relative to the repository root this file is in, in place of stacks: a path, or a path and a commit (ref).',
      ),
    agents: z
      .array(
        z.enum(SETUP_AGENTS, {
          error: `Use an agent: ${SETUP_AGENTS.join(', ')}.`,
        }),
      )
      .min(1)
      .max(4)
      .optional()
      .describe(
        'The agents to test, each installed on the machine that runs it. Without agents, the one installed agent runs.',
      ),
    runs: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many runs per agent and stack. Default 1.'),
  })
  .strict();

export type SetupFile = z.infer<typeof setupFileSchema>;

/** The JSON Schema editors and CI validate a setup file with; `schema/setup.v1.json` holds it. */
export function setupJsonSchema() {
  return {
    ...z.toJSONSchema(setupFileSchema, { io: 'input' }),
    title: 'Agent Picks setup',
    description:
      'What agentpicks run tests: a job, its requests, your tool and its competitors, stacks or your repository, agents and runs. See https://www.npmjs.com/package/@devtune/agentpicks.',
  };
}
