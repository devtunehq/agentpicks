/** ABOUTME: Strips the code points PostgreSQL text and jsonb cannot store from trace text and decoded JSON. */

/** Removes code points PostgreSQL text/jsonb cannot store, preserving valid surrogate pairs. */
export function traceString(value: string): string {
  return value.replaceAll('\u0000', '').replace(/[\uD800-\uDFFF]/gu, '');
}

/** Sanitises decoded JSON, including nested strings and object keys, before summaries are serialised. */
export function traceJson(value: unknown): unknown {
  if (typeof value === 'string') return traceString(value);
  if (Array.isArray(value)) return value.map(traceJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        traceString(key),
        traceJson(item),
      ]),
    );
  return value;
}
