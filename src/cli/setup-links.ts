/**
 * ABOUTME: What list, pull, push, run and upload share about linked setups: reading the project's
 * DevTune setups with their names, finding the one an argument names, writing a file's link back
 * into it, running a DevTune setup that has no file, and filing a linked setup's runs under its
 * DevTune setup, whose category slug the upload names so DevTune lists them on that setup. A run of
 * a linked file with changes not pushed asks what DevTune doesn't hold, so it files under nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseDocument } from 'yaml';

import { findCategoryRequests } from '../catalogue/categories';
import type { HeldTools } from '../setup/files';
import {
  devtuneSetupFile,
  devtuneSetupNames,
  fileDigest,
  hasOwnTools,
} from '../setup/link';
import { resolveSetup, type ResolvedSetup } from '../setup/resolve';
import type { SetupFile } from '../setup/schema';
import type { RunPlan } from './args';
import { devtuneTarget, type DevtuneTarget } from './devtune-login';
import {
  readDevtuneSetups,
  type DevtuneSetup,
  type DevtuneSetupList,
} from './devtune-setups';
import { NotLoggedInError, UsageError } from './errors';
import type { CliContext } from './main';
import { writeSetupText } from './setup-write';
import type { BundleOnDisk } from './upload';

export interface DevtuneSetups {
  target: DevtuneTarget;
  list: DevtuneSetupList;
  /** Each setup's name, by id. */
  names: Map<string, string>;
}

/** The project's DevTune setups, read with the saved login or key; refuses without one. */
export async function readSetups(
  ctx: CliContext,
  purpose: 'upload' | 'setups' = 'setups',
): Promise<DevtuneSetups> {
  const target = devtuneTarget(ctx.io, purpose);
  const list = await readDevtuneSetups(target);
  return { target, list, names: devtuneSetupNames(list.setups) };
}

/** The tools each DevTune setup holds, by id, for checking the files linked to them. */
export function heldTools(setups: DevtuneSetups): HeldTools {
  return (id) => setups.list.setups.find((setup) => setup.id === id)?.tools;
}

/** The DevTune setup `arg` names: by its name, its id or its category slug. */
export function findDevtuneSetup(setups: DevtuneSetups, arg: string) {
  return setups.list.setups.find(
    (setup) =>
      setups.names.get(setup.id) === arg ||
      setup.id === arg ||
      setup.category_slug === arg,
  );
}

/**
 * Records in the file at `path` the setup it is now linked to and what it saw: DevTune's snapshot
 * digest and the digest of `content`, the content saved. Edits only id and synced, keeping the
 * file's comments and layout. `shown` names a path in a refusal.
 */
export function writeLink(
  path: string,
  content: SetupFile,
  link: { id: string; setupDigest: string },
  shown: (path: string) => string,
) {
  const document = parseDocument(readFileSync(path, 'utf8'));
  document.set('id', link.id);
  document.set('synced', {
    setup: link.setupDigest,
    file: fileDigest(content),
  });
  writeSetupText(dirname(path), path, document.toString({ lineWidth: 0 }), {
    replace: true,
    shown,
  });
}

/** Says why a linked file's DevTune setup is gone, and the way out. */
export function orphanedMessage(shown: string, id: string) {
  return `${shown} is linked to DevTune setup ${id}, which the project no longer has. Remove id and synced from it to push it as a new setup, or delete the file.`;
}

/** A setup a run plans from: a file's, or a DevTune setup's with no file. */
export interface RunSetup {
  path: string;
  name: string;
  root: string;
  setup: ResolvedSetup;
}

/**
 * A DevTune setup `name` names, as a setup a run can plan from, when no file has that name: null
 * when there is no sign-in or no such setup, so the caller refuses as it would without DevTune.
 */
export async function devtuneRunSetup(
  name: string,
  root: string,
  ctx: CliContext,
): Promise<RunSetup | null> {
  let setups: DevtuneSetups;
  try {
    setups = await readSetups(ctx);
  } catch (error) {
    // Signed out: the run refuses as a missing file would.
    if (error instanceof NotLoggedInError) return null;
    throw error;
  }
  const setup = findDevtuneSetup(setups, name);
  return setup ? runSetupOf(setups, setup, root) : null;
}

/**
 * One of the project's DevTune setups as a setup a run can plan from; refuses one that can't run as
 * it stands, and one that asks an add request of its own (a job, or an edited copy): anyone who can
 * edit the setup in DevTune could write that request, and the agent runs it with this machine's keys,
 * so it runs only from a file on this machine.
 */
export function runSetupOf(
  setups: DevtuneSetups,
  setup: DevtuneSetup,
  root: string,
): RunSetup {
  const name = setups.names.get(setup.id)!;
  const shown = `DevTune setup ${name}`;
  const mapped = devtuneSetupFile(setup);
  if ('problem' in mapped) throw new UsageError(`${shown}: ${mapped.problem}`);
  const resolved = resolveSetup(
    name,
    { ...mapped.file, id: setup.id },
    setup.tools,
  );
  if (!('setup' in resolved))
    throw new UsageError(
      `${shown} can't run as it stands: ${resolved.problems.map((p) => `${p.field}: ${p.message}`).join(' ')} Pull it with agentpicks pull ${name}, fix the file, and run that.`,
    );
  const published = resolved.setup.from
    ? findCategoryRequests(resolved.setup.from)?.prompts[0].text
    : undefined;
  if (resolved.setup.request.text !== published)
    throw new UsageError(
      `${shown} asks its own add request, which agentpicks runs only from a setup file. Write it as a file with agentpicks pull ${name}, then run that file; commit it for a workflow to run.`,
    );
  return {
    path: shown,
    name: resolved.setup.name,
    root,
    setup: resolved.setup,
  };
}

/** Why a linked file's runs can't upload under its setup until it is pushed. */
function unpushedMessage(shown: string, name: string) {
  return `${shown} has changes not pushed to its DevTune setup, so its runs would ask what DevTune doesn't hold. Run agentpicks push ${name}, then run it again, or pass --no-upload to keep the bundles on this machine.`;
}

/** Whether a linked file says something DevTune's setup didn't hold when pull or push last saw it. */
function hasUnpushedChanges(content: SetupFile) {
  return !content.synced || fileDigest(content) !== content.synced.file;
}

/** Why a linked file's runs can't upload under its setup until it is pulled: DevTune changed the setup since. */
function devtuneChangedMessage(shown: string, name: string) {
  return `${shown}'s DevTune setup changed since the file last saw it, so its runs would ask what DevTune no longer holds. Run agentpicks pull ${name}, then run it again, or pass --no-upload to keep the bundles on this machine.`;
}

/** The DevTune setup a linked file's runs upload under, whose category slug files them on its series. */
async function linkedSetup(
  id: string,
  shown: string,
  ctx: CliContext,
): Promise<DevtuneSetup> {
  const setups = await readSetups(ctx, 'upload');
  const setup = setups.list.setups.find((each) => each.id === id);
  if (!setup) throw new UsageError(orphanedMessage(shown, id));
  return setup;
}

/**
 * The plan with each run uploading as its setup: a linked setup's (one with id) as its DevTune
 * setup's category, so its runs list on that setup. A custom setup with no id has no DevTune setup
 * to upload under, and a linked file with changes not pushed, or whose setup DevTune changed since
 * the file last saw it, asks what its setup doesn't hold, so each is refused before Docker; with
 * --no-upload, a run of changes not pushed records it in its bundles, and `upload` refuses them. A setup that is its category as published uploads as that category, as before.
 * `content` is the file's, absent for a DevTune setup run by name.
 */
export async function linkUploads(
  plan: RunPlan,
  setup: ResolvedSetup,
  content: SetupFile | undefined,
  shown: string,
  ctx: CliContext,
): Promise<RunPlan> {
  const unpushed =
    setup.id !== null && content !== undefined && hasUnpushedChanges(content);
  if (!plan.upload)
    return unpushed && plan.setup
      ? {
          ...plan,
          setup: {
            ...plan.setup,
            record: { ...plan.setup.record, unpushed: true },
          },
        }
      : plan;
  if (setup.id === null) {
    // Push can't save a copy's tools beyond its category's: they are added in the DevTune app.
    if (setup.customReason && content && hasOwnTools(content))
      throw new UsageError(
        `${shown} is a custom setup (${setup.customReason}), so its runs have no DevTune setup to upload under, and push can't save tools ${setup.from} doesn't have. Add them to a category copy in the DevTune app, run agentpicks pull, and run the pulled setup, or pass --no-upload to keep the bundles on this machine.`,
      );
    if (setup.customReason)
      throw new UsageError(
        `${shown} is a custom setup (${setup.customReason}), so its runs have no DevTune setup to upload under. Run agentpicks push ${setup.name} to save it to DevTune first, or pass --no-upload to keep the bundles on this machine.`,
      );
    return plan;
  }
  const linked = await linkedSetup(setup.id, shown, ctx);
  // The read linking does anyway says whether DevTune moved on since the file's pull or push.
  if (content?.synced && linked.snapshot_digest !== content.synced.setup)
    throw new UsageError(devtuneChangedMessage(shown, setup.name));
  if (unpushed) throw new UsageError(unpushedMessage(shown, setup.name));
  const slug = linked.category_slug;
  return {
    ...plan,
    tests: plan.tests.map((test) => ({
      ...test,
      category: { ...test.category, slug },
    })),
  };
}

/**
 * The bundle with its manifest naming its linked setup's category, for a bundle a linked setup
 * wrote with --no-upload, whatever category it recorded; null when the bundle names no DevTune
 * setup. Refuses a bundle whose run asked changes not pushed.
 */
export async function linkedBundle(
  bundle: BundleOnDisk,
  ctx: CliContext,
): Promise<BundleOnDisk | null> {
  const id = bundle.setup?.id;
  if (!id) return null;
  const shown = `${bundle.dir} (a run of ${bundle.setup!.name})`;
  if (bundle.setup!.unpushed)
    throw new UsageError(
      `${shown} ran with changes not pushed to its DevTune setup, so it can't file under it. Run agentpicks push ${bundle.setup!.name}, then run the setup again.`,
    );
  const slug = (await linkedSetup(id, shown, ctx)).category_slug;
  return {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      request: { ...bundle.manifest.request, category: slug },
    },
  };
}
