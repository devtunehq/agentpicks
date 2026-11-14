/**
 * ABOUTME: Which characters untrusted text may not put on the host's terminal, beyond C0 and C1 controls:
 * the bidirectional controls and zero-width formatting characters that can reorder or hide what a line shows.
 */

/** Whether a code point is a bidirectional control or a zero-width formatting character. */
export function isFormatControl(code: number): boolean {
  return (
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}
