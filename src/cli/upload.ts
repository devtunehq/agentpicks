/**
 * ABOUTME: Uploads a bundle on disk to a DevTune project over API v2 (spec 46 §4.1): create the
 * upload with the manifest, PUT each artifact's bytes to its signed Storage address, then complete
 * it. Create is idempotent on the run id and gives no address for an artifact already stored, so
 * uploading again resumes; a completed upload comes back completed. DevTune's refusals are shown
 * with its own message. Also discovers the project a key or sign-in belongs to, for `agentpicks login`; `init` drafts through the same call.
 * Calls carry a project API key or a saved sign-in's access token, renewed when it expires.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { uploadArtifactByteLimit } from '../bundle/artifact-limits';
import {
  BUNDLE_PATHS,
  bundleManifestSchema,
  redactionSummarySchema,
  type BundleManifest,
  type RedactionSummary,
} from '../bundle/schema';
import type { EarlyStopPatterns } from '../catalogue/early-stop';
import {
  bundleEarlyStopSchema,
  bundleSetupSchema,
  type BundleSetup,
} from './bundle';
import type { DevtuneCredential, DevtuneTarget } from './devtune-login';
import {
  BundleError,
  isTransientStatus,
  SignInError,
  UploadError,
} from './errors';

export { UPLOAD_ARTIFACT_BYTE_LIMITS } from '../bundle/artifact-limits';

/** API calls wait at most this long; a PUT of one artifact, up to 50 MiB, waits longer. */
const API_TIMEOUT_MS = 60_000;
const PUT_TIMEOUT_MS = 10 * 60_000;

/** The most bytes read from manifest.json or redactions.json. */
const BUNDLE_JSON_MAX_BYTES = 1024 * 1024;

export interface BundleOnDisk {
  dir: string;
  manifest: BundleManifest;
  /** The files an upload sends, relative to `dir`, with their sizes: the manifest and every artifact. */
  files: { path: string; bytes: number }[];
  redactions: RedactionSummary;
  /** Each artifact's bytes, read once and checked against the manifest; the upload sends these. */
  contents: ReadonlyMap<string, Buffer>;
  /** The setup file the run came from, which the upload never sends. */
  setup?: BundleSetup;
  /** The early-stop patterns the run watched for, which the upload never sends; older bundles lack them. */
  earlyStop?: EarlyStopPatterns;
}

/**
 * The bundle in `dir`, checked: its manifest parses with `bundleManifestSchema`, and every artifact
 * it declares is a regular file (not a symlink) at its declared size, within DevTune's limit for it,
 * and at its declared SHA-256, since DevTune can't take a stored artifact back and expires an
 * upload holding one of the wrong size. Sizes are checked before anything is read.
 */
export function readBundle(dir: string): BundleOnDisk {
  const raw = readJson(dir, BUNDLE_PATHS.manifest);
  const manifest = bundleManifestSchema.safeParse(raw);
  if (!manifest.success)
    throw new BundleError(
      `${dir} is not a bundle agentpicks wrote: ${z.prettifyError(manifest.error)}`,
    );
  const redactions = redactionSummarySchema.safeParse(
    readJson(dir, BUNDLE_PATHS.redactions),
  );
  if (!redactions.success)
    throw new BundleError(
      `${dir} is not a bundle agentpicks wrote: ${BUNDLE_PATHS.redactions} doesn't match the bundle format.`,
    );
  const files: BundleOnDisk['files'] = [
    {
      path: BUNDLE_PATHS.manifest,
      bytes: lstatSync(join(dir, BUNDLE_PATHS.manifest)).size,
    },
  ];
  const contents = new Map<string, Buffer>();
  for (const artifact of manifest.data.artifacts) {
    const path = `${BUNDLE_PATHS.artifacts}/${artifact.name}`;
    const limit = uploadArtifactByteLimit(artifact.name);
    if (artifact.bytes > limit)
      throw new BundleError(
        `${join(dir, path)} is ${artifact.bytes} bytes; DevTune takes at most ${limit} for ${artifact.name}.`,
      );
    const bytes = readRegularFile(dir, path, artifact.bytes);
    if (
      bytes === null ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
      throw new BundleError(
        `${join(dir, path)} isn't the file its manifest declares: the bundle changed after agentpicks wrote it.`,
      );
    files.push({ path, bytes: bytes.length });
    contents.set(artifact.name, bytes);
  }
  const setup = bundleSetupSchema.safeParse(
    raw && typeof raw === 'object' && 'setup' in raw ? raw.setup : undefined,
  );
  const earlyStop = bundleEarlyStopSchema.safeParse(
    raw && typeof raw === 'object' && 'earlyStop' in raw
      ? raw.earlyStop
      : undefined,
  );
  return {
    dir,
    manifest: manifest.data,
    files,
    redactions: redactions.data,
    contents,
    ...(setup.success ? { setup: setup.data } : {}),
    ...(earlyStop.success ? { earlyStop: earlyStop.data } : {}),
  };
}

/**
 * The bundle directories under `dir`: `dir` itself when it holds a manifest, else each directory in
 * it that does, as `run --out` lays them out, in name order.
 */
export function findBundles(dir: string): string[] {
  if (isFile(join(dir, BUNDLE_PATHS.manifest))) return [dir];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new BundleError(
      `${dir} can't be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bundles = names
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => isFile(join(path, BUNDLE_PATHS.manifest)));
  if (bundles.length === 0)
    throw new BundleError(
      `${dir} holds no bundle: pass a bundle directory, or the --out directory of agentpicks run.`,
    );
  return bundles;
}

const uploadStatusSchema = z.object({
  run_id: z.string(),
  status: z.enum(['open', 'completed', 'expired']),
  run: z.object({ id: z.string(), analysis: z.string() }).nullable(),
});
const createdSchema = uploadStatusSchema.extend({
  uploads: z.array(z.object({ name: z.string(), url: z.string().nullable() })),
});

export interface UploadedRun {
  runId: string;
  /** The upload's API v2 address, which reads its status with the project's API key or sign-in. */
  statusUrl: string;
  /** Artifacts this call sent; the rest were already stored. */
  sent: number;
  analysis: string | null;
}

/** Uploads the bundle, resuming an upload a run or an earlier `upload` started. */
export async function uploadBundle(
  bundle: BundleOnDisk,
  target: DevtuneTarget,
): Promise<UploadedRun> {
  const uploads = `${target.baseUrl}/projects/${target.projectId}/agent-picks/uploads`;
  const created = await callApi(target, createdSchema, uploads, {
    method: 'POST',
    body: JSON.stringify(bundle.manifest),
  });
  const statusUrl = `${uploads}/${created.run_id}`;
  if (created.status === 'expired')
    throw new UploadError(
      `DevTune reports the upload of run ${created.run_id} as expired.`,
    );
  if (created.status === 'completed')
    return {
      runId: created.run_id,
      statusUrl,
      sent: 0,
      analysis: created.run?.analysis ?? null,
    };

  let sent = 0;
  for (const { name, url } of created.uploads) {
    // No address: the artifact is already stored.
    if (url === null) continue;
    const bytes = bundle.contents.get(name);
    if (!bytes)
      throw new UploadError(
        `DevTune asked for ${name}, which the bundle's manifest doesn't declare.`,
      );
    if (await putArtifact(url, bytes, `${BUNDLE_PATHS.artifacts}/${name}`))
      sent++;
  }
  const completed = await callApi(
    target,
    uploadStatusSchema,
    `${statusUrl}/complete`,
    { method: 'POST' },
  );
  return {
    runId: completed.run_id,
    statusUrl,
    sent,
    analysis: completed.run?.analysis ?? null,
  };
}

const connectionSchema = z.object({
  project: z.object({ id: z.uuid(), name: z.string() }),
  credential: z.object({ type: z.string() }),
  scopes: z.array(z.string()),
});

/** The project a key or sign-in belongs to, what it is, and the scopes it may use, from GET /connection. */
export async function discoverProject(target: Credentials) {
  return callApi(target, connectionSchema, `${target.baseUrl}/connection`, {
    method: 'GET',
  });
}

/**
 * PUTs one artifact to its signed address. Resolves false when Storage already holds it, which
 * happens when another `run` or `upload` of the same bundle stored it first.
 */
async function putArtifact(url: string, bytes: Buffer, path: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
      redirect: 'error',
      signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UploadError(
      `Uploading ${path} to storage failed (${transportCode(error)}). Run agentpicks upload again to send what isn't stored.`,
    );
  }
  if (response.ok) {
    await response.body?.cancel();
    return true;
  }
  let text = '';
  try {
    text = await response.text();
  } catch {
    // An unreadable body is judged by its status alone.
  }
  // Storage refuses a second object at a path as 409, or as 400 with statusCode "409" in its body.
  if (response.status === 409 || /"statusCode"\s*:\s*"409"/.test(text))
    return false;
  throw new UploadError(
    `Uploading ${path} failed: Storage answered ${response.status}.`,
  );
}

const apiErrorSchema = z.object({
  message: z.string().min(1),
  reason: z.string().optional(),
});

type Credentials = { baseUrl: string } & DevtuneCredential;

/**
 * One API v2 call with the key or sign-in, parsing the `data` of its answer; a refusal throws its
 * message, with its reason and status. A sign-in that can't be renewed is refused as an UploadError
 * too, saying to log in again.
 */
export async function callApi<T>(
  target: Credentials,
  schema: z.ZodType<T>,
  url: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: string },
): Promise<T> {
  let bearer: string;
  try {
    bearer =
      'apiKey' in target ? target.apiKey : await target.session.accessToken();
  } catch (error) {
    if (error instanceof SignInError)
      throw new UploadError(error.message, { transient: error.transient });
    throw error;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        ...(init.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new UploadError(
      `Couldn't reach DevTune at ${target.baseUrl} (${transportCode(error)}). Check the connection and try again.`,
      { transient: true },
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON; said below.
  }
  if (!response.ok) {
    const message = apiErrorSchema.safeParse(body);
    const refused = {
      status: response.status,
      ...(message.data?.reason ? { reason: message.data.reason } : {}),
    };
    if (isTransientStatus(response.status))
      throw new UploadError(
        message.success
          ? message.data.message
          : `DevTune answered ${response.status}.`,
        { transient: true, ...refused },
      );
    if ('session' in target) {
      // DevTune's sign-in refusals (expired, not linked, another project, a scope missing) say to
      // run devtune login, the other CLI; agentpicks signs in with its own.
      if (message.success)
        throw new UploadError(
          message.data.message.replaceAll('devtune login', 'agentpicks login'),
          refused,
        );
      throw new UploadError(
        response.status === 401
          ? 'DevTune refused the sign-in. Run agentpicks login again.'
          : `DevTune answered ${response.status}.`,
        refused,
      );
    }
    if (!message.success)
      throw new UploadError(`DevTune answered ${response.status}.`, refused);
    throw new UploadError(
      response.status === 401
        ? `${message.data.message.replace(/\.?$/, '.')} Run agentpicks login, or set DEVTUNE_API_KEY.`
        : message.data.message,
      refused,
    );
  }
  const data = z.object({ data: schema }).safeParse(body);
  if (!data.success)
    throw new UploadError(
      `DevTune's answer from ${new URL(url).pathname} wasn't the expected shape.`,
    );
  return data.data.data;
}

function readJson(dir: string, path: string): unknown {
  const bytes = readRegularFile(dir, path, null, BUNDLE_JSON_MAX_BYTES);
  try {
    if (bytes === null) throw new Error('not a regular file within its limit');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new BundleError(
      `${dir} is not a bundle agentpicks wrote: ${path} is missing, too large or isn't JSON.`,
    );
  }
}

/**
 * The file's bytes, or null when it isn't a regular file (a symlink included), or its size isn't
 * `bytes` or is over `max`. The size is checked before reading, and no more than it is read.
 */
function readRegularFile(
  dir: string,
  path: string,
  bytes: number | null,
  max = Infinity,
): Buffer | null {
  const full = join(dir, path);
  let fd: number | null = null;
  try {
    const stat = lstatSync(full);
    if (!stat.isFile() || stat.size > max) return null;
    if (bytes !== null && stat.size !== bytes) return null;
    fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) return null;
      read += n;
    }
    return buffer;
  } catch {
    // Missing or unreadable: the caller refuses it as changed.
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A transport failure's code (`ECONNRESET`, `ENOTFOUND`) or its error's name, never its message,
 * which can quote a header and so the key or token.
 */
function transportCode(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  if (error.name === 'TimeoutError') return 'timed out';
  const code =
    (error.cause as { code?: unknown } | undefined)?.code ??
    (error as { code?: unknown }).code;
  const name = typeof code === 'string' ? code : error.name;
  return /^\w+$/.test(name) ? name : 'unknown error';
}
