/**
 * ABOUTME: The upload client against a stubbed `fetch`: create, PUT each artifact with a signed
 * address and complete; an artifact already stored (null address) skipped; a partial upload
 * resumed; a completed upload left alone; DevTune's named refusals shown with its message; and a
 * bundle that changed on disk refused before anything is sent.
 */
import {
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunArtifacts } from '../run/sandbox-run';
import { writeBundle } from './bundle';
import { BundleError, UploadError } from './errors';
import {
  completed,
  created,
  refused,
  stubFetch,
  TARGET,
  UPLOADS,
} from './fake-devtune';
import {
  findBundles,
  readBundle,
  UPLOAD_ARTIFACT_BYTE_LIMITS,
  uploadBundle,
} from './upload';

const RUN_ID = '0f9d5a8e-5d1c-4b8e-9a43-3c1f0e6b7a21';
const ARTIFACTS = {
  'meta.json': '{"exitCode":0}',
  'transcript.jsonl': '{"type":"result"}\n',
  'diff.patch': '+Sentry.init()\n',
};

/** Writes a bundle as `run` does, under `outDir/<runId>`. */
async function writeTestBundle(
  outDir: string,
  runId = RUN_ID,
  artifacts: RunArtifacts = ARTIFACTS,
) {
  const written = await writeBundle({
    outDir,
    manifest: {
      runId,
      runner: { name: '@devtune/agentpicks', version: '0.1.0' },
      agent: { kind: 'claude_code', version: '2.1.322', model: 'opus' },
      host: { os: 'linux', arch: 'x64' },
      sandbox: {
        provider: 'docker',
        imageDigest: `sha256:${'c'.repeat(64)}`,
        egressIp: null,
      },
      stack: { slug: 'nextjs', starter: 'nextjs', lockDigest: 'a'.repeat(64) },
      request: { category: 'error-tracking', intent: 'add', prompt: 'Add it' },
      startedAt: '2026-11-11T12:00:00Z',
      finishedAt: '2026-11-11T12:05:00Z',
    },
    artifacts,
    counts: new Map([['transcript.jsonl', 2]]),
  });
  return written.dir;
}

const NAMES = Object.keys(ARTIFACTS);
const signed = (name: string) =>
  `https://storage.test/object/upload/sign/self-run/${name}?token=t-${name}`;
const ALL_SIGNED = {
  'meta.json': signed('meta.json'),
  'transcript.jsonl': signed('transcript.jsonl'),
  'diff.patch': signed('diff.patch'),
};

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'agentpicks-upload-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(out, { recursive: true, force: true });
});

describe('uploadBundle', () => {
  it('creates the upload with the manifest, PUTs every artifact to its address, then completes', async () => {
    const dir = await writeTestBundle(out);
    const calls = stubFetch({
      [`POST ${UPLOADS}`]: [created(RUN_ID, NAMES, ALL_SIGNED)],
      [`POST ${UPLOADS}/${RUN_ID}/complete`]: [completed(RUN_ID)],
    });
    const bundle = readBundle(dir);
    await expect(uploadBundle(bundle, TARGET)).resolves.toEqual({
      runId: RUN_ID,
      statusUrl: `${UPLOADS}/${RUN_ID}`,
      sent: 3,
      analysis: 'pending',
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${UPLOADS}`,
      `PUT ${ALL_SIGNED['meta.json']}`,
      `PUT ${ALL_SIGNED['transcript.jsonl']}`,
      `PUT ${ALL_SIGNED['diff.patch']}`,
      `POST ${UPLOADS}/${RUN_ID}/complete`,
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual(bundle.manifest);
    expect(calls.slice(1, 4).map((c) => c.body)).toEqual(
      Object.values(ARTIFACTS),
    );
    // The key goes to DevTune only, never to Storage.
    for (const call of calls)
      expect(call.headers.Authorization).toBe(
        call.method === 'PUT' ? undefined : `Bearer ${TARGET.apiKey}`,
      );
  });

  it('skips an artifact with no address, which is already stored', async () => {
    const dir = await writeTestBundle(out);
    const calls = stubFetch({
      [`POST ${UPLOADS}`]: [
        created(RUN_ID, NAMES, { 'diff.patch': ALL_SIGNED['diff.patch'] }),
      ],
      [`POST ${UPLOADS}/${RUN_ID}/complete`]: [completed(RUN_ID)],
    });
    const result = await uploadBundle(readBundle(dir), TARGET);
    expect(result.sent).toBe(1);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual([
      ALL_SIGNED['diff.patch'],
    ]);
  });

  it('resumes an upload that stopped partway, sending only what is not stored, and completes once', async () => {
    const dir = await writeTestBundle(out);
    const calls = stubFetch({
      [`POST ${UPLOADS}`]: [
        created(RUN_ID, NAMES, ALL_SIGNED),
        // The retry: meta.json was stored before the connection dropped.
        created(RUN_ID, NAMES, {
          'transcript.jsonl': ALL_SIGNED['transcript.jsonl'],
          'diff.patch': ALL_SIGNED['diff.patch'],
        }),
      ],
      [`PUT ${ALL_SIGNED['meta.json']}`]: [{ status: 200, body: {} }],
      [`PUT ${ALL_SIGNED['transcript.jsonl']}`]: [
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
          }),
        }),
      ],
      [`POST ${UPLOADS}/${RUN_ID}/complete`]: [completed(RUN_ID)],
    });
    await expect(uploadBundle(readBundle(dir), TARGET)).rejects.toThrow(
      new UploadError(
        "Uploading artifacts/transcript.jsonl to storage failed (ECONNRESET). Run agentpicks upload again to send what isn't stored.",
      ),
    );
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);

    await expect(uploadBundle(readBundle(dir), TARGET)).resolves.toMatchObject({
      runId: RUN_ID,
      sent: 2,
    });
    expect(calls.map((c) => `${c.method} ${c.url}`).slice(3)).toEqual([
      `POST ${UPLOADS}`,
      `PUT ${ALL_SIGNED['transcript.jsonl']}`,
      `PUT ${ALL_SIGNED['diff.patch']}`,
      `POST ${UPLOADS}/${RUN_ID}/complete`,
    ]);
  });

  it('counts an artifact another upload of the same bundle stored first as stored', async () => {
    const dir = await writeTestBundle(out);
    stubFetch({
      [`POST ${UPLOADS}`]: [created(RUN_ID, NAMES, ALL_SIGNED)],
      [`PUT ${ALL_SIGNED['meta.json']}`]: [
        {
          status: 400,
          body: { statusCode: '409', error: 'Duplicate', message: 'exists' },
        },
      ],
      [`POST ${UPLOADS}/${RUN_ID}/complete`]: [completed(RUN_ID)],
    });
    await expect(uploadBundle(readBundle(dir), TARGET)).resolves.toMatchObject({
      sent: 2,
    });
  });

  it('leaves a completed upload alone: nothing is PUT and it is not completed again', async () => {
    const dir = await writeTestBundle(out);
    const calls = stubFetch({
      [`POST ${UPLOADS}`]: [created(RUN_ID, NAMES, {}, 'completed')],
    });
    await expect(uploadBundle(readBundle(dir), TARGET)).resolves.toEqual({
      runId: RUN_ID,
      statusUrl: `${UPLOADS}/${RUN_ID}`,
      sent: 0,
      analysis: 'pending',
    });
    expect(calls).toHaveLength(1);
  });

  const EXPIRED =
    'This upload expired and its artifacts are being removed. Create it again once a cleanup sweep, which runs every 15 minutes, has removed its artifacts, no sooner than 2 hours 15 minutes after it was last created or retried.';
  const DELETED =
    'This upload was deleted and its artifacts are being removed. Create it again once a cleanup sweep, which runs every 15 minutes, has removed its artifacts, no sooner than 2 hours 15 minutes after it was last created or retried.';
  const MISMATCH =
    "diff.patch holds 3 bytes, not the 15 the manifest declares, so the bundle changed or was damaged after its manifest was written. A stored artifact can't be replaced, so this upload has expired. Create it again once a cleanup sweep, which runs every 15 minutes, has removed its artifacts, no sooner than 2 hours 15 minutes after it was last created or retried, and upload every artifact.";

  it.each([
    ['create', 409, 'upload_expired', EXPIRED],
    ['create', 409, 'upload_deleted', DELETED],
    [
      'create',
      403,
      'plan_excludes_uploads',
      'Uploading self-runs needs an Agent Picks Local Runner, Cloud or Enterprise plan.',
    ],
    [
      'create',
      400,
      'repository_remote_missing',
      "The run's repository has no remote URL. Add an origin remote to the repository, then run it again.",
    ],
    [
      'create',
      409,
      'run_exists',
      'Another project or a hosted test already uses this run id.',
    ],
    ['complete', 409, 'artifact_size_mismatch', MISMATCH],
  ] as const)(
    'shows the %s refusal %i %s with its message as DevTune gives it',
    async (step, status, reason, message) => {
      const dir = await writeTestBundle(out);
      stubFetch(
        step === 'create'
          ? { [`POST ${UPLOADS}`]: [refused(status, reason, message)] }
          : {
              [`POST ${UPLOADS}`]: [created(RUN_ID, NAMES, ALL_SIGNED)],
              [`POST ${UPLOADS}/${RUN_ID}/complete`]: [
                refused(status, reason, message),
              ],
            },
      );
      await expect(uploadBundle(readBundle(dir), TARGET)).rejects.toThrow(
        new UploadError(message, { reason, status }),
      );
    },
  );

  it('says how to log in when DevTune refuses the key', async () => {
    const dir = await writeTestBundle(out);
    stubFetch({
      [`POST ${UPLOADS}`]: [
        {
          status: 401,
          body: {
            error: 'unauthorized',
            message: 'Invalid or missing API key',
            status: 401,
          },
        },
      ],
    });
    await expect(uploadBundle(readBundle(dir), TARGET)).rejects.toThrow(
      new UploadError(
        'Invalid or missing API key. Run agentpicks login, or set DEVTUNE_API_KEY.',
        { status: 401 },
      ),
    );
  });

  it('names DevTune and the failure code when it cannot be reached, never the transport message, which can quote the key', async () => {
    const dir = await writeTestBundle(out);
    stubFetch({
      [`POST ${UPLOADS}`]: [
        new TypeError(`invalid header value Bearer ${TARGET.apiKey}`, {
          cause: Object.assign(new Error(`header ${TARGET.apiKey}`), {
            code: 'ENOTFOUND',
          }),
        }),
      ],
    });
    const error = await uploadBundle(readBundle(dir), TARGET).catch(
      (e: unknown) => e,
    );
    expect(error).toEqual(
      new UploadError(
        "Couldn't reach DevTune at https://devtune.test/api/v2 (ENOTFOUND). Check the connection and try again.",
        { transient: true },
      ),
    );
  });

  it('PUTs the bytes it checked, even when the file changes at the same size afterwards', async () => {
    const dir = await writeTestBundle(out);
    const calls = stubFetch({
      [`POST ${UPLOADS}`]: [
        created(RUN_ID, NAMES, { 'diff.patch': ALL_SIGNED['diff.patch'] }),
      ],
      [`POST ${UPLOADS}/${RUN_ID}/complete`]: [completed(RUN_ID)],
    });
    const bundle = readBundle(dir);
    writeFileSync(
      join(dir, 'artifacts/diff.patch'),
      'X'.repeat(ARTIFACTS['diff.patch'].length),
    );
    await uploadBundle(bundle, TARGET);
    expect(calls.find((c) => c.method === 'PUT')?.body).toBe(
      ARTIFACTS['diff.patch'],
    );
  });
});

describe('readBundle', () => {
  it('lists the manifest and every artifact it declares, with their sizes and the redactions', async () => {
    const dir = await writeTestBundle(out);
    const bundle = readBundle(dir);
    expect(bundle.files.map((f) => f.path)).toEqual([
      'manifest.json',
      'artifacts/meta.json',
      'artifacts/transcript.jsonl',
      'artifacts/diff.patch',
    ]);
    expect(bundle.files[1]!.bytes).toBe(ARTIFACTS['meta.json'].length);
    expect(bundle.redactions.total).toBe(2);
  });

  it('refuses an artifact that changed after the bundle was written', async () => {
    const dir = await writeTestBundle(out);
    writeFileSync(join(dir, 'artifacts/diff.patch'), '+changed\n');
    expect(() => readBundle(dir)).toThrow(BundleError);
    expect(() => readBundle(dir)).toThrow(
      /artifacts\/diff\.patch isn't the file its manifest declares/,
    );
  });

  it('refuses an artifact that is a symlink, even to a file with the declared bytes', async () => {
    const dir = await writeTestBundle(out);
    const target = join(out, 'elsewhere.patch');
    writeFileSync(target, ARTIFACTS['diff.patch']);
    rmSync(join(dir, 'artifacts/diff.patch'));
    symlinkSync(target, join(dir, 'artifacts/diff.patch'));
    expect(() => readBundle(dir)).toThrow(
      /artifacts\/diff\.patch isn't the file its manifest declares/,
    );
  });

  it('refuses a manifest.json that is a symlink', async () => {
    const dir = await writeTestBundle(out);
    const target = join(out, 'manifest.json');
    renameSync(join(dir, 'manifest.json'), target);
    symlinkSync(target, join(dir, 'manifest.json'));
    expect(() => readBundle(dir)).toThrow(
      /manifest\.json is missing, too large or isn't JSON/,
    );
  });

  it('refuses an artifact over the size DevTune takes for it, before reading it', async () => {
    const dir = await writeTestBundle(out, RUN_ID, {
      ...ARTIFACTS,
      'diff.patch': '+'.repeat(UPLOAD_ARTIFACT_BYTE_LIMITS['diff.patch'] + 1),
    });
    expect(() => readBundle(dir)).toThrow(
      new BundleError(
        `${join(dir, 'artifacts/diff.patch')} is 800001 bytes; DevTune takes at most 800000 for diff.patch.`,
      ),
    );
  });

  it('refuses a manifest the bundle format rejects', async () => {
    const dir = await writeTestBundle(out);
    writeFileSync(join(dir, 'manifest.json'), '{"bundleVersion":2}');
    expect(() => readBundle(dir)).toThrow(/is not a bundle agentpicks wrote/);
  });
});

describe('findBundles', () => {
  it('takes a bundle directory, or every bundle in an --out directory, skipping partial writes', async () => {
    const second = 'ffffffff-5d1c-4b8e-9a43-3c1f0e6b7a21';
    const one = await writeTestBundle(out);
    const two = await writeTestBundle(out, second);
    writeFileSync(join(out, 'notes.txt'), 'x');
    expect(findBundles(one)).toEqual([one]);
    expect(findBundles(out)).toEqual([one, two]);
  });

  it('refuses a directory holding no bundle', () => {
    expect(() => findBundles(out)).toThrow(/holds no bundle/);
  });
});
