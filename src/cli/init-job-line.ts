/**
 * ABOUTME: The questions of an `agentpicks init` setup whose job is a line of its own: its
 * requests and its tools with their signals, drafted by DevTune and offered as defaults when
 * signed in (`init-draft.ts`), else typed. None has a flag. Under `--yes`, a setup that fails its
 * checks refuses; on a terminal it is asked again.
 */
import { join } from 'node:path';

import { stringify } from 'yaml';

import { checkSetupText, SETUPS_DIR } from '../setup/files';
import {
  SETUP_MAX_COMPETITORS,
  SETUP_REQUEST_MIN_LENGTH,
  SETUP_TEXT_MAX_LENGTH,
} from '../setup/rules';
import type { SetupFile, SetupToolEntry } from '../setup/schema';
import { UsageError } from './errors';
import type { JobDraft } from './init-draft';
import { ask, badLength, entries, slug, type Wizard } from './init-wizard';

const INTENTS = ['add', 'recommend', 'hosted'] as const;

/**
 * A job line's requests and tools: drafted by DevTune and offered as defaults when signed in, else
 * typed. Asked again until the setup passes its checks, since a run needs the add request and a
 * tool it can recognise by a package.
 */
export async function askCustomJob(
  wizard: Wizard,
  line: string,
): Promise<SetupFile> {
  const drafted = (await wizard.drafting?.job(line)) ?? null;
  const toolDrafts = new Map<string, SetupToolEntry | null>();
  for (;;) {
    const file: SetupFile = { job: line, requests: {} };
    for (const intent of INTENTS) {
      const request = await askRequest(wizard, intent, drafted);
      if (request) file.requests![intent] = request;
    }
    const own = await askOwnTool(wizard, line, toolDrafts);
    const competitors = await askCompetitors(
      wizard,
      line,
      drafted,
      own,
      toolDrafts,
    );
    file.tools = {
      ...(own ? { own } : {}),
      ...(competitors.length > 0 ? { competitors } : {}),
    };
    const checked = checkSetupText(
      join(wizard.detected.root, SETUPS_DIR, 'init.yaml'),
      stringify(file),
    );
    if (checked.problems.length === 0) return file;
    const problems = checked.problems.map(
      (problem) => `${problem.field}: ${problem.message}`,
    );
    // Asking again under --yes would take the same answers forever.
    if (wizard.yes)
      throw new UsageError(
        `${problems.join('\n')}\nRun agentpicks init on a terminal to answer the requests and tools, or write the setup against agentpicks schema.`,
      );
    for (const problem of problems) wizard.err(problem);
    wizard.err('Answer the requests and tools again.');
  }
}

async function askRequest(
  wizard: Wizard,
  intent: (typeof INTENTS)[number],
  drafted: JobDraft | null,
): Promise<string | null> {
  const draft = drafted?.requests.find((r) => r.intent === intent)?.text;
  // push saves a job with its add and recommend requests, so both are asked for; hosted is optional.
  const optional = intent === 'hosted';
  return ask<string | null>(wizard, {
    label:
      intent === 'add'
        ? 'The add request, which a run asks'
        : intent === 'recommend'
          ? 'The recommend request, which DevTune saves with the add request'
          : `The ${intent} request, or none`,
    fallback: draft ?? (optional ? 'none' : null),
    read: (answer) => {
      if (answer === 'none' && optional) return { value: null };
      return !badLength(answer)
        ? { value: answer }
        : {
            problem: `Write the ${intent} request in ${SETUP_REQUEST_MIN_LENGTH} to ${SETUP_TEXT_MAX_LENGTH} characters${optional ? ', or none' : ''}.`,
          };
    },
  });
}

/** The customer's own tool with its signals, or null for none. */
async function askOwnTool(
  wizard: Wizard,
  job: string,
  toolDrafts: Map<string, SetupToolEntry | null>,
): Promise<SetupToolEntry | null> {
  const { packageName, tool } = wizard.detected;
  const name = await ask<string | null>(wizard, {
    label: "Your tool's name, or none",
    fallback: tool?.key ?? packageName?.replace(/^@[^/]+\//, '') ?? 'none',
    read: (answer) =>
      answer === 'none'
        ? { value: null }
        : answer.length <= 100
          ? { value: answer }
          : { problem: 'Give a name of up to 100 characters.' },
  });
  if (name === null) return null;
  return toolWithSignals(
    wizard,
    { key: slug(name), name, domain: null },
    job,
    [],
    toolDrafts,
    // The repository's own package installs the customer's tool when the name came from it.
    packageName && name === packageName.replace(/^@[^/]+\//, '')
      ? packageName
      : null,
  );
}

/**
 * Competitors with their signals: by name, drafted through DevTune, while drafting is on; else by
 * the npm packages that install them.
 */
async function askCompetitors(
  wizard: Wizard,
  job: string,
  drafted: JobDraft | null,
  own: SetupToolEntry | null,
  toolDrafts: Map<string, SetupToolEntry | null>,
): Promise<SetupToolEntry[]> {
  const room = SETUP_MAX_COMPETITORS;
  const tooMany = `List at most ${room}: a setup tracks up to ${room} competitors.`;
  if (drafted) {
    const names = await ask<string[]>(wizard, {
      label: "Competitors' names separated by commas, or none",
      fallback:
        drafted.competitors
          .slice(0, room)
          .map((c) => c.name)
          .join(', ') || 'none',
      read: (answer) => {
        const chosen = answer === 'none' ? [] : [...new Set(entries(answer))];
        return chosen.length > room ? { problem: tooMany } : { value: chosen };
      },
    });
    const others = [
      ...(own ? [own] : []),
      ...names.map((name) => ({ key: slug(name), name })),
    ];
    const tools: SetupToolEntry[] = [];
    for (const name of names) {
      const key = slug(name);
      const domain =
        drafted.competitors.find((c) => c.name === name)?.domain ?? null;
      const tool = await toolWithSignals(
        wizard,
        { key, name, domain },
        job,
        others.filter((other) => other.key !== key),
        toolDrafts,
        null,
      );
      if (tool) tools.push(tool);
    }
    return tools;
  }
  const packages = await ask<string[]>(wizard, {
    label: "Competitors' npm packages separated by commas, or none",
    fallback: 'none',
    read: (answer) => {
      const chosen = answer === 'none' ? [] : [...new Set(entries(answer))];
      return chosen.length > room ? { problem: tooMany } : { value: chosen };
    },
  });
  return packages.map((name) => ({
    key: slug(name),
    name,
    signals: { packages: { npm: [name] } },
  }));
}

/**
 * The tool with its signals: drafted through DevTune while drafting is on, else the npm packages
 * the customer gives (`detected` the default). Null when it has none, since a run couldn't
 * recognise it; the setup's checks then say what's missing.
 */
async function toolWithSignals(
  wizard: Wizard,
  tool: { key: string; name: string; domain: string | null },
  job: string,
  others: { key: string; name: string }[],
  toolDrafts: Map<string, SetupToolEntry | null>,
  detected: string | null,
): Promise<SetupToolEntry | null> {
  if (wizard.drafting && !toolDrafts.has(tool.key))
    toolDrafts.set(tool.key, await wizard.drafting.tool(tool, job, others));
  const drafted = toolDrafts.get(tool.key);
  if (drafted) return drafted;
  const packages = await ask<string[]>(wizard, {
    label: `${tool.name}'s npm packages separated by commas, or none`,
    fallback: detected ?? 'none',
    read: (answer) => ({
      value: answer === 'none' ? [] : [...new Set(entries(answer))],
    }),
  });
  if (packages.length === 0) return null;
  return {
    key: tool.key,
    name: tool.name,
    ...(tool.domain ? { domain: tool.domain } : {}),
    signals: { packages: { npm: packages } },
  };
}
