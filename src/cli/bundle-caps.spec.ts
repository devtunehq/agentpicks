/** ABOUTME: Checks upload-sized bundles, whole-line retention, truncation metadata and compatibility with older readers. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import {
  bundleArtifactSchema,
  bundleManifestSchema,
  type BundleManifest,
} from '../bundle/schema';
import { redactArtifacts } from '../run/artifact-redaction';
import type { RunArtifacts } from '../run/sandbox-run';
import { writeBundle } from './bundle';
import { completed, created, stubFetch, TARGET, UPLOADS } from './fake-devtune';
import {
  readBundle,
  UPLOAD_ARTIFACT_BYTE_LIMITS,
  uploadBundle,
} from './upload';

const MANIFEST: Omit<BundleManifest, 'artifacts' | 'bundleVersion'> = {
  runId: '0b9b8c1e-6f1c-4c55-9c2e-3f7d1f0a2b4c',
  runner: { name: '@devtune/agentpicks', version: '0.1.0' },
  agent: { kind: 'claude_code', version: '2.1.322', model: 'opus' },
  host: { os: 'linux', arch: 'x64' },
  sandbox: {
    provider: 'docker',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    egressIp: null,
  },
  stack: { slug: 'nextjs', starter: 'nextjs', lockDigest: 'b'.repeat(64) },
  request: {
    category: 'error-tracking',
    intent: 'add',
    prompt: 'Add error tracking.',
  },
  startedAt: '2026-11-11T12:00:00.000Z',
  finishedAt: '2026-11-11T12:07:00.000Z',
};
const LIMIT = UPLOAD_ARTIFACT_BYTE_LIMITS.other;
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
let out: string;
afterEach(() => {
  if (out) rmSync(out, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function write(artifacts: RunArtifacts) {
  out = mkdtempSync(join(tmpdir(), 'agentpicks-caps-'));
  return writeBundle({
    outDir: out,
    manifest: MANIFEST,
    artifacts,
    counts: new Map(),
  });
}

it('keeps the tail of an over-limit mitm.log, records redacted byte sizes, and uploads it', async () => {
  // Each line is exactly 1 MiB in UTF-8, but fewer JavaScript characters.
  const line = `${'é'.repeat((1024 * 1024 - 2) / 2)}!\n`;
  const kept = `${line.repeat(49)}last diagnostic\n`;
  const original = `first diagnostic\n${line}${kept}`;
  const written = await write({ 'mitm.log': original });
  const bundle = readBundle(written.dir);
  expect(bundle.contents.get('mitm.log')?.toString()).toBe(kept);
  expect(bundle.manifest.artifacts).toEqual([
    {
      name: 'mitm.log',
      bytes: Buffer.byteLength(kept),
      sha256: sha256(kept),
      truncation: {
        originalBytes: Buffer.byteLength(original),
        keptBytes: Buffer.byteLength(kept),
      },
    },
  ]);
  const url = 'https://storage.test/mitm.log';
  const calls = stubFetch({
    [`POST ${UPLOADS}`]: [
      created(MANIFEST.runId, ['mitm.log'], { 'mitm.log': url }),
    ],
    [`POST ${UPLOADS}/${MANIFEST.runId}/complete`]: [completed(MANIFEST.runId)],
  });
  await expect(uploadBundle(bundle, TARGET)).resolves.toMatchObject({
    sent: 1,
  });
  expect(calls[1]?.body).toBe(kept);
});

it.each(['requests-started.jsonl', 'llm-usage.jsonl'] as const)(
  'keeps whole JSONL records from the head of %s',
  async (name) => {
    const line = `${JSON.stringify({ note: 'é'.repeat(524_280) })}\n`;
    const first = '{"note":"first"}\n';
    const last = '{"note":"last"}';
    const original = `${first}${line.repeat(51)}${last}`;
    const kept = `${first}${line.repeat(50)}`;
    const written = await write({ [name]: original });
    const bundle = readBundle(written.dir);
    const actual = bundle.contents.get(name)!.toString();
    expect(actual).toBe(kept);
    expect(Buffer.byteLength(actual)).toBeLessThanOrEqual(LIMIT);
    expect(bundle.manifest.artifacts[0]).toMatchObject({
      truncation: {
        originalBytes: Buffer.byteLength(original),
        keptBytes: Buffer.byteLength(kept),
      },
    });
    for (const line of actual.trimEnd().split('\n'))
      expect(() => JSON.parse(line)).not.toThrow();
  },
);

it.each(['requests-started.jsonl', 'llm-usage.jsonl'] as const)(
  'omits a single oversized %s record instead of splitting it',
  async (name) => {
    const written = await write({
      [name]: JSON.stringify({ note: 'x'.repeat(LIMIT) }),
    });
    const bundle = readBundle(written.dir);
    expect(bundle.contents.get(name)?.length).toBe(0);
    expect(bundle.manifest.artifacts[0]).toMatchObject({
      bytes: 0,
      truncation: { originalBytes: LIMIT + 11, keptBytes: 0 },
    });
  },
);

it.each([
  'transcript.jsonl',
  'requests.jsonl',
  'diff-truncated.txt',
  'ignored-env.txt',
  'package-json.txt',
  'manifests.txt',
  'baseline-manifests.txt',
] as const)(
  'never trims %s, which analysis reads, so upload refuses it with the limit named',
  async (name) => {
    const original = `${'{"note":"x"}\n'.repeat(LIMIT / 13)}${'{"note":"y"}\n'.repeat(2)}`;
    expect(Buffer.byteLength(original)).toBeGreaterThan(LIMIT);
    const written = await write({ [name]: original });
    expect(() => readBundle(written.dir)).toThrow(
      `DevTune takes at most ${LIMIT} for ${name}.`,
    );
  },
);

it('leaves an artifact exactly at the limit unchanged, including its unterminated last line', async () => {
  const text = 'x'.repeat(LIMIT);
  const written = await write({ 'agent.err': text });
  const bundle = readBundle(written.dir);
  expect(bundle.contents.get('agent.err')?.toString()).toBe(text);
  expect(bundle.manifest.artifacts[0]).toEqual({
    name: 'agent.err',
    bytes: LIMIT,
    sha256: sha256(text),
  });
});

it('measures after redaction when masking grows a stream past its limit', async () => {
  const { artifacts } = redactArtifacts({ 'mitm.log': '12345678\n' }, [
    '12345678',
  ]);
  const prefix = `${'x'.repeat(LIMIT - 10)}\n`;
  expect(Buffer.byteLength(`${prefix}12345678\n`)).toBe(LIMIT);
  const redacted = `${prefix}${artifacts['mitm.log']}`;
  const written = await write({ 'mitm.log': redacted });
  const bundle = readBundle(written.dir);
  expect(bundle.contents.get('mitm.log')?.toString()).toBe('[redacted]\n');
  expect(bundle.manifest.artifacts[0]).toMatchObject({
    truncation: { originalBytes: LIMIT + 2, keptBytes: 11 },
  });
});

it.each(['mitm.log', 'requests-started.jsonl'] as const)(
  'keeps the entire budget when %s has a line boundary exactly at the limit',
  async (name) => {
    const kept = 'é!\n'.repeat(LIMIT / 4);
    const original = name === 'mitm.log' ? `lost\n${kept}` : `${kept}lost\n`;
    const written = await write({ [name]: original });
    const bundle = readBundle(written.dir);
    expect(bundle.contents.get(name)?.toString()).toBe(kept);
    expect(bundle.manifest.artifacts[0]).toMatchObject({
      truncation: { originalBytes: LIMIT + 5, keptBytes: LIMIT },
    });
  },
);

it('writes every under-limit bundle file byte-for-byte as the original writer did', async () => {
  const artifacts: RunArtifacts = {
    'meta.json': '{"exitCode":0}',
    'transcript.jsonl': 'é\nlast',
    'requests.jsonl': '',
    'diff.patch': '+é\n',
    'source-files.json': '{"file.ts":"é"}',
  };
  const written = await write(artifacts);
  const expectedManifest = {
    bundleVersion: 1,
    ...MANIFEST,
    artifacts: Object.entries(artifacts).map(([name, text]) => ({
      name,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
    })),
  };
  expect(readFileSync(join(written.dir, 'manifest.json'), 'utf8')).toBe(
    `${JSON.stringify(expectedManifest, null, 2)}\n`,
  );
  expect(readFileSync(join(written.dir, 'redactions.json'), 'utf8')).toBe(
    `${JSON.stringify({ bundleVersion: 1, total: 0, byArtifact: {} }, null, 2)}\n`,
  );
  for (const [name, text] of Object.entries(artifacts))
    expect(readFileSync(join(written.dir, 'artifacts', name), 'utf8')).toBe(
      text,
    );
  expect(readBundle(written.dir).manifest).toEqual(expectedManifest);
});

it('lets the server schema from before truncation metadata parse a trimmed manifest', async () => {
  const written = await write({ 'mitm.log': `${'x'.repeat(LIMIT)}\nlast\n` });
  const manifest = readBundle(written.dir).manifest;
  // The deployed artifact object has these three fields and strips unknown keys.
  const oldArtifact = bundleArtifactSchema.pick({
    name: true,
    bytes: true,
    sha256: true,
  });
  for (const artifact of manifest.artifacts) {
    expect(oldArtifact.parse(artifact)).toEqual({
      name: artifact.name,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  }
  expect(bundleManifestSchema.safeParse(manifest).success).toBe(true);
});
