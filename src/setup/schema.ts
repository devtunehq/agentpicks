/**
 * ABOUTME: The setup file's format, `agentpicks/<name>.yaml`: what the app keeps per setup (the job
 * line, a request per intent, the customer's tool and competitors with the signals that recognise
 * each, stacks or the repository, agents and runs), plus `from`, a built-in category it inherits,
 * `id`, the DevTune setup it is linked to, and `synced`, what pull or push last saw. The zod schema parses a file and is the source of the
 * JSON Schema published as `schema/setup.v1.json`.
 */
import { RE2JS } from 're2js';
import { z } from 'zod';

import { CATEGORY_REQUESTS } from '../catalogue/categories';
import { ENVIRONMENTS, isRetiredEnvironment } from '../catalogue/environments';
import { SELF_RUN_AGENTS } from '../cli/self-run-agents';

/** The agents a setup can name, by the name `--agent` takes first. */
export const SETUP_AGENTS = SELF_RUN_AGENTS.map(
  (agent) => agent.aliases[0]!,
) as [string, ...string[]];

/** The longest job line and request, as the app saves them. */
export const SETUP_TEXT_MAX_LENGTH = 300;

/** The shortest request the app saves. */
export const SETUP_REQUEST_MIN_LENGTH = 8;

/** The longest pattern the app saves. */
export const SETUP_PATTERN_MAX_LENGTH = 200;

/** The most tools with their own signals a setup holds, as a job in the app does. */
export const SETUP_MAX_OWN_SIGNAL_TOOLS = 7;

/**
 * A package name the sandbox's early-stop watcher can carry in a single-quoted shell string (no
 * quotes, spaces, `$` or backticks), with a letter or digit, so a prefix (`@acme/`, `acme*`) still
 * names something.
 */
const PACKAGE_NAME = /^[A-Za-z0-9@._/:*-]*[A-Za-z0-9][A-Za-z0-9@._/:*-]*$/;

/** A SHA-256 digest in hex, as DevTune's setup snapshot digest and a file's content digest are. */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, {
  message: 'agentpicks writes this digest. Pull the setup again to restore it.',
});

/** A config name the watcher can carry, which `grep` never reads as an option: no leading `-`. */
const CONFIG_NAME = /^[A-Za-z0-9@._/:*][A-Za-z0-9@._/:*-]*$/;

const text = (min: number) =>
  z
    .string({ error: 'Write it as one line of text.' })
    .trim()
    .min(min, {
      message: `Write at least ${min} character${min === 1 ? '' : 's'}.`,
    })
    .max(SETUP_TEXT_MAX_LENGTH)
    .regex(/^[^\n\r]+$/, { message: 'Write it on one line.' });

const line = text(1);
const request = text(SETUP_REQUEST_MIN_LENGTH);

const toolKey = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, {
    message:
      'A tool key is lowercase letters and digits, joined by -, _ or . (such as sentry or my-tool).',
  });

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, {
    message: 'Give a bare domain, such as example.com.',
  });

const packageNames = z
  .array(
    z.string().trim().min(1).max(214).regex(PACKAGE_NAME, {
      message:
        'A package name holds a letter or digit, and no spaces, quotes, $ or backticks. End it with / or * to match a prefix.',
    }),
  )
  .max(40);

const pattern = z
  .string()
  .min(1)
  .max(SETUP_PATTERN_MAX_LENGTH)
  .refine(compiles, {
    message:
      "This pattern doesn't compile on RE2, which has no lookarounds or backreferences. Rewrite it.",
  });

function compiles(source: string): boolean {
  try {
    RE2JS.compile(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * How a tool is recognised, in the shape of the catalogue's tool signals. A run's early stop reads
 * the package and config names; DevTune's classifier reads the rest.
 */
export const toolSignalsSchema = z
  .object({
    packages: z
      .object({
        npm: packageNames.optional(),
        pypi: packageNames.optional(),
        gem: packageNames.optional(),
      })
      .strict()
      .optional(),
    configNames: z
      .array(
        z.string().trim().min(2).max(100).regex(CONFIG_NAME, {
          message:
            "A config name holds no spaces, quotes, $ or backticks, and doesn't start with -.",
        }),
      )
      .max(30)
      .optional(),
    importPatterns: z.array(pattern).max(20).optional(),
    brandDomains: z.array(domain).max(10).optional(),
    aliases: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    commandPatterns: z.array(pattern).max(10).optional(),
    configFiles: z.array(pattern).max(10).optional(),
    configPatterns: z.array(pattern).max(10).optional(),
    selfHosted: z.array(pattern).max(10).optional(),
    frameworkBuiltIn: z.boolean().optional(),
    yieldsTo: z.array(toolKey).max(40).optional(),
    receivesFrom: z.array(toolKey).max(40).optional(),
  })
  .strict();

/** A tool with its own signals, for a tool the catalogue doesn't hold or one recognised differently. */
export const toolEntrySchema = z
  .object({
    key: toolKey,
    name: z.string().trim().min(1).max(100),
    domain: domain.optional(),
    signals: toolSignalsSchema,
  })
  .strict();

export type SetupToolEntry = z.infer<typeof toolEntrySchema>;

/** A tool of DevTune's catalogue by key, or a full entry. */
const toolRef = z.union([toolKey, toolEntrySchema]);

export type SetupToolRef = z.infer<typeof toolRef>;

const stackSlugs = ENVIRONMENTS.map((env) => env.slug).filter(
  (slug) => !isRetiredEnvironment(slug),
) as [string, ...string[]];

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
        competitors: z.array(toolRef).max(40).optional(),
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
