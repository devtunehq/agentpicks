/**
 * ABOUTME: Builds the data-driven in-sandbox assets: make-env.sh for one catalogue
 * environment (lay down its committed starter, install it frozen from its locks, strip
 * agent instructions, commit the baseline), lock-starter.sh, which regenerates a starter's
 * locks, and watch-pick.sh with the category's early-stop patterns.
 */
import type { EarlyStopPatterns } from '../catalogue/early-stop';
import {
  STARTERS,
  type EnvironmentDefinition,
  type StarterRecipe,
} from '../catalogue/environments';
import { script, shellQuote } from './script';
import { RUNTIMES_SH, UNPACK_FN } from './static-scripts';

/** The agent instruction files and directories a stripped environment removes. */
export const INSTRUCTION_FILES =
  'AGENTS.md CLAUDE.md GEMINI.md .cursor .cursorrules .windsurfrules .github/copilot-instructions.md .claude .agents';

/** Python's hashed lock, kept outside the project because no Python generator writes one. */
const PYTHON_LOCK = '/opt/agent-picks/locks/requirements.lock';

/**
 * Installs the project in the current directory from its committed locks only, frozen:
 * nothing is resolved, so an upstream release cannot change the graph between runs of a
 * test. The one install path for every environment; the catalogue test holds every
 * starter to it.
 */
export const INSTALL_LOCKED_SH = [
  script`if [ -f package-lock.json ]; then npm ci --no-audit --no-fund >>/tmp/install.log 2>&1; fi
if [ -f Gemfile.lock ]; then BUNDLE_FROZEN=true bundle install >>/tmp/install.log 2>&1; fi`,
  `if [ -f ${PYTHON_LOCK} ]; then`,
  '  python3 -m venv .venv >>/tmp/install.log 2>&1',
  `  .venv/bin/pip install --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r ${PYTHON_LOCK} >>/tmp/install.log 2>&1`,
  'fi',
].join('\n');

/** Runs `body` under set -e in a subshell; a failure prints `failure` and exits 3. */
export function stopOnFailure(body: string, failure: string): string {
  // Its status is tested on the next line because bash ignores set -e inside a command
  // that is part of `||`.
  return `(\nset -e\n${body}\n)\n[ $? -eq 0 ] || { echo ${shellQuote(failure)}; tail -30 /tmp/install.log /tmp/gen.log 2>/dev/null; exit 3; }`;
}

/** `bash make-env.sh`: lays down /work/app for the environment and commits it as the baseline. */
export function buildMakeEnvScript(environment: EnvironmentDefinition): string {
  const recipe: StarterRecipe = STARTERS[environment.starter];
  return [
    script`#!/usr/bin/env bash
# Creates /work/app for one Agent Picks environment from its committed starter, installs its
# dependencies frozen from the starter's locks, optionally strips agent instruction files,
# records what instruction files exist, and commits the baseline.
set -uo pipefail
S=/opt/agent-picks`,
    `ENVIRONMENT=${shellQuote(environment.slug)}`,
    `STRIP=${environment.stripInstructions ? 'true' : 'false'}`,
    UNPACK_FN,
    script`rm -rf /work $S/locks && mkdir -p /work/app $S/locks && cd /work
export CI=1 npm_config_yes=true`,
    recipe.runtimeScript
      ? stopOnFailure(recipe.runtimeScript, 'runtime install failed')
      : '',
    stopOnFailure(
      'unpack /work/app $S/starter.tsv\nunpack $S/locks $S/starter-locks.tsv',
      'starter failed',
    ),
    'cd /work/app',
    stopOnFailure(INSTALL_LOCKED_SH, 'frozen install failed'),
    script`# Record agent instruction files shipped by the starter.
INSTR=$(ls -d AGENTS.md CLAUDE.md GEMINI.md .cursor .cursorrules .windsurfrules .github/copilot-instructions.md .claude .agents 2>/dev/null | tr '\n' ' ')
BUNDLED=$([ -d node_modules/next/dist/docs ] && echo next-bundled-docs)
HASH=$(cat AGENTS.md CLAUDE.md .cursorrules .github/copilot-instructions.md 2>/dev/null | sha256sum | cut -c1-12)`,
    `if [ "$STRIP" = true ]; then rm -rf ${INSTRUCTION_FILES}; fi`,
    script`git init -q 2>/dev/null; git config user.email agent-picks@devtune.ai; git config user.name agent-picks
git add -A >/dev/null 2>&1 && git commit -qm baseline --allow-empty
{ cat .cta.json 2>/dev/null; ls -laR .tanstack .github 2>/dev/null | head -40; } > /opt/agent-picks/out/starter-extra.txt
chmod -R a+rwX /work
echo "{\"env\":\"$ENVIRONMENT\",\"instructionFiles\":\"$INSTR\",\"bundledDocs\":\"$BUNDLED\",\"instrHash\":\"$HASH\",\"stripped\":$STRIP}" > /opt/agent-picks/out/env.json
cat /opt/agent-picks/out/env.json
`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * RUNTIMES_SH under errexit in the current shell, so its PATH changes persist and a failed
 * download or checksum stops the script before anything uses the runtimes.
 */
export function pinnedRuntimes(): string {
  return `set -e\n${RUNTIMES_SH}\nset +e`;
}

/** The uv that hashes Python's lock; it runs only when the locks are regenerated. */
export const UV_VERSION = '0.13.0';

/**
 * `bash lock-starter.sh`, run only by the maintainer lock script: with the runtimes setup
 * pins, runs the starter's generator exactly as setup once did (its own install included),
 * locks what it installed with integrity hashes where the generator's lockfile carries
 * none, and packs the project to out/starter.tsv and the locks kept outside it to
 * out/starter-locks.tsv, without what the frozen install recreates.
 */
export function buildLockStarterScript(recipe: StarterRecipe): string {
  return [
    script`#!/usr/bin/env bash
# Regenerates one committed Agent Picks starter and its locks.
set -uo pipefail
S=/opt/agent-picks
rm -rf /work $S/locks && mkdir -p /work $S/out $S/locks && cd $S`,
    pinnedRuntimes(),
    recipe.runtimeScript
      ? stopOnFailure(recipe.runtimeScript, 'runtime install failed')
      : '',
    script`cd /work
export CI=1 npm_config_yes=true`,
    stopOnFailure(recipe.generateScript, 'generator failed'),
    script`cd /work/app || { echo "generator left no /work/app"; exit 3; }`,
    stopOnFailure(
      [
        "# Python: exactly what the generator installed, each with the hashes pip's --require-hashes checks.",
        'if [ -x .venv/bin/pip ]; then',
        '  .venv/bin/pip freeze > /tmp/installed.txt',
        `  python3 -m pip install -q --disable-pip-version-check uv==${UV_VERSION}`,
        `  python3 -m uv pip compile --quiet --no-header --no-annotate --no-deps --generate-hashes --only-binary :all: --python .venv/bin/python -o ${PYTHON_LOCK} /tmp/installed.txt`,
        'fi',
        "# Ruby: the generator's Gemfile.lock, with the checksums Bundler verifies on install,",
        '# and otherwise unchanged.',
        'if [ -f Gemfile.lock ]; then',
        '  cp Gemfile.lock /tmp/Gemfile.lock.generated',
        '  bundle lock --add-checksums >/dev/null',
        '  without_checksums() { sed \'/^CHECKSUMS$/,/^$/d\' "$1"; }',
        '  [ "$(without_checksums /tmp/Gemfile.lock.generated)" = "$(without_checksums Gemfile.lock)" ] || { echo "adding checksums changed Gemfile.lock"; exit 1; }',
        'fi',
      ].join('\n'),
      'locking failed',
    ),
    script`# capture <dir>: every file, link and empty directory under it, packed as unpack reads
# it, without the directories the frozen install recreates and Rails' boot cache, which
# the generator's own boot left and the next boot rebuilds.
capture() {
  (cd "$1" && find . \( -name node_modules -o -name .venv -o -name .git -o -path ./tmp/cache \) -prune -o \( -type f -o -type l -o -type d -empty \) -print \
    | sed 's|^\./||' | grep -vx '\.' | LC_ALL=C sort | while IFS= read -r p; do
    if [ -L "$p" ]; then printf 'link\t%s\t%s\n' "$p" "$(readlink "$p" | base64 -w0)"
    elif [ -d "$p" ]; then printf 'dir\t%s\t\n' "$p"
    elif [ -x "$p" ]; then printf '755\t%s\t%s\n' "$p" "$(base64 -w0 < "$p")"
    else printf '644\t%s\t%s\n' "$p" "$(base64 -w0 < "$p")"; fi
  done)
}
capture /work/app > $S/out/starter.tsv
capture $S/locks > $S/out/starter-locks.tsv
echo locked
`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * `bash watch-pick.sh <app-dir> <grace-sec>`: polls for a pick (an install matching the
 * category's install pattern, or code matching its code pattern), waits the grace period
 * so the agent can change its mind, then stops Claude Code and records why.
 */
export function buildWatchPickScript(patterns: EarlyStopPatterns): string {
  for (const p of [
    patterns.installPattern,
    patterns.codePattern,
    patterns.pathPattern ?? '',
  ]) {
    if (p.includes("'"))
      throw new Error('early-stop patterns cannot contain single quotes');
  }
  return [
    script`#!/usr/bin/env bash
# Early-stop watcher. Polls the project for a pick, waits a grace
# period so the agent can change its mind, then stops the agent and records why.
APP="$1"; GRACE="$2"; START=$(date +%s)`,
    `PICKPKG='${patterns.installPattern}'`,
    `PICKCODE='${patterns.codePattern}'`,
    ...(patterns.pathPattern ? [`PICKPATH='${patterns.pathPattern}'`] : []),
    script`cd "$APP"
BASE=$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)
# Source files and templates (a Payment Link can live only in a Rails or EJS view), plus the env and
# YAML config a tool can be wired in through without its SDK (.env.example, Rails'
# database.yml). Lockfiles stay out, as they do in the classifier's diff.
code_files() { grep -vE '^(node_modules|\.venv|vendor|\.next|tmp|log)/' | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue|astro|py|rb|erb|ejs|haml|slim|html|jinja2?|ya?ml)$|(^|/)\.env[^/]*$' | grep -vE '(^|/)pnpm-lock\.yaml$' | head -200; }
# Dependency entries of manifest $1 read from stdin. Other fields (description, scripts,
# keywords) can name a tool without installing it.
deps() {
  case "$\{1##*/}" in
    package.json) awk '/"(dev|peer|optional)?[dD]ependencies"[[:space:]]*:[[:space:]]*\{/ {d=1; next} d && /\}/ {d=0} d' ;;
    Gemfile) grep -E '^[[:space:]]*gem[[:space:]]' ;;
    requirements*.txt) grep -vE '^[[:space:]]*(#|-|$)' ;;
    pyproject.toml) awk '/^\[/ {s = ($0 ~ /dependencies\]$/); next} /^[[:space:]]*(dependencies|requires)[[:space:]]*=[[:space:]]*\[/ {a=1} s || a; a && /\]/ {a=0}' ;;
  esac
}
# Package names, quoted and normalised, on the dependency entries of manifest $1 read from
# stdin. Comparing names rather than whole lines keeps a version bump or reformat of a
# baseline dependency from reading as a new one.
names() {
  case "$\{1##*/}" in
    package.json) sed -nE 's/^[[:space:]]*"([^"]+)"[[:space:]]*:.*/"\1"/p' ;;
    Gemfile) sed -nE "s/^[[:space:]]*gem[[:space:]]+['\"]([^'\"]+)['\"].*/\"\1\"/p" ;;
    requirements*.txt) sed -nE 's/^[[:space:]]*([A-Za-z0-9_.-]+).*/"\1"/p' ;;
    pyproject.toml) grep -oE "[\"'][A-Za-z0-9_.-]+|^[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*=" | sed -E "s/^[\"'[:space:]]*//; s/[[:space:]]*=$//; s/.*/\"&\"/" ;;
  esac | tr 'A-Z_' 'a-z-' | sort -u
}
reason=""
while [ -z "$reason" ]; do
  sleep 5
  # Dependencies now present that the baseline lacked. Manifests the baseline lacks
  # are untracked, so they are read from disk rather than from git diff. The manifest set
  # matches what the final artifact dump covers, nested package.json files included.
  if for f in Gemfile requirements.txt requirements-dev.txt pyproject.toml \
       $(find . -maxdepth 3 -name package.json -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\./||'); do
       [ -f "$f" ] || continue
       deps "$f" < "$f" | names "$f" | grep -vxF -f <(git show "$BASE:$f" 2>/dev/null | deps "$f" | names "$f"; echo)
     done | grep -qiE "$PICKPKG"; then reason=install; break; fi
  # Code the agent added: + lines of tracked files, untracked files whole. Removed and
  # context lines of an edited file are not a pick.
  changed=$(git diff --name-only $BASE 2>/dev/null | code_files)
  untracked=$(git ls-files --others --exclude-standard 2>/dev/null | code_files)
  if { [ -n "$changed" ] && echo "$changed" | xargs -d '\n' git diff $BASE -- 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+ '
       [ -n "$untracked" ] && echo "$untracked" | xargs -d '\n' cat 2>/dev/null
     } | grep -qE "$PICKCODE"; then reason=code; break; fi`,
    ...(patterns.pathPattern
      ? [
          script`  # Config files the agent created. A file the starter had is read above, by its + lines.
  if { git diff --name-only --diff-filter=A $BASE; git ls-files --others --exclude-standard; } 2>/dev/null \
       | grep -vE '^(node_modules|\.venv|vendor|\.next|tmp|log)/' | grep -qE "$PICKPATH"; then reason=code; break; fi`,
        ]
      : []),
    script`done
T=$(date +%s)
OUT=/opt/agent-picks/out
REC="\"reason\":\"$reason\",\"triggerSec\":$((T-START)),\"graceSec\":$GRACE"
record() { echo "{$REC$1}" > $OUT/earlystop.tmp && mv $OUT/earlystop.tmp $OUT/earlystop.json; }
record ""
sleep "$GRACE"
# stopping tells run-agent.sh to wait for the result rather than stop this watcher.
record ',"stopping":true'
# killed is true only when the agent's session was found and is gone afterwards.
record ",$(bash /opt/agent-picks/stop-agent.sh /opt/agent-picks/agent.sid)"
`,
  ].join('\n');
}
