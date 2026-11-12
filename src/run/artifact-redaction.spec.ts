/**
 * ABOUTME: Holds the CLI's artifact redaction to its structural invariant: every JSONL line that
 * parses before masking still parses after, with the same keys. Includes a reconstruction of a
 * real Codex transcript that read Next.js's environment-variable docs, whose elided
 * `BEGIN RSA … END DSA` key once masked every record after it.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  redactArtifacts,
  WRITTEN_SECRETS_LIMIT,
  WrittenSecretsLimitError,
} from './artifact-redaction';

/** The keys and kinds of value of each line that parses as JSON, by line number. */
function jsonShapes(text: string): Map<number, string> {
  const shape = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(shape)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, shape(item)]),
          )
        : typeof value;
  const shapes = new Map<number, string>();
  text.split('\n').forEach((line, i) => {
    try {
      shapes.set(i, JSON.stringify(shape(JSON.parse(line))));
    } catch {
      // Not a JSON line.
    }
  });
  return shapes;
}

/** The Next.js docs on multi-line environment variables, as the agent fetched them. */
const NEXT_ENV_DOCS = [
  '> # .env',
  '>',
  '> # you can write with line breaks',
  '> PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
  '> ...',
  '> Kh9NV...',
  '> ...',
  '> -----END DSA PRIVATE KEY-----"',
  '>',
  '> # or with `\\n` inside double quotes',
  '> PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nKh9NV...\\n-----END DSA PRIVATE KEY-----\\n"',
].join('\n');

/** A 26-record Codex transcript with the docs in record 10's command output. */
function nextEnvDocsTranscript(): string {
  return [
    ...Array.from({ length: 9 }, (_, i) =>
      JSON.stringify({
        type: 'item.completed',
        item: { id: `item_${i}`, type: 'agent_message', text: `step ${i}` },
      }),
    ),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_9',
        type: 'command_execution',
        command:
          'curl -s https://nextjs.org/docs/app/guides/environment-variables',
        aggregated_output: NEXT_ENV_DOCS,
        exit_code: 0,
      },
    }),
    ...Array.from({ length: 16 }, (_, i) =>
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1000 + i, output_tokens: 50 },
      }),
    ),
  ].join('\n');
}

describe('redactArtifacts keeps JSONL whole', () => {
  it('keeps every record of a transcript that quotes a key with mismatched BEGIN and END labels', () => {
    const transcript = nextEnvDocsTranscript();
    const masked = redactArtifacts({ 'transcript.jsonl': transcript }, [])
      .artifacts['transcript.jsonl']!;
    expect(jsonShapes(masked)).toEqual(jsonShapes(transcript));
    expect(jsonShapes(transcript).size).toBe(26);
    // The records after the docs are untouched.
    expect(masked.split('\n').slice(10)).toEqual(
      transcript.split('\n').slice(10),
    );
  });

  it('masks a private key to its END marker, and text after it stays', () => {
    const diff = [
      '+-----BEGIN PRIVATE KEY-----',
      '+MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
      '+-----END PRIVATE KEY-----',
      '+const kept = true;',
    ].join('\n');
    const masked = redactArtifacts({ 'diff.patch': diff }, []).artifacts[
      'diff.patch'
    ]!.split('\n');
    expect(masked).toEqual([
      '+[redacted]',
      '[redacted]',
      '[redacted]',
      '+const kept = true;',
    ]);
  });

  describe('a key cut short by `head -n 20`', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const head = privateKey.split('\n').slice(0, 20);
    const body = head.slice(1);
    const leaked = (text: string) => body.filter((line) => text.includes(line));

    it('is masked to the end of the command output it sits in, in a Codex transcript', () => {
      const transcript = [
        JSON.stringify({ type: 'item.started', item: { id: 'item_1' } }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'item_1',
            type: 'command_execution',
            command: 'head -n 20 signing-key.pem',
            aggregated_output: `${head.join('\n')}\n`,
            exit_code: 0,
          },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9 } }),
      ].join('\n');
      const masked = redactArtifacts({ 'transcript.jsonl': transcript }, [])
        .artifacts['transcript.jsonl']!;
      expect(head[0]).toBe('-----BEGIN RSA PRIVATE KEY-----');
      expect(leaked(masked)).toEqual([]);
      expect(jsonShapes(masked)).toEqual(jsonShapes(transcript));
      const [first, record, last] = masked.split('\n');
      expect(first).toBe(transcript.split('\n')[0]);
      expect(JSON.parse(record!).item.command).toBe(
        'head -n 20 signing-key.pem',
      );
      expect(last).toBe(transcript.split('\n')[2]);
    });

    it('is masked to the first blank line in plain text, and what follows stays', () => {
      const text = [
        '$ head -n 20 signing-key.pem',
        ...head,
        '',
        '$ echo done',
        'done',
      ].join('\n');
      const masked = redactArtifacts({ 'agent.err': text }, []).artifacts[
        'agent.err'
      ]!;
      expect(leaked(masked)).toEqual([]);
      expect(masked.split('\n')).toEqual([
        '$ head -n 20 signing-key.pem',
        ...head.map(() => '[redacted]'),
        '',
        '$ echo done',
        'done',
      ]);
    });
  });

  it('masks string by string when a rule would cross a JSON line’s structure', () => {
    const line = JSON.stringify({
      url: 'https://docs.example.dev',
      contact: 'ops@example.dev',
    });
    expect(
      redactArtifacts({ 'transcript.jsonl': line }, []).artifacts[
        'transcript.jsonl'
      ],
    ).toBe(line);
  });
});

describe('a secret used as a JSON key', () => {
  const credential = 'sk-ant-api03-realcredential-0123456789';
  const masked = (artifacts: Record<string, string>) =>
    redactArtifacts(artifacts, [credential]).artifacts['transcript.jsonl'];

  it('is masked when a value sends the line string by string', () => {
    const line = JSON.stringify({
      [credential]: 1,
      x: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow',
    });
    expect(masked({ 'transcript.jsonl': line })).toBe(
      '{"[redacted]":1,"x":"[redacted]"}',
    );
  });

  it('is masked when the key alone changes the line’s shape, for a secret the run wrote', () => {
    const secret = 'q8XvN2pLr7Tk4WbY9mZc3HdF6sJa1GeU';
    expect(
      masked({
        'diff.patch': `+++ b/.env.local\n+AUTH_SECRET=${secret}\n`,
        'transcript.jsonl': JSON.stringify({ [secret]: { ok: true } }),
      }),
    ).toBe('{"[redacted]":{"ok":true}}');
  });

  it('is masked with the whole line when it is a key in serialized JSON, which keeps the line’s shape', () => {
    const line = (key: string) =>
      JSON.stringify({
        type: 'tool_result',
        content: JSON.stringify({ [key]: 1 }),
      });
    expect(masked({ 'transcript.jsonl': line(credential) })).toBe(
      line('[redacted]'),
    );
  });
});

describe('the written-secrets limit', () => {
  const envFile = (count: number) =>
    `+++ b/.env\n${Array.from(
      { length: count },
      (_, i) =>
        `+API_KEY_${i}=${i.toString(36).padStart(4, '0')}x8XvN2pLr7Tk4WbY9mZc\n`,
    ).join('')}`;

  it('redacts a run that wrote up to the limit', () => {
    const { artifacts } = redactArtifacts(
      { 'diff.patch': envFile(WRITTEN_SECRETS_LIMIT) },
      [],
    );
    expect(artifacts['diff.patch']!.match(/=\[redacted\]/g)).toHaveLength(
      WRITTEN_SECRETS_LIMIT,
    );
  });

  it('throws for a run that wrote more', () => {
    expect(() =>
      redactArtifacts({ 'diff.patch': envFile(WRITTEN_SECRETS_LIMIT + 1) }, []),
    ).toThrow(WrittenSecretsLimitError);
  });
});
