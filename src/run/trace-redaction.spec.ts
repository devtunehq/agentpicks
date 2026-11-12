/** ABOUTME: Checks real pinned provider signatures independently of supplied-secret and structural rules. */
import { expect, it } from 'vitest';

import { redactTrace } from './trace-redaction';
import {
  GITLEAKS_DROPPED,
  GITLEAKS_RULES,
  GITLEAKS_VERSION,
} from './trace-rules.generated';

it.each([
  ['github', 'ghp_' + 'a'.repeat(36)],
  ['anthropic', 'sk-ant-api03-' + 'a'.repeat(93) + 'AA'],
  ['openai', 'sk-' + 'a'.repeat(20) + 'T3BlbkFJ' + 'b'.repeat(20)],
  ['aws', 'AKIA' + 'A'.repeat(16)],
  ['stripe', 'sk_live_' + 'a'.repeat(24)],
  ['slack', 'xoxb-' + '123456789012-'.repeat(2) + 'abcdefghijklmnopqrstuvwx'],
])(
  'uses the pinned %s signature without a name or supplied secret',
  (_name, value) => {
    expect(redactTrace('before ' + value + ' after', {})).toBe(
      'before [redacted] after',
    );
  },
);
it('pins the maintained rules and records every exclusion', () => {
  expect(GITLEAKS_VERSION).toBe('v8.30.1');
  expect(GITLEAKS_RULES).toHaveLength(218);
  expect(Object.keys(GITLEAKS_DROPPED)).toHaveLength(4);
});
