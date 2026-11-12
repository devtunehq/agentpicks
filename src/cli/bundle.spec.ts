/** ABOUTME: Covers bundle writing (files, sizes, hashes, the manifest schema, no partial bundle) and artifact redaction with its count. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bundleManifestSchema,
  redactionSummarySchema,
  type BundleManifest,
} from '../bundle/schema';
import { redactArtifacts } from '../run/artifact-redaction';
import { starterLockDigest, writeBundle } from './bundle';

const RUN_ID = '0b9b8c1e-6f1c-4c55-9c2e-3f7d1f0a2b4c';

const MANIFEST: Omit<BundleManifest, 'artifacts' | 'bundleVersion'> = {
  runId: RUN_ID,
  runner: { name: '@devtune/agentpicks', version: '0.1.0' },
  agent: { kind: 'claude_code', version: '2.1.322', model: 'opus' },
  host: { os: 'linux', arch: 'x64' },
  sandbox: {
    provider: 'docker',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    egressIp: '203.0.113.7',
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

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('redactArtifacts', () => {
  it('masks the credentials in every artifact and counts each artifact’s masks', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnop';
    const { artifacts, counts } = redactArtifacts(
      {
        'transcript.jsonl': `{"note":"key=${secret}"}\n{"note":"again ${secret}"}`,
        'agent.err': 'already [redacted]',
      },
      [secret],
    );
    expect(Object.values(artifacts).join('')).not.toContain(secret);
    expect(counts).toEqual(
      new Map([
        ['transcript.jsonl', 2],
        // A mask the text already had is not counted.
        ['agent.err', 0],
      ]),
    );
  });

  it('removes a credential the open rules find without being told its value', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
    const key =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQ\nAbCd\n-----END PRIVATE KEY-----';
    const { artifacts, counts } = redactArtifacts(
      {
        'diff.patch': `+const client = new Octokit({ auth: '${token}' });\n+${key}\n`,
        'manifests.txt': 'postgres://app:hunter22@db:5432/app',
      },
      [],
    );
    expect(artifacts['diff.patch']).toBe(
      "+const client = new Octokit({ auth: '[redacted]' });\n+[redacted]\n[redacted]\n[redacted]\n[redacted]\n",
    );
    expect(counts.get('diff.patch')).toBe(5);
    expect(artifacts['manifests.txt']).toBe(
      'postgres://app:[redacted]@db:5432/app',
    );
  });

  it("keeps what follows a credential-like name, which an artifact's reader needs", () => {
    const kept = {
      'transcript.jsonl':
        '{"type":"assistant","message":{"usage":{"input_tokens":12,"output_tokens":340}}}',
      'diff.patch':
        '+SENTRY_AUTH_TOKEN=\ndiff --git a/.gitignore b/.gitignore\n+  authToken: process.env.SENTRY_AUTH_TOKEN,',
      'deps.txt':
        '/work/app/node_modules/eslint-visitor-keys:eslint-visitor-keys@4.2.1\n/work/app/node_modules/jsonwebtoken:jsonwebtoken@9.0.2',
    } as const;
    expect(redactArtifacts(kept, []).artifacts).toEqual(kept);
  });

  it('masks a secret with a quote inside tool results that carry serialized JSON, changing no other byte', () => {
    const secret = 'abc"defghi123456789';
    // The same records with the secret already masked, which is what redaction must produce.
    const transcript = (value: string) =>
      [
        JSON.stringify({
          type: 'user',
          content: [
            {
              type: 'tool_result',
              content: JSON.stringify({ value, note: 'é "kept"' }),
            },
          ],
        }),
        JSON.stringify({
          type: 'user',
          content: JSON.stringify({ result: JSON.stringify({ value }) }),
        }),
      ].join('\n');
    const { artifacts } = redactArtifacts(
      {
        'diff.patch': `+++ b/.env.local\n+AUTH_SECRET='${secret}'\n`,
        'transcript.jsonl': transcript(secret),
      },
      [],
    );
    expect(artifacts['transcript.jsonl']).toBe(transcript('[redacted]'));
    expect(artifacts['diff.patch']).toBe(
      "+++ b/.env.local\n+AUTH_SECRET='[redacted]'\n",
    );
  });

  it('masks a letters-only AUTH_SECRET written to .env.local through the Write tool', () => {
    const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF';
    const write = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: {
              file_path: '/work/app/.env.local',
              content: `AUTH_SECRET=${secret}\n`,
            },
          },
        ],
      },
    };
    const { artifacts } = redactArtifacts(
      {
        'transcript.jsonl': JSON.stringify(write),
        'agent.err': `using ${secret}`,
      },
      [],
    );
    expect(Object.values(artifacts).join('\n')).not.toContain(secret);
  });

  it('keeps an empty assignment before a command, and a source file stored under a path that names a token', () => {
    const kept = {
      'transcript.jsonl': JSON.stringify({
        type: 'tool_use',
        input: {
          command: 'SENTRY_DSN= .venv/bin/python manage.py check --deploy',
        },
      }),
      'source-files.json': JSON.stringify({
        'src/lib/token.ts':
          'export function verifyToken(token: string) {\n  return token.length > 0;\n}\n',
      }),
    } as const;
    const { artifacts, counts } = redactArtifacts(kept, []);
    expect(artifacts).toEqual(kept);
    expect([...counts.values()]).toEqual([0, 0]);
  });

  it('masks a secret the agent wrote to .env.local in every artifact, and keeps token counts', () => {
    const secret = 'q8XvN2pLr7Tk4WbY9mZc3HdF6sJa1GeU';
    const write = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: {
              file_path: '/work/app/.env.local',
              content: `# Auth.js\nAUTH_SECRET=${secret}\nAUTH_URL=http://localhost:3000\n`,
            },
          },
        ],
        usage: { input_tokens: 1234, output_tokens: 56 },
      },
    };
    const { artifacts, counts } = redactArtifacts(
      {
        'transcript.jsonl': [
          JSON.stringify(write),
          // The secret printed alone, later in the run.
          JSON.stringify({ type: 'user', content: `${secret}\n` }),
        ].join('\n'),
        'diff.patch': `diff --git a/.env.local b/.env.local\n+AUTH_SECRET=${secret}\n`,
        'source-files.json': JSON.stringify({
          files: [{ path: '.env.local', content: `AUTH_SECRET="${secret}"\n` }],
        }),
        'agent.err': `warning: secret ${secret} is weak\n`,
      },
      [],
    );
    for (const [name, text] of Object.entries(artifacts)) {
      expect(text, name).not.toContain(secret);
      expect(counts.get(name as keyof typeof artifacts), name).toBeGreaterThan(
        0,
      );
    }
    expect(artifacts['transcript.jsonl']).toContain('"input_tokens":1234');
    expect(artifacts['transcript.jsonl']).toContain(
      'AUTH_URL=http://localhost:3000',
    );
  });
});

describe('writeBundle', () => {
  it('writes the artifacts, redaction summary and manifest under the run id', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentpicks-bundle-'));
    const written = await writeBundle({
      outDir: dir,
      manifest: MANIFEST,
      artifacts: { 'meta.json': '{"exitCode":0}', 'transcript.jsonl': 'é\n' },
      counts: new Map([
        ['transcript.jsonl', 2],
        ['agent.err', 1],
      ]),
    });
    expect(written.dir).toBe(join(dir, RUN_ID));
    expect(readdirSync(dir)).toEqual([RUN_ID]);
    expect(written.files).toEqual([
      { path: 'artifacts/meta.json', bytes: 14 },
      { path: 'artifacts/transcript.jsonl', bytes: 3 },
      { path: 'redactions.json', bytes: expect.any(Number) },
      { path: 'manifest.json', bytes: expect.any(Number) },
    ]);
    const manifest = bundleManifestSchema.parse(
      JSON.parse(readFileSync(join(written.dir, 'manifest.json'), 'utf8')),
    );
    expect(manifest.bundleVersion).toBe(1);
    expect(manifest.artifacts).toEqual([
      { name: 'meta.json', bytes: 14, sha256: sha256('{"exitCode":0}') },
      { name: 'transcript.jsonl', bytes: 3, sha256: sha256('é\n') },
    ]);
    // Only artifacts in the bundle are counted.
    expect(
      redactionSummarySchema.parse(
        JSON.parse(readFileSync(join(written.dir, 'redactions.json'), 'utf8')),
      ),
    ).toEqual({
      bundleVersion: 1,
      total: 2,
      byArtifact: { 'transcript.jsonl': 2 },
    });
    expect(
      readFileSync(join(written.dir, 'artifacts/transcript.jsonl'), 'utf8'),
    ).toBe('é\n');
  });

  it('writes nothing under any name when the manifest is invalid', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentpicks-bundle-'));
    await expect(
      writeBundle({
        outDir: dir,
        manifest: {
          ...MANIFEST,
          sandbox: { ...MANIFEST.sandbox, imageDigest: '' },
        },
        artifacts: { 'meta.json': '{}' },
        counts: new Map(),
      }),
    ).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the partial bundle when a write fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentpicks-bundle-'));
    // A directory where an artifact goes, so its write fails once the bundle has begun.
    mkdirSync(join(dir, `.${RUN_ID}.partial`, 'artifacts', 'meta.json'), {
      recursive: true,
    });
    await expect(
      writeBundle({
        outDir: dir,
        manifest: MANIFEST,
        artifacts: { 'meta.json': '{}' },
        counts: new Map(),
      }),
    ).rejects.toThrow(/EISDIR/);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, RUN_ID))).toBe(false);
  });
});

describe('starterLockDigest', () => {
  it("is a stable SHA-256 of the starter's committed files and locks", () => {
    expect(starterLockDigest('nextjs')).toMatch(/^[0-9a-f]{64}$/);
    expect(starterLockDigest('nextjs')).toBe(starterLockDigest('nextjs'));
    expect(starterLockDigest('nextjs')).not.toBe(starterLockDigest('rails'));
  });
});

describe('bundleManifestSchema', () => {
  const full = (part: Record<string, unknown>) => {
    const { stack: _stack, ...rest } = MANIFEST;
    return { bundleVersion: 1, ...rest, ...part, artifacts: [] };
  };
  const REPOSITORY = {
    remoteUrl: 'https://github.com/acme/app.git',
    commit: 'a'.repeat(40),
  };

  it('takes a repository in place of a stack, with or without a remote', () => {
    expect(
      bundleManifestSchema.parse(full({ repository: REPOSITORY })).repository,
    ).toEqual(REPOSITORY);
    expect(() =>
      bundleManifestSchema.parse(
        full({ repository: { ...REPOSITORY, remoteUrl: null } }),
      ),
    ).not.toThrow();
  });

  it('refuses both a stack and a repository, or neither', () => {
    expect(() =>
      bundleManifestSchema.parse(
        full({ stack: MANIFEST.stack, repository: REPOSITORY }),
      ),
    ).toThrow(/a stack or a repository, not both/);
    expect(() => bundleManifestSchema.parse(full({}))).toThrow(
      /a stack or a repository, not both/,
    );
  });

  it('refuses a remote URL with credentials, and a commit that is not a full id', () => {
    expect(() =>
      bundleManifestSchema.parse(
        full({
          repository: {
            ...REPOSITORY,
            remoteUrl: 'https://user:token@github.com/acme/app.git',
          },
        }),
      ),
    ).toThrow(/a remote URL is its host and path alone/);
    for (const remoteUrl of [
      'https::https://user:SECRET@host.example/repo',
      'https://host.example/repo?private_token=abc',
      'https://host.example/repo#x',
      'user@host.example:repo',
    ])
      expect(() =>
        bundleManifestSchema.parse(
          full({ repository: { ...REPOSITORY, remoteUrl } }),
        ),
      ).toThrow(/a remote URL is its host and path alone/);
    expect(() =>
      bundleManifestSchema.parse(
        full({ repository: { ...REPOSITORY, commit: 'abc1234' } }),
      ),
    ).toThrow();
  });
});
