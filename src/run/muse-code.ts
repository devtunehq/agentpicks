/**
 * ABOUTME: Muse Code's pinned install and headless launch. Muse Code runs only through DevTune's
 * model proxy, which decides its models and gives it its base URL (`AGENT_PICKS_MUSE_BASE_URL`), so a
 * self-run cannot launch it; these scripts are uploaded for every managed run that can.
 */
import { script } from '../assets/script';
import { MUSE_CODE_LOCK } from './muse-code-lock';

/** Downloads the pinned binary and refuses it unless its size and SHA-256 match the pin. */
export const INSTALL_MUSE_CODE_SH = `#!/usr/bin/env bash
set -euo pipefail
S=/opt/agent-picks
mkdir -p $S/muse-code $S/muse-home
curl -fsSL --proto '=https' -o $S/muse-code/muse.download '${MUSE_CODE_LOCK.url}'
test "$(wc -c < $S/muse-code/muse.download | tr -d ' ')" = ${MUSE_CODE_LOCK.size}
echo '${MUSE_CODE_LOCK.sha256}  '$S/muse-code/muse.download | sha256sum -c - >/dev/null
chmod 0755 $S/muse-code/muse.download
mv $S/muse-code/muse.download $S/muse-code/muse
ln -sf $S/muse-code/muse $S/node/bin/muse
`;

/**
 * run-agent.sh owns the session, timeout and artifact collection around this command. Approvals and Muse Code's own
 * OS sandbox are off (\`--yolo\`), as every agent runs unattended in its own sandbox; no session log is kept.
 */
export const RUN_MUSE_SH = script`#!/usr/bin/env bash
set -euo pipefail
MODEL="$\{1:?model}"; PROMPT_FILE="$\{2:?prompt file}"
exec muse exec --json --yolo --no-session-log --base-url "$\{AGENT_PICKS_MUSE_BASE_URL:?}" \
  --model "$MODEL" --prompt-file "$PROMPT_FILE" < /dev/null
`;

/** Extends only Muse Code's setup. */
export function museCodeSetupScript(base: string): string {
  return base.replace(
    't1=$(date +%s)',
    () => '. $S/install-muse-code.sh\nt1=$(date +%s)',
  );
}

/** Extends only Muse Code's launch, retaining the common timeout, session and collector. */
export function museCodeRunScript(base: string): string {
  return base.replace(
    'else\n  printenv OPENAI_API_KEY',
    () => `elif [ "$AGENT" = muse ]; then
  setsid -w bash $S/agent-session.sh $S/agent.sid timeout "$TIMEOUT" bash $S/run-muse.sh "$MODEL" "$PROMPT_FILE" > $OUT/transcript.jsonl 2> $OUT/agent.err
  code=$?
else
  printenv OPENAI_API_KEY`,
  );
}
