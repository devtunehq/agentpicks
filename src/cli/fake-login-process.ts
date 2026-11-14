/**
 * ABOUTME: A second agentpicks process for the login lock tests, bundled and spawned by
 * devtune-login.spec.ts with an IPC channel: `hold` takes the login lock at argv[3] and keeps it
 * until it is killed; `renew` renews the sign-in saved there and prints the access token, or the
 * refusal's message with exit code 2; `renew-handled` does the same with a one-time interrupt
 * handler that, like `run`'s, stops further renewals and waits on loginSaved before exiting; and
 * `stopped` renews after stopRenewing, as an upload still going after that interrupt would.
 */
import { readFileSync } from 'node:fs';

import {
  loginSaved,
  sessionTokens,
  stopRenewing,
  withLoginLock,
} from './devtune-login';

const [mode, path] = process.argv.slice(2) as [string, string];

if (mode === 'hold') {
  await withLoginLock(path, async () => {
    process.send?.('locked');
    // Listening keeps the IPC channel, and so the process, alive until it is killed.
    await new Promise((resolve) => process.once('message', resolve));
  });
} else {
  if (mode === 'renew-handled')
    process.once('SIGINT', () => {
      stopRenewing();
      void loginSaved().then(() => process.exit(130));
    });
  if (mode === 'stopped') stopRenewing();
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  try {
    process.stdout.write(await sessionTokens(path, saved).accessToken());
  } catch (error) {
    process.stdout.write((error as Error).message);
    process.exitCode = 2;
  }
  process.disconnect?.();
}
