/**
 * ABOUTME: Tests the sandbox platform choice from Docker's reported architecture, and the
 * refusal of an architecture with no sandbox build.
 */
import { describe, expect, it } from 'vitest';

import { sandboxPlatform, UnsupportedArchitectureError } from './platform';

describe('sandboxPlatform', () => {
  it.each([
    ['x86_64', 'linux/amd64'],
    ['amd64', 'linux/amd64'],
    ['aarch64', 'linux/arm64'],
    ['arm64', 'linux/arm64'],
  ])('runs a %s host as %s', (architecture, platform) => {
    expect(sandboxPlatform(architecture)).toBe(platform);
  });

  it.each(['riscv64', 'armv7l', 's390x', '', 'toString'])(
    'refuses %j by name',
    (architecture) => {
      expect(() => sandboxPlatform(architecture)).toThrow(
        UnsupportedArchitectureError,
      );
      expect(() => sandboxPlatform(architecture)).toThrow(
        `Agent Picks runs on x86_64 or arm64 machines, and Docker reports ${architecture || 'no architecture'}.`,
      );
    },
  );
});
