/** ABOUTME: Covers which assigned values count as secrets a run wrote, by each line's grammar, and which are empty, placeholders, references, numbers or code. */
import { describe, expect, it } from 'vitest';

import { escapedForms, writtenSecrets } from './written-secrets';

const SECRET = 'q8XvN2pLr7Tk4WbY9mZc3HdF6sJa1GeU';
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEF';

describe('writtenSecrets: dotenv and shell lines', () => {
  it.each([
    ['a bare value', `AUTH_SECRET=${SECRET}`, [SECRET]],
    ['a bare value of letters only', `AUTH_SECRET=${LETTERS}`, [LETTERS]],
    ['an exported value', `export NEXTAUTH_SECRET=${SECRET}`, [SECRET]],
    ['a double-quoted value', `AUTH_SECRET="${SECRET}"`, [SECRET]],
    ['a single-quoted value', `AUTH_SECRET='${LETTERS}'`, [LETTERS]],
    [
      'a value an environment variable is named',
      'TOKEN=SENTRY_AUTH_TOKEN_VALUE',
      ['SENTRY_AUTH_TOKEN_VALUE'],
    ],
    ['a diff line', `+API_KEY=${SECRET}`, [SECRET]],
    ['a removed diff line', `-STRIPE_SECRET_KEY=${SECRET}`, [SECRET]],
    ['a command prefix', `API_TOKEN=${SECRET} npm run dev`, [SECRET]],
    [
      'escapes, as written and decoded',
      'AUTH_SECRET="ab\\"cd\\\\ef$ghijk"',
      ['ab"cd\\ef$ghijk', 'ab\\"cd\\\\ef$ghijk'],
    ],
    [
      'a bare value with an escape',
      'DB_PASSWORD=pa\\$\\$word12345',
      ['pa$$word12345', 'pa\\$\\$word12345'],
    ],
  ])('finds %s', (_case, text, values) => {
    expect(writtenSecrets([text])).toEqual(values);
  });

  it.each([
    [
      'an empty assignment before a command',
      'SENTRY_DSN= .venv/bin/python manage.py runserver',
    ],
    ['an empty quoted command', 'SENTRY_DSN= ".venv/bin/python"'],
    ['an empty value', 'SENTRY_AUTH_TOKEN='],
    ['a short value', 'API_KEY=abc123'],
    ['a placeholder', 'STRIPE_SECRET_KEY=sk_test_your_key_here'],
    ['changeme', 'DB_PASSWORD=changeme-changeme'],
    ['a reference', 'AUTH_SECRET=${AUTH_SECRET_FROM_VAULT}'],
    ['a command substitution', 'AUTH_SECRET=$(openssl rand -base64 32)'],
    ['a name that is not secret', `NEXTAUTH_URL=${SECRET}`],
  ])('ignores %s', (_case, text) => {
    expect(writtenSecrets([text])).toEqual([]);
  });
});

describe('writtenSecrets: dotenv files', () => {
  const spaced = `AUTH_SECRET = ${SECRET}`;

  it('reads a Write or Edit to a dotenv file with whitespace around `=`', () => {
    const write = { file_path: '/work/app/.env.local', content: `${spaced}\n` };
    const edit = {
      file_path: '/work/app/.env',
      old_string: 'AUTH_SECRET=',
      new_string: `AUTH_SECRET= ${LETTERS} # generated\n`,
    };
    expect(
      writtenSecrets([
        JSON.stringify({ type: 'tool_use', name: 'Write', input: write }),
      ]),
    ).toEqual([SECRET]);
    expect(
      writtenSecrets([
        JSON.stringify({ type: 'tool_use', name: 'Edit', input: edit }),
      ]),
    ).toEqual([LETTERS]);
  });

  it('reads a diff hunk under a dotenv file the same way, and only there', () => {
    const diff = [
      'diff --git a/.env.local b/.env.local',
      '--- /dev/null',
      '+++ b/.env.local',
      `+${spaced}`,
      'diff --git a/app/config.py b/app/config.py',
      '+++ b/app/config.py',
      `+AUTH_TOKEN = ${LETTERS}`,
    ].join('\n');
    expect(writtenSecrets([diff])).toEqual([SECRET]);
  });

  it('keeps the shell rule elsewhere: whitespace after `=` is an empty assignment', () => {
    expect(
      writtenSecrets([
        JSON.stringify({
          type: 'tool_use',
          name: 'Bash',
          input: { command: `AUTH_SECRET= ${SECRET} npm run dev` },
        }),
        JSON.stringify({ file_path: '/work/app/README.md', content: spaced }),
      ]),
    ).toEqual([]);
  });
});

describe('writtenSecrets: key names', () => {
  it.each([
    ['apiKey', `apiKey: "${SECRET}"`],
    ['signing_key', `signing_key = "${SECRET}"`],
    ['clientKey', `{"clientKey": "${SECRET}"}`],
    ['an upper-case KEY', `STRIPE_KEY=${SECRET}`],
    ['an upper-case KEY in YAML', `  LICENSE_KEY: ${SECRET}`],
  ])('counts %s', (_case, text) => {
    expect(writtenSecrets([text])).toEqual([SECRET]);
  });

  it.each([
    ['idempotencyKey', `idempotencyKey: "${SECRET}"`],
    ['cacheKey', `{"cacheKey": "${SECRET}"}`],
    ['a bare key', `  key: "${SECRET}"`],
  ])('does not count %s', (_case, text) => {
    expect(writtenSecrets([text])).toEqual([]);
  });
});

describe('writtenSecrets: never across a line break', () => {
  const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';

  it('takes a value its escapes split into lines one line at a time, without PEM labels', () => {
    expect(
      writtenSecrets([
        `PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n${PEM_BODY}\\n-----END PRIVATE KEY-----\\n"`,
      ]),
    ).toEqual([PEM_BODY]);
  });

  it('takes nothing from a quote left open on its line outside a dotenv file', () => {
    expect(
      writtenSecrets([
        'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
        `  private_key: "${PEM_BODY}`,
      ]),
    ).toEqual([]);
  });

  it('takes a dotenv value open across lines a line at a time, in a file tool input and a diff', () => {
    const content = `PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n${SECRET}\n-----END PRIVATE KEY-----"\nNEXT_PUBLIC_URL=https://app.example.dev\n`;
    expect(
      writtenSecrets([
        JSON.stringify({ file_path: '/work/app/.env.local', content }),
      ]),
    ).toEqual([PEM_BODY, SECRET]);
    const diff = `+++ b/.env.local\n${content
      .split('\n')
      .map((line) => `+${line}`)
      .join('\n')}`;
    expect(writtenSecrets([diff])).toEqual([PEM_BODY, SECRET]);
  });

  it('reads a line quoted in Markdown without its quote marks', () => {
    const hex = 'a3f9c81d27e64b05f19e3d8c7a2b6e40';
    expect(
      writtenSecrets([
        JSON.stringify({
          type: 'agent_message',
          text: `Add this to .env.local:\n\n> AUTH_SECRET=${hex}\n`,
        }),
        `> > API_TOKEN="${SECRET}"`,
      ]),
    ).toEqual([hex, SECRET]);
  });

  it('takes nothing from the Next.js docs on multi-line values', () => {
    const docs = [
      '> # .env',
      '> # you can write with line breaks',
      '> PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
      '> ...',
      '> Kh9NV...',
      '> ...',
      '> -----END DSA PRIVATE KEY-----"',
      '> # or with `\\n` inside double quotes',
      '> PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nKh9NV...\\n-----END DSA PRIVATE KEY-----\\n"',
    ].join('\n');
    expect(
      writtenSecrets([JSON.stringify({ aggregated_output: docs })]),
    ).toEqual([]);
  });
});

describe('writtenSecrets: CRLF line endings', () => {
  it('reads dotenv, shell and YAML lines ending in \\r\\n', () => {
    expect(writtenSecrets([`AUTH_SECRET=${SECRET}\r\nPORT=3000\r\n`])).toEqual([
      SECRET,
    ]);
    expect(writtenSecrets([`  POSTGRES_PASSWORD: ${LETTERS}\r\n`])).toEqual([
      LETTERS,
    ]);
  });
});

describe('escapedForms', () => {
  it('escapes a value as JSON up to three levels deep', () => {
    expect(escapedForms('ab"cd')).toEqual([
      'ab"cd',
      'ab\\"cd',
      'ab\\\\\\"cd',
      'ab\\\\\\\\\\\\\\"cd',
    ]);
    expect(escapedForms(SECRET)).toEqual([SECRET]);
  });
});

describe('writtenSecrets: YAML and source', () => {
  it.each([
    ['a YAML value', `  POSTGRES_PASSWORD: ${SECRET}`, [SECRET]],
    ['a YAML list item', `  - api_key: "${SECRET}"`, [SECRET]],
    ['a JSON member', `{"apiKey": "${SECRET}"}`, [SECRET]],
    [
      'a JS property',
      `const client = new Client({ token: '${SECRET}' });`,
      [SECRET],
    ],
    ['a Python keyword', `client = Client(api_key="${SECRET}")`, [SECRET]],
    [
      'a letters-only credential in source',
      `const apiKey = "QwErTyUiOpAsDfGhJk";`,
      ['QwErTyUiOpAsDfGhJk'],
    ],
    [
      'a letters-only credential as a YAML value',
      `  client_secret: ${LETTERS}`,
      [LETTERS],
    ],
    [
      'a JS string with an escape',
      `const secret = "${SECRET}\\"q";`,
      [`${SECRET}"q`, `${SECRET}\\"q`],
    ],
    [
      "a URL's credentials, not its host",
      'SENTRY_DSN=https://0a1b2c3d4e5f6a7b8c9d@o4505.ingest.sentry.io/45071',
      ['0a1b2c3d4e5f6a7b8c9d'],
    ],
  ])('finds %s', (_case, text, values) => {
    expect(writtenSecrets([text])).toEqual(values);
  });

  it.each([
    ['a number', '"input_tokens": 123456789012'],
    ['an env read', '  authToken: process.env.SENTRY_AUTH_TOKEN,'],
    ['a template', "  password: '{{ vault_db_password }}'"],
    [
      'an environment variable name in config',
      '"tokenVariable": "SENTRY_AUTH_TOKEN"',
    ],
    ['an identifier', '  token: sessionTokenValue,'],
    ['a last property identifier', '  token: sessionTokenValue'],
    ['a member path', '  apiKey: config.stripe.apiKey,'],
    ['a type', '  password: string;'],
    ['a call', '  secret: crypto.randomBytes(32).toString("hex")'],
    [
      'a URL with no credentials',
      'KEYCLOAK_URL: https://auth.internal.dev/realms/app',
    ],
    [
      'an example DSN',
      'NEXT_PUBLIC_SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0',
    ],
    ['a package name', '/work/app/node_modules/object-keys:object-keys@1.1.1'],
    ['a scoped package', '"@auth/prisma-adapter": "^2.10.0-beta.12"'],
    ['a comparison', 'if token == "expectedTokenValue123":'],
  ])('ignores %s', (_case, text) => {
    expect(writtenSecrets([text])).toEqual([]);
  });
});

describe('writtenSecrets: JSON', () => {
  it('reads JSON documents and JSONL records decoded, including secret-named members', () => {
    const jsonl = [
      JSON.stringify({ content: `AUTH_SECRET=${LETTERS}\nOTHER=1` }),
      JSON.stringify({ env: { CLIENT_SECRET: SECRET } }),
    ].join('\n');
    expect(writtenSecrets([jsonl])).toEqual([LETTERS, SECRET]);
  });

  it('reads a member as a name only when its key is an identifier, never a path', () => {
    const source = `export function verifyToken(token: string) {\n  return token.length > 0;\n}\n`;
    expect(
      writtenSecrets([
        JSON.stringify({
          'src/lib/token.ts': source,
          'app/api/keys/route.ts': source,
        }),
      ]),
    ).toEqual([]);
  });
});

describe('writtenSecrets: recorded managed runs', () => {
  // Lines from the recorded runs in @kit/agent-picks's __fixtures__ that an earlier harvest took
  // for secrets.
  it.each([
    [
      'an indented keyword argument',
      '+        secret_key=settings.session_secret,',
    ],
    [
      'an indented keyword argument reading a mapping',
      '+        client_secret=values["AUTH0_CLIENT_SECRET"],',
    ],
    [
      'a header name',
      "      has: [{ type: 'header', key: 'Authorization', value: 'x' }],",
    ],
    ['a cookie name', '  key: "_app_session", httponly: true'],
    [
      'a test password with spaces',
      `  -d '{"email":"you@example.com","password":"a sufficiently long password"}'`,
    ],
    [
      'a kebab-case test string',
      "'access_token': 'must-not-be-stored', 'id_token': 'private-token'",
    ],
    [
      'a template interpolation',
      '      idempotencyKey: `connection-test/${randomUUID()}`,',
    ],
    ['a type annotation', '    password: str | None = None'],
    [
      'prose',
      'credentials: those variables are public. The connection is created lazily, so',
    ],
    [
      'an object literal',
      "+	CLERK_SECRET_KEY: { description: 'Clerk secret key' }",
    ],
    ['an earlier redaction', 'token=[REDACTED_SECRET]'],
    [
      'a placeholder to change',
      'SESSION_SECRET=change-this-to-a-long-random-string',
    ],
    [
      'an idempotency key (4dbee938-88f7-4e38-8b19-bd316ccea690/diff.patch:146)',
      '+  idempotencyKey: "welcome/user-123",',
    ],
  ])('ignores %s', (_case, text) => {
    expect(writtenSecrets([text])).toEqual([]);
  });

  it('finds an upper-case assignment inside a command', () => {
    expect(
      writtenSecrets([`echo "AUTH_SECRET=${LETTERS}" >> .env.local`]),
    ).toEqual([LETTERS]);
    expect(
      writtenSecrets([`docker run -e DB_PASSWORD='${SECRET}' postgres`]),
    ).toEqual([SECRET]);
  });
});
