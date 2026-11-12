/** ABOUTME: Redacts DevTune model proxy run tokens from text by their shape. */

/**
 * Every model proxy run token in a text (`apm1.<payload>.<signature>`, both base64url),
 * replaced. A token is minted as its agent starts and kept nowhere, so whatever a run's
 * sandbox writes or prints is redacted by its shape rather than its value.
 */
export function redactModelProxyTokens(text: string): string {
  return text.replace(/apm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
}
