/**
 * ABOUTME: `agentpicks login`, by browser sign-in or by a project API key read from standard
 * input, and the live check `run` and `upload` make of a saved sign-in before they start.
 */
import { z } from 'zod';

import { parseLoginArgs } from './args';
import {
  apiBaseUrl,
  assertApiKey,
  loginPath,
  readSecretLine,
  saveLogin,
  withLoginLock,
  type DevtuneTarget,
} from './devtune-login';
import { NotLoggedInError, UploadError, UsageError } from './errors';
import type { CliContext } from './main';
import { AGENTPICKS_SCOPES, browserLogin, openBrowser } from './oauth';
import { discoverProject } from './upload';

/**
 * Asks DevTune, before anything runs or uploads, what a saved sign-in may do now, renewing it
 * first if it has expired: one revoked, or without agent_picks.run (a role that doesn't allow it,
 * or a paused project), is refused. A renewal whose answer was lost is refused too. When DevTune
 * can't be reached or answers with a status a retry may pass (`isTransientStatus`), it warns and
 * carries on, so bundles are still written and kept, and the upload checks again. A sign-in
 * revoked later, during a long run, is refused at upload. A key needs nothing. With `quiet`, a
 * caller whose next DevTune read refuses a sign-in no longer valid carries on without the warning;
 * agent_picks.run is then checked at upload.
 */
export async function assertSignedIn(
  target: DevtuneTarget,
  ctx: CliContext,
  { quiet = false }: { quiet?: boolean } = {},
) {
  if (!('session' in target)) return;
  let connection;
  try {
    connection = await discoverProject(target);
  } catch (error) {
    if (!(error instanceof UploadError && error.transient)) throw error;
    if (quiet) return;
    ctx.err(
      `Couldn't check the DevTune sign-in before starting; uploading checks it again. ${error.message}`,
    );
    return;
  }
  if (!connection.scopes.includes('agent_picks.run'))
    throw new NotLoggedInError(
      `This sign-in can't upload runs to ${connection.project.name} now: it lacks the agent_picks.run scope. Your role on the project doesn't allow it, the project is paused, or it was unselected when you signed in. Run agentpicks login again once it can be granted, or ask an account owner for access. To keep bundles on this machine only, pass --no-upload.`,
    );
}

export async function loginCommand(
  argv: string[],
  ctx: CliContext,
): Promise<number> {
  const args = parseLoginArgs(argv);
  const baseUrl = apiBaseUrl(ctx.io.env);
  const path = loginPath(ctx.io);
  if (args.apiKey) {
    await apiKeyLogin(args.project, baseUrl, path, ctx);
    await ctx.logo?.();
    ctx.out(`Saved to ${path}. run and upload send bundles to this project.`);
    if (ctx.io.env.DEVTUNE_API_KEY || ctx.io.env.DEVTUNE_PROJECT_ID)
      ctx.out(
        'DEVTUNE_API_KEY or DEVTUNE_PROJECT_ID is set here, and overrides this login.',
      );
    return 0;
  }
  // The browser sign-in never reads standard input; a key piped to it is the likelier intent.
  if (!ctx.stdinIsTerminal)
    ctx.err('To save a key from standard input, pass --api-key.');
  // The login can be saved and locked here: checked before consent, so a refusal leaves no grant.
  await withLoginLock(path, async () => undefined);
  {
    const { project, scopes } = await browserLogin({
      baseUrl,
      notify: (url) =>
        ctx.out(
          `Open this address in a browser to sign in and choose your project:\n${url}`,
        ),
      openBrowser: args.noBrowser ? null : (ctx.openBrowser ?? openBrowser),
      browserUnavailable: () =>
        ctx.out(
          "Couldn't open a browser. Open the address above in a browser on this machine.",
        ),
      save: (session) => withLoginLock(path, () => saveLogin(path, session)),
    });
    await ctx.logo?.();
    ctx.out(`Signed in to ${project.name} (${project.id}).`);
    ctx.out(`Granted: ${[...scopes].sort().join(', ')}.`);
    const missing = AGENTPICKS_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length > 0)
      ctx.out(
        `Not granted: ${missing.join(', ')}. Run agentpicks login again and keep ${missing.length === 1 ? 'it' : 'them'} selected; if DevTune doesn't offer ${missing.length === 1 ? 'it' : 'them'}, ask an account owner for access.`,
      );
    ctx.out(
      scopes.includes('agent_picks.run')
        ? `Saved to ${path}. run and upload send bundles to this project.`
        : `Saved to ${path}. Uploading needs agent_picks.run, so run and upload refuse until a sign-in holds it.`,
    );
    if (ctx.io.env.DEVTUNE_API_KEY)
      ctx.out('DEVTUNE_API_KEY is set here, and overrides this sign-in.');
    else if (ctx.io.env.DEVTUNE_PROJECT_ID)
      ctx.out(
        `DEVTUNE_PROJECT_ID is set here: run and upload refuse it unless it is ${project.id}.`,
      );
  }
  return 0;
}

/** `login --api-key`: saves the key read from standard input, and the project DevTune says it belongs to. */
async function apiKeyLogin(
  project: string | undefined,
  baseUrl: string,
  path: string,
  ctx: CliContext,
) {
  const apiKey = (
    await (ctx.readSecret ?? readSecretLine)('DevTune project API key: ')
  ).trim();
  assertApiKey(apiKey, 'The key read from standard input');
  if (project !== undefined && !z.uuid().safeParse(project).success)
    throw new UsageError(`--project takes a project id, not ${project}.`);
  let projectId = project;
  if (projectId === undefined) {
    let connection;
    try {
      connection = await discoverProject({ baseUrl, apiKey });
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      throw new UploadError(
        `${error.message} To save the key without checking it, pass --project <project id>.`,
      );
    }
    if (!connection.scopes.includes('agent_picks.run'))
      throw new UsageError(
        `This key can't upload runs to ${connection.project.name}: it needs the Agent Picks Run scope.`,
      );
    projectId = connection.project.id;
    ctx.out(`The key belongs to ${connection.project.name} (${projectId}).`);
  }
  await withLoginLock(path, () => saveLogin(path, { projectId, apiKey }), {
    unlockedIfUnsupported: true,
  });
}
