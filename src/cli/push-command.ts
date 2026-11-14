/**
 * ABOUTME: `agentpicks push [<setup>]`: saves a setup file to DevTune, or every file when none is
 * named, with the digest of the setup the file last saw, and records in the file the setup's id and
 * the digest DevTune answers with, the one its save committed. DevTune refuses a setup changed since as setup_changed, so push never overwrites it:
 * pull first. A file already in sync sends nothing.
 *
 * A retried push of a new file whose first answer was lost doesn't make a second setup: the job save
 * matches the job line, and the setup save the category, and the null digest a new file sends
 * makes DevTune refuse that existing setup as setup_changed. Push then reads it, and when saving the
 * file would send what it already holds (the first push landed), links the file to it.
 */
import { relative, resolve } from 'node:path';

import {
  findSetup,
  formatProblem,
  readSetupFile,
  readSetupFiles,
  setupsRoot,
  type SetupOnDisk,
} from '../setup/files';
import { canonical, devtuneSetupFile, syncState } from '../setup/link';
import type { SetupFile } from '../setup/schema';
import {
  saveDevtuneSetup,
  type DevtuneSetup,
  type DevtuneSetupList,
} from './devtune-setups';
import { UploadError, UsageError } from './errors';
import { detectStacks } from './init-detect';
import type { CliContext } from './main';
import { pushRequest, type PushRequest } from './push-payload';
import {
  orphanedMessage,
  readSetups,
  writeLink,
  type DevtuneSetups,
} from './setup-links';

export async function pushCommand(
  argv: string[],
  ctx: CliContext,
): Promise<number> {
  const flag = argv.find((arg) => arg.startsWith('-'));
  if (flag)
    throw new UsageError(`agentpicks push takes no flags, not ${flag}.`);
  if (argv.length > 1)
    throw new UsageError(
      `Name one setup to push, or none for every one, not ${argv.join(', ')}.`,
    );
  const files =
    argv.length === 1
      ? [readSetupFile(findSetup(argv[0]!, ctx.cwd))]
      : readSetupFiles(setupsRoot(ctx.cwd));
  if (files.length === 0)
    throw new UsageError(
      'There are no setup files to push. Write one, or pull a DevTune setup with agentpicks pull.',
    );
  const devtune = await readSetups(ctx);
  let failed = 0;
  for (const file of files) if (!(await pushOne(file, devtune, ctx))) failed++;
  return failed === 0 ? 0 : 1;
}

/** Pushes one file, printing what it did; resolves whether it did not refuse. */
async function pushOne(
  file: SetupOnDisk,
  devtune: DevtuneSetups,
  ctx: CliContext,
): Promise<boolean> {
  const shown = relative(ctx.cwd, file.path) || file.path;
  const content = file.content;
  if (!file.setup || !content) {
    for (const problem of file.problems)
      ctx.err(formatProblem(file.path, problem, ctx.cwd));
    ctx.err(`Fix ${shown}, then push it again.`);
    return false;
  }
  const current = content.id
    ? devtune.list.setups.find((setup) => setup.id === content.id)
    : null;
  if (content.id) {
    const state = syncState(content, current ?? undefined);
    if (state === 'orphaned') {
      ctx.err(orphanedMessage(shown, content.id));
      return false;
    }
    if (state === 'in_sync') {
      ctx.out(`${shown} is in sync with DevTune; nothing to push.`);
      return true;
    }
    if (state !== 'local_changed') {
      ctx.err(changedMessage(shown, file.name, state === 'both_changed'));
      return false;
    }
  }
  const repositoryStacks =
    !current && file.setup.repo
      ? detectStacks(resolve(file.root, file.setup.repo.path)).stacks
      : undefined;
  let saved: Awaited<ReturnType<typeof saveDevtuneSetup>>;
  try {
    const request = pushRequest(
      content,
      current ?? null,
      devtune.list,
      shown,
      repositoryStacks,
    );
    saved = await saveDevtuneSetup(devtune.target, request.route, request.body);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.err(error.message);
      return false;
    }
    if (!(error instanceof UploadError) || error.reason !== 'setup_changed')
      throw error;
    if (current) {
      ctx.err(changedMessage(shown, file.name, false));
      return false;
    }
    return linkExisting(file, content, ctx, shown, repositoryStacks);
  }
  if (!saved.setup)
    throw new UploadError(
      `DevTune saved ${shown} but didn't say which setup it saved. Run agentpicks list, then pull it.`,
    );
  // The digest the save committed: a read after it could already hold someone else's edit.
  writeLink(
    file.path,
    content,
    {
      id: saved.setup.id,
      setupDigest: saved.snapshotDigest,
    },
    (path) => relative(ctx.cwd, path) || path,
  );
  ctx.out(
    current
      ? `Pushed ${shown} to DevTune setup ${devtune.names.get(current.id)}.`
      : `Pushed ${shown} to DevTune, and linked ${shown} to the setup it saved.`,
  );
  return true;
}

function changedMessage(shown: string, name: string, both: boolean) {
  return both
    ? `${shown} and its DevTune setup both changed since the file last saw it (setup_changed). Copy your changes somewhere, run agentpicks pull ${name} --force, apply them again, then push.`
    : `The DevTune setup changed since ${shown} last saw it (setup_changed), so push didn't overwrite it. Run agentpicks pull ${name} to take DevTune's version, then push again.`;
}

/**
 * A new file DevTune refused because a setup for its job or category already exists: links the
 * file to that setup when it holds what the file says (an earlier push whose answer was lost),
 * else says how to bring the two together.
 */
async function linkExisting(
  file: SetupOnDisk,
  content: SetupFile,
  ctx: CliContext,
  shown: string,
  repositoryStacks: string[] | undefined,
): Promise<boolean> {
  const after = await readSetups(ctx);
  const existing = after.list.setups.find((setup) =>
    sameSubject(setup, content),
  );
  const mapped = existing
    ? devtuneSetupFile(existing, { repo: content.repo, runs: content.runs })
    : null;
  if (
    existing &&
    mapped &&
    'file' in mapped &&
    sameSave(content, mapped.file, existing, after.list, repositoryStacks)
  ) {
    writeLink(
      file.path,
      content,
      {
        id: existing.id,
        setupDigest: existing.snapshot_digest,
      },
      (path) => relative(ctx.cwd, path) || path,
    );
    ctx.out(
      `DevTune already holds ${shown} as setup ${after.names.get(existing.id)}; linked ${shown} to it.`,
    );
    return true;
  }
  const name = existing ? after.names.get(existing.id) : undefined;
  ctx.err(
    name
      ? `DevTune already has a setup for this ${content.from ? 'category' : 'job'}: ${name}, which this file isn't linked to. Run agentpicks pull ${name} to write it as a file, copy your changes into that file, and push it.`
      : `DevTune refused ${shown} as setup_changed: another save added its setup meanwhile. Run agentpicks list, and pull that setup.`,
  );
  return false;
}

/**
 * Whether saving `file` onto `existing` sends what saving DevTune's own setup as a file would: the
 * same content once the save's defaults are filled in, such as signal lists a file leaves empty or
 * out. A file push can't save is not the same.
 */
function sameSave(
  file: SetupFile,
  held: SetupFile,
  existing: DevtuneSetup,
  list: DevtuneSetupList,
  repositoryStacks: string[] | undefined,
) {
  try {
    const a = pushRequest(file, existing, list, '', repositoryStacks);
    const b = pushRequest(held, existing, list, '');
    // A setup's stacks are a set: DevTune lists them in its own order, which a file or detection needn't match.
    const content = ({ environment_ids: ids, ...body }: PushRequest['body']) =>
      canonical(
        saveContent({
          ...body,
          environment_ids: Array.isArray(ids) ? ids.toSorted() : ids,
        }),
      );
    return a.route === b.route && content(a.body) === content(b.body);
  } catch (error) {
    if (error instanceof UsageError) return false;
    throw error;
  }
}

/** A save body without what a save treats as unset: null, false, and empty lists and objects. */
function saveContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(saveContent);
  if (!value || typeof value !== 'object') return value;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const each = saveContent(field);
    const unset =
      each === null ||
      each === false ||
      (Array.isArray(each) && each.length === 0) ||
      (typeof each === 'object' &&
        each !== null &&
        Object.keys(each).length === 0);
    if (!unset) kept[key] = each;
  }
  return kept;
}

/** Whether a DevTune setup is the one a new file's save would land on: the same job line, or category. */
function sameSubject(setup: DevtuneSetup, content: SetupFile) {
  if (content.from) return setup.source_category_slug === content.from;
  return (
    setup.kind === 'job' &&
    setup.name.trim().toLowerCase() === content.job?.trim().toLowerCase()
  );
}
