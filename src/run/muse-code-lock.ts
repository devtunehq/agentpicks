/**
 * ABOUTME: The pinned Muse Code CLI: Meta's Linux x86-64 release binary, by version, URL, size and SHA-256, from the
 * release manifest the public `muse-stable` channel names (https://api.meta.ai/muse-code/channels/muse-stable).
 * Muse Code ships as one native binary, not an npm graph, so this pin is its lock.
 */
export const MUSE_CODE_LOCK = {
  version: '1.4.14-R7309.1',
  url: 'https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.14-R7309.1&file=muse-x86-linux',
  size: 414_927_192,
  sha256: '0809aac7cb58d18f5022b6d05e02aa1974683c0ec430e5f04d25b60ed17de2da',
} as const;
