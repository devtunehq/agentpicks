/**
 * ABOUTME: What `run --category <slug>` runs when it uploads: the project's own copy of the category,
 * planned as `run <copy-name>` plans it with the same flags, so its runs file on the copy's series.
 * A project with no copy gets one first through the setup save, as the app's Start from a category
 * makes one, with the category's default stacks and the run's agent. A copy another save made meanwhile
 * (category_in_use, or setup_changed for the null digest a new setup sends) is run instead. Any other
 * refusal stops the run with its fix; it never falls back to the public category. A copy that asks an
 * add request of its own is refused, as `run <name>` refuses it (`runSetupOf`).
 */
import { isSelectedByDefault } from '../catalogue/environments';
import { setupsRoot } from '../setup/files';
import { nameableStack } from '../setup/link';
import { setupPlan, type RunArgs, type RunPlan } from './args';
import { saveDevtuneSetup } from './devtune-setups';
import { chooseAgent } from './discover';
import { UploadError, UsageError } from './errors';
import type { CliContext } from './main';
import { pushRequest } from './push-payload';
import { SELF_RUN_AGENTS } from './self-run-agents';
import {
  linkUploads,
  readSetups,
  runSetupOf,
  type DevtuneSetups,
} from './setup-links';

/** The plan for `run --category` with upload on: the project's copy of the category, made first when it has none. */
export async function categoryCopyPlan(
  args: RunArgs,
  ctx: CliContext,
): Promise<RunPlan> {
  const slug = args.category;
  let setups = await refusable(`reading the project's setups`, () =>
    readSetups(ctx, 'upload'),
  );
  let copy = projectCopy(setups, slug, ctx);
  if (!copy) {
    const created = await createCopy(setups, args, ctx);
    setups = await refusable(`reading the project's setups`, () =>
      readSetups(ctx, 'upload'),
    );
    copy = created?.id
      ? setups.list.setups.find((setup) => setup.id === created.id)
      : projectCopy(setups, slug, ctx);
    if (!copy)
      throw new UsageError(
        `DevTune made no copy of ${slug} that agentpicks can find. Run agentpicks list to see the project's setups, or pass --no-upload to keep the bundles on this machine.`,
      );
    const name = setups.names.get(copy.id)!;
    ctx.out(
      created
        ? `Created the project's copy of ${slug}, DevTune setup ${name}. Write it as a file with: agentpicks pull ${name}`
        : `Another save made the project's copy of ${slug} meanwhile, DevTune setup ${name}.`,
    );
  }
  const run = runSetupOf(setups, copy, setupsRoot(ctx.cwd));
  ctx.out(
    `Runs the project's setup of ${slug}, DevTune setup ${setups.names.get(copy.id)}, and uploads under it.`,
  );
  const { category: _category, ...flags } = args;
  return linkUploads(
    setupPlan(run, flags, ctx.cwd),
    run.setup,
    undefined,
    run.path,
    ctx,
  );
}

/**
 * The project's copy of the category `slug`, or its setup saved on the category itself: of several,
 * the one named the slug, else the first listed, saying which; undefined when it has none.
 */
function projectCopy(setups: DevtuneSetups, slug: string, ctx: CliContext) {
  // A setup saved on the public category itself (kind category) is the project's setup of it too.
  const copies = setups.list.setups.filter(
    (setup) =>
      (setup.kind === 'copy' || setup.kind === 'category') &&
      setup.source_category_slug === slug,
  );
  if (copies.length < 2) return copies[0];
  const copy =
    copies.find((setup) => setups.names.get(setup.id) === slug) ?? copies[0]!;
  ctx.out(
    `The project has ${copies.length} setups of ${slug}: ${copies.map((setup) => setups.names.get(setup.id)).join(', ')}. Running ${setups.names.get(copy.id)}.`,
  );
  return copy;
}

/**
 * Saves a new copy of the category with its default stacks DevTune lists, as the app's Start from a
 * category ticks them, and the agent the run uses,
 * resolving to the setup it saved (its id, when DevTune names it); null when another save made the
 * project's copy first.
 */
async function createCopy(
  setups: DevtuneSetups,
  args: RunArgs,
  ctx: CliContext,
): Promise<{ id: string | undefined } | null> {
  const slug = args.category;
  if (!setups.list.catalogue.categories.some((each) => each.slug === slug))
    throw new UsageError(
      `DevTune hasn't published ${slug}, so the project can't have a copy of it to upload under. Choose another category, or pass --no-upload to keep the bundles on this machine.`,
    );
  const { kind } = chooseAgent(ctx.io, { agent: args.agent });
  // A setup file names an agent by its first alias.
  const agent = SELF_RUN_AGENTS.find((each) => each.kind === kind)!.aliases[0]!;
  const request = pushRequest(
    {
      from: slug,
      stacks: setups.list.catalogue.environments
        .map((env) => env.slug)
        .filter(
          (stack) => nameableStack(stack, slug) && isSelectedByDefault(stack),
        ),
      agents: [agent],
    },
    null,
    setups.list,
    `The project's copy of ${slug}`,
  );
  try {
    const saved = await saveDevtuneSetup(
      setups.target,
      request.route,
      request.body,
    );
    return { id: saved.setup?.id };
  } catch (error) {
    if (
      error instanceof UploadError &&
      (error.reason === 'category_in_use' || error.reason === 'setup_changed')
    )
      return null;
    throw refusal(`creating the project's copy of ${slug}`, error);
  }
}

/** The call, with a refusal from DevTune as a UsageError naming what it stopped and the fix. */
async function refusable<T>(step: string, call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    throw refusal(step, error);
  }
}

function refusal(step: string, error: unknown) {
  if (!(error instanceof UploadError) || error.transient) return error;
  return new UsageError(
    `A --category run uploads under the project's own copy of the category, and DevTune refused ${step}: ${error.message.replace(/\.?$/, '.')}${fix(error)} Or pass --no-upload to keep the bundles on this machine.`,
  );
}

/** How to clear a refusal DevTune's message doesn't already say how to clear. */
function fix(error: UploadError) {
  if (error.reason === 'agent_not_in_plan')
    return ' Choose an agent the plan includes with --agent.';
  if (error.message.startsWith('API key scope does not allow'))
    return ' Use a project API key with that scope, or run agentpicks login.';
  if (error.message.startsWith('Managing this project is required'))
    return " The signed-in member, or the API key's creator, needs DevTune management permission on the account and edit rights on the project.";
  if (error.message.startsWith('Agent Picks is not available'))
    return " The account's plan doesn't include Agent Picks; choose a plan that does.";
  return '';
}
