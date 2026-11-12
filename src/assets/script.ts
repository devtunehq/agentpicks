/**
 * ABOUTME: Helpers for writing the in-sandbox shell and Python assets as TypeScript text,
 * so they bundle with the package instead of being read from disk at run time.
 */

/** Where every asset, the prompt and the run artifacts live inside the sandbox. */
export const SANDBOX_ROOT = '/opt/agent-picks';

/**
 * Tag for raw script text. Backslashes are kept as written; write `$\{` wherever the script
 * needs `${`, because a template literal would interpolate it. Takes no substitutions.
 */
export function script(strings: TemplateStringsArray): string {
  return String.raw({ raw: strings.raw }).replaceAll('$\\{', '${');
}

/** Single-quotes a value for bash. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
