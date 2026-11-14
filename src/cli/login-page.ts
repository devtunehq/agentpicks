/**
 * ABOUTME: The page the browser shows when DevTune redirects back to `agentpicks login`'s loopback
 * callback, ported from @devtune/cli's login page without its lockup: fixed copy, one stylesheet
 * pinned by hash, and no scripts, remote assets or anything from the request.
 */
import { createHash } from 'node:crypto';

const styles = `
:root { color-scheme: light dark; --canvas: #fafafa; --text: #1a1a1c; --muted: #62626c; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 32px 24px; background: var(--canvas); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; }
main { width: 100%; max-width: 480px; }
h1 { margin: 0 0 14px; font-size: clamp(28px, 5vw, 36px); font-weight: 600; line-height: 1.2; letter-spacing: -1.1px; text-wrap: balance; }
p { margin: 0; color: var(--muted); font-size: 16px; line-height: 1.65; text-wrap: pretty; }
.hint { margin-top: 32px; font-size: 13px; }
@media (prefers-color-scheme: dark) { :root { --canvas: #0a0a0a; --text: #fafafa; --muted: #8a8a8a; } }
`;

/** Only this fixed stylesheet may apply; the page needs no scripts or network requests. */
export const loginPageCsp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

const messages = {
  success: {
    heading: "You're signed in",
    message: 'Return to your terminal.',
    hint: 'You can close this tab.',
  },
  failed: {
    heading: "Couldn't finish signing in",
    message:
      'Return to your terminal for the error, then run agentpicks login again.',
    hint: 'Your terminal has the details.',
  },
  denied: {
    heading: 'Sign-in was not approved',
    message: 'Return to your terminal and run agentpicks login to try again.',
    hint: 'You can close this tab.',
  },
  invalid: {
    heading: 'Invalid sign-in callback',
    message: 'Return to your terminal to continue signing in.',
    hint: 'You can close this tab.',
  },
};

/** All copy is fixed; never interpolate request parameters, tokens or error details. */
export function loginPage(state: keyof typeof messages) {
  const { heading, message, hint } = messages[state];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${heading} · DevTune</title>
<style>${styles}</style>
</head>
<body>
<main>
<h1>${heading}</h1>
<p>${message}</p>
<p class="hint">${hint}</p>
</main>
</body>
</html>`;
}
