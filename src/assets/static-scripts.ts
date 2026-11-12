/**
 * ABOUTME: The fixed in-sandbox assets, ported from the spike's scripts/sandbox: setup.sh
 * (pinned runtimes, agent CLIs from their lock, mitmproxy and its CA, then make-env.sh),
 * run-agent.sh (proxy up, agent run with optional early stop, artifacts out) and
 * logger.py (the mitmproxy addon).
 */
import { script } from './script';

/**
 * The runtimes every sandbox pins, for setup.sh and for regenerating the locks: Node and
 * Python, checksum-checked and first on PATH through a profile script that later login
 * shells read and this one sources. Expects `S` to be set and runs under `set -e` in the
 * calling shell, so PATH persists; every step is a simple command, never part of an `&&`
 * list, so errexit stops at the first failure (a checksum mismatch included).
 */
export const RUNTIMES_SH = script`# Runtimes are pinned here (Ruby, for the environments that use it, in make-env.sh) rather
# than taken from the image, checksum-checked and first on PATH for setup, the project and
# the agent, so every sandbox provider resolves the same runtimes and global package paths.
# A login shell reads the profile script; this one sources it.
fetch() {
  curl -fsSL "$1" -o "$2"
  echo "$3  $2" | sha256sum -c - >/dev/null
}
NODE_VERSION=24.22.1
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz" /tmp/node.tgz \
  eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c
mkdir -p $S/node
tar -xzf /tmp/node.tgz -C $S/node --strip-components=1
rm -f /tmp/node.tgz
# python-build-standalone: a relocatable CPython, the same build on any glibc distribution.
fetch "https://github.com/astral-sh/python-build-standalone/releases/download/20261001/cpython-3.13.16+20261001-x86_64-unknown-linux-gnu-install_only.tar.gz" /tmp/python.tgz \
  b55f90dfb060e998a47e4a811dae46aaa27b923244044bbcf88de5e57a5fa4c7
mkdir -p $S/python
tar -xzf /tmp/python.tgz -C $S/python --strip-components=1
rm -f /tmp/python.tgz
ln -sf python3 $S/python/bin/python
ln -sf pip3 $S/python/bin/pip
printf 'export PATH=%s/node/bin:%s/python/bin:%s/ruby/bin:$PATH\nunset NPM_CONFIG_PREFIX npm_config_prefix\n' "$S" "$S" "$S" > /etc/profile.d/zz-agent-picks-runtimes.sh
. /etc/profile.d/zz-agent-picks-runtimes.sh
`;

/**
 * Defines `unpack <dir> <packed-file>`, which lays down committed files packed one per line
 * as `<644|755|dir|link>\t<path>\t<base64>` (see `packEntries`).
 */
export const UNPACK_FN = script`unpack() {
  while IFS=$'\t' read -r mode path data; do
    case "$mode" in
      dir) mkdir -p "$1/$path" ;;
      link) mkdir -p "$(dirname "$1/$path")" && ln -sfn "$(printf %s "$data" | base64 -d)" "$1/$path" ;;
      *) mkdir -p "$(dirname "$1/$path")" && printf %s "$data" | base64 -d > "$1/$path" && chmod "$mode" "$1/$path" ;;
    esac
  done < "$2"
}`;

/**
 * The agent CLIs and pnpm every setup installs, as the recipe that regenerates their
 * committed lock (the `agent-tools` starter). Their versions are pinned here.
 */
export const AGENT_TOOLS_RECIPE = {
  generateScript: script`mkdir -p app && cd app
cat > package.json <<'JSON'
{
  "name": "agent-picks-tools",
  "private": true,
  "dependencies": {
    "@anthropic-ai/claude-code": "2.1.295",
    "@openai/codex": "0.162.0",
    "pnpm": "10.34.6"
  }
}
JSON
npm install --package-lock-only --no-audit --no-fund >/dev/null
cd ..`,
};

/**
 * The commands the agent tools (the `agent-tools` lock) put on PATH, linked into the pinned
 * Node's bin directory where a global install would have put them.
 */
const AGENT_TOOL_BINS = ['pnpm', 'pnpx', 'claude', 'codex'] as const;

/**
 * `bash setup.sh <environment-slug>`: installs pinned Node and Python, the agent CLIs and
 * pnpm from their committed lock, and mitmproxy, then creates /work/app and records its
 * resolved dependency graph (deps.txt).
 */
export const SETUP_SH = [
  script`#!/usr/bin/env bash
# Runs inside a fresh sandbox. Installs pinned Node, pnpm, Python, agent CLIs and mitmproxy,
# creates the CA, and prepares the project directory for one environment.
set -euo pipefail
ENVIRONMENT="$\{1:?environment}"
export DEBIAN_FRONTEND=noninteractive
S=/opt/agent-picks
mkdir -p $S/bin $S/out
cd $S
# The leaked eMudhra intermediate CA keys (CVE-2026-111943) chain to these two roots. Block
# them in the system store, which curl, git, Python and the proxy's upstream checks read,
# until the images' ca-certificates distrust them. Both providers' images are RHEL-family.
# E2B mounts a copy of the bundles made at boot, with its own proxy CA, over
# /etc/pki/tls/certs instead of linking them to the extracted store: its certificates are
# kept as anchors (a blocked root stays blocked) and the result written back over the copy.
boot=/etc/pki/tls/certs/ca-bundle.crt
[ -L $boot ] || cp $boot /etc/pki/ca-trust/source/anchors/agent-picks-boot-bundle.pem
d=/etc/pki/ca-trust/source/blocklist; [ -d $d ] || d=/etc/pki/ca-trust/source/blacklist
trust extract --overwrite --format=pem-bundle --filter='pkcs11:object=Comodo%20AAA%20Services%20root;type=cert' $d/Comodo_AAA_Services_root.pem
trust extract --overwrite --format=pem-bundle --filter='pkcs11:object=emSign%20ECC%20Root%20CA%20-%20G3;type=cert' $d/emSign_ECC_Root_CA_-_G3.pem
update-ca-trust
if [ ! -L $boot ]; then
  cp /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem $boot
  cp /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem /etc/pki/tls/certs/ca-certificates.crt
  cp /etc/pki/ca-trust/extracted/openssl/ca-bundle.trust.crt /etc/pki/tls/certs/ca-bundle.trust.crt
fi

t0=$(date +%s)`,
  RUNTIMES_SH,
  UNPACK_FN,
  script`# The agent CLIs and pnpm install from their committed lock, never resolving a version.
mkdir -p $S/tools && unpack $S/tools $S/agent-tools.tsv
(cd $S/tools && npm ci --no-audit --no-fund >/dev/null 2>&1)`,
  `for b in ${AGENT_TOOL_BINS.join(' ')}; do ln -sf $S/tools/node_modules/.bin/$b $S/node/bin/$b; done`,
  script`t1=$(date +%s)

curl -fsSL https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz | tar -xz -C $S/bin
# Generate the CA by starting once.
($S/bin/mitmdump --set confdir=$S/mitm -p 18999 >/dev/null 2>&1 &) ; for i in $(seq 1 30); do [ -f $S/mitm/mitmproxy-ca-cert.pem ] && break; sleep 0.5; done
pkill -f 'mitmdump.*18999' || true
CA=$S/mitm/mitmproxy-ca-cert.pem
# Trust it system-wide where possible (Rust native-roots, curl, git).
if [ -d /usr/local/share/ca-certificates ]; then cp $CA /usr/local/share/ca-certificates/agent-picks-mitm.crt && (update-ca-certificates >/dev/null 2>&1 || true); fi
if [ -f /etc/pki/ca-trust/source/anchors ] || [ -d /etc/pki/ca-trust/source/anchors ]; then cp $CA /etc/pki/ca-trust/source/anchors/agent-picks-mitm.pem && (update-ca-trust >/dev/null 2>&1 || true); fi
cat /etc/ssl/certs/ca-certificates.crt $CA > $S/bundle.pem 2>/dev/null || cat /etc/pki/tls/certs/ca-bundle.crt $CA > $S/bundle.pem 2>/dev/null || cp $CA $S/bundle.pem
t2=$(date +%s)

bash $S/make-env.sh "$ENVIRONMENT" || exit 4
t3=$(date +%s)
# The dependency graph this sandbox resolved: the pinned runtimes and their global
# packages, the agent CLIs' installed packages and the project's resolved packages. Every
# run of an environment in one test must resolve the same graph, on any provider. The
# operating system's own packages (git, gcc, libc) are left out: they come from the
# provider's image, differ between providers by design, and decide no pick.
(
  echo "=== runtimes"; node --version; npm --version; python3 --version
  if command -v ruby >/dev/null; then ruby --version; gem --version; fi
  echo "=== agents"; npm ls -g --all --parseable --long 2>/dev/null || true
  (cd $S/tools && npm ls --all --parseable --long 2>/dev/null) || true
  echo "=== python"; python3 -m pip freeze --all 2>/dev/null || true
  if command -v gem >/dev/null; then echo "=== gems"; gem list --local 2>/dev/null || true; fi
  echo "=== project"; cd /work/app
  if [ -f package-lock.json ]; then npm ls --all --parseable --long 2>/dev/null || true; fi
  if [ -f Gemfile.lock ]; then cat Gemfile.lock; fi
  if [ -x .venv/bin/pip ]; then .venv/bin/pip freeze --all 2>/dev/null || true; fi
) > $S/out/deps.txt
chmod -R a+rwX /work $S 2>/dev/null
echo "{\"agentsSec\":$((t1-t0)),\"mitmSec\":$((t2-t1)),\"projectSec\":$((t3-t2))}" > $S/out/setup.json
cat $S/out/setup.json
`,
].join('\n');

/**
 * `bash run-agent.sh <claude|codex> <model|default> <prompt-file> <timeout-sec>`, the
 * timeout from AGENT_TIMEOUT_SEC.
 * Reads ANTHROPIC_API_KEY or OPENAI_API_KEY, EARLY_STOP_GRACE and MAX_TURNS from the
 * environment; a Claude Code run needs MAX_TURNS, which comes from AGENT_RUN_LIMITS. The
 * agent's exit code goes to meta.json: 124 when `timeout` stopped it at its limit.
 */
export const RUN_AGENT_SH = script`#!/usr/bin/env bash
# Runs inside the sandbox. Starts the logging proxy, runs one agent on one
# prompt in /work/app, then writes artifacts to /opt/agent-picks/out.
set -uo pipefail
AGENT="$\{1:?claude|codex}"; MODEL="$\{2:?model}"; PROMPT_FILE="$\{3:?prompt file}"; TIMEOUT="$\{4:?timeout sec}"
S=/opt/agent-picks; OUT=$S/out; APP=/work/app
: > $OUT/requests.jsonl; : > $OUT/requests-started.jsonl; : > $OUT/llm-usage.jsonl; : > $OUT/earlystop.json
# Upstream certificates are checked against the system store setup built, not the certifi
# copy bundled in the mitmproxy binary, so a root the system store blocks is blocked here too.
$S/bin/mitmdump --set confdir=$S/mitm --set ssl_verify_upstream_trusted_ca=$S/bundle.pem -p 18080 -q -s $S/logger.py > $OUT/mitm.log 2>&1 &
MITM=$!
for i in $(seq 1 40); do (exec 3<>/dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.25; done

export HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 https_proxy=http://127.0.0.1:18080 http_proxy=http://127.0.0.1:18080
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
export NODE_EXTRA_CA_CERTS=$S/mitm/mitmproxy-ca-cert.pem SSL_CERT_FILE=$S/bundle.pem REQUESTS_CA_BUNDLE=$S/bundle.pem CURL_CA_BUNDLE=$S/bundle.pem
export NPM_CONFIG_CAFILE=$S/bundle.pem GIT_SSL_CAINFO=$S/bundle.pem
# The rest of the CA variables Vercel Sandbox sets, set the same everywhere so the agent
# sees one environment whichever provider runs it.
export PIP_CERT=$S/bundle.pem AWS_CA_BUNDLE=$S/bundle.pem CARGO_HTTP_CAINFO=$S/bundle.pem GRPC_DEFAULT_SSL_ROOTS_FILE_PATH=$S/bundle.pem NODE_USE_SYSTEM_CA=1
export IS_SANDBOX=1 CI=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0
cd $APP
# Env files the project's .gitignore keeps out of the diff (create-next-app ignores .env*),
# with their hashes, so the ones the agent writes or changes can be listed after it stops.
ignored_env() { git ls-files --others --ignored --exclude-standard --directory 2>/dev/null | grep -E '(^|/)\.env[^/]*$' | while IFS= read -r f; do sha256sum "$f"; done; }
ignored_env > $S/ignored-env.before
PROMPT="$(cat "$PROMPT_FILE")"
start=$(date +%s.%N)
if [ -n "$\{EARLY_STOP_GRACE:-}" ]; then
  bash $S/watch-pick.sh "$APP" "$EARLY_STOP_GRACE" >/dev/null 2>&1 &
  WATCH=$!
fi
# The agent gets its own session, whose id agent-session.sh records so the early-stop
# watcher, or a runner reading its spend, can stop it and everything it started.
rm -f $S/agent.sid
if [ "$AGENT" = claude ]; then
  setsid -w bash $S/agent-session.sh $S/agent.sid timeout "$TIMEOUT" claude -p "$PROMPT" $( [ "$MODEL" != default ] && echo --model "$MODEL") --output-format stream-json --verbose \
    --dangerously-skip-permissions --max-turns "$\{MAX_TURNS:?MAX_TURNS}" > $OUT/transcript.jsonl 2> $OUT/agent.err
  code=$?
  # A watcher that is stopping the agent is still clearing its session; wait for its result.
  if [ -n "$\{WATCH:-}" ]; then
    if grep -qE '"(stopping|killed)"' $OUT/earlystop.json 2>/dev/null; then wait $WATCH; else kill $WATCH 2>/dev/null; fi
  fi
else
  printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1
  setsid -w bash $S/agent-session.sh $S/agent.sid timeout "$TIMEOUT" codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
    $( [ "$MODEL" != default ] && echo -m "$MODEL") "$PROMPT" > $OUT/transcript.jsonl 2> $OUT/agent.err
  code=$?
fi
end=$(date +%s.%N)
kill $MITM 2>/dev/null; sleep 0.5
cd $APP
git add -A >/dev/null 2>&1
# Their paths only, never their contents: the classifier won't read "no provider chosen" from
# a diff that can't show where the address was set.
ignored_env | grep -vxFf $S/ignored-env.before | sed -E 's/^[0-9a-f]+  //' > $OUT/ignored-env.txt
BASE=$(git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)
git diff --cached $BASE --stat > $OUT/diffstat.txt 2>/dev/null
git diff --cached $BASE -- . ':(exclude)package-lock.json' ':(exclude)pnpm-lock.yaml' ':(exclude)yarn.lock' ':(exclude)bun.lock' ':(exclude)bun.lockb' > $S/diff.full 2>/dev/null
DIFF_BYTES=$(wc -c < $S/diff.full)
head -c 400000 $S/diff.full > $OUT/diff.patch
[ "$DIFF_BYTES" -gt 400000 ] && echo "$DIFF_BYTES" > $OUT/diff-truncated.txt
: > $OUT/source-files.json
if timeout 15s python3 $S/capture-sources.py "$BASE" > $OUT/source-files.json.tmp; then
  mv $OUT/source-files.json.tmp $OUT/source-files.json
fi
rm -f $OUT/source-files.json.tmp
rm -f $S/diff.full
find . -name package.json -not -path '*/node_modules/*' -maxdepth 3 | while read f; do echo "=== $f"; cat "$f"; done > $OUT/package-json.txt
{ for f in Gemfile requirements.txt requirements-dev.txt pyproject.toml; do [ -f "$f" ] && { echo "=== $f"; cat "$f"; }; done; } > $OUT/manifests.txt
# Same scope as the final dumps: package.json files to depth 3 outside node_modules, root Ruby/Python manifests.
{ git ls-tree -r --name-only "$BASE" 2>/dev/null | grep -E '^([^/]+/){0,2}package\.json$' | grep -v node_modules/; echo Gemfile; echo requirements.txt; echo requirements-dev.txt; echo pyproject.toml; } | while read f; do git cat-file -e "$BASE:$f" 2>/dev/null && { echo "=== $f"; git show "$BASE:$f"; }; done > $OUT/baseline-manifests.txt
ls -1 package-lock.json pnpm-lock.yaml yarn.lock bun.lock* requirements*.txt pyproject.toml go.mod 2>/dev/null > $OUT/lockfiles.txt
python3 - "$code" "$start" "$end" > $OUT/meta.json <<'PY' 2>/dev/null || echo "{\"exitCode\":$code}" > $OUT/meta.json
import json,sys; print(json.dumps({"exitCode":int(sys.argv[1]),"wallSec":round(float(sys.argv[3])-float(sys.argv[2]),1)}))
PY
tar -czf $S/out.tgz -C $S out
echo done $code
`;

/**
 * mitmproxy addon: one JSON line per finished request (no headers or bodies), one per
 * request as it starts, and the token usage of every model response, Anthropic and OpenAI.
 * A request is only logged as finished once its response or error arrives, so the started
 * log is what shows a model call the agent was stopped in the middle of. Codex sends its
 * model requests as messages on one WebSocket to /v1/responses, so each of those is logged
 * as a request of its own, started by its response.create message and finished by its
 * terminal event.
 */
export const LOGGER_PY = script`# mitmproxy addon that appends one JSON line per request (no headers or bodies).
import json, time

OUT = "/opt/agent-picks/out/requests.jsonl"
STARTED_OUT = "/opt/agent-picks/out/requests-started.jsonl"


def _write(rec):
    with open(OUT, "a") as f:
        f.write(json.dumps(rec) + "\n")


USAGE_OUT = "/opt/agent-picks/out/llm-usage.jsonl"


def _anthropic_usage(flow):
    """Extract final token usage from an Anthropic Messages API response (SSE or JSON)."""
    if flow.request.pretty_host != "api.anthropic.com" or "/v1/messages" not in flow.request.path or not flow.response:
        return
    body = flow.response.get_text(strict=False) or ""
    u = {}
    if body.lstrip().startswith("{"):
        try:
            j = json.loads(body)
            u = j.get("usage") or {}
            model = j.get("model")
        except Exception:
            return
    else:
        model = None
        for line in body.splitlines():
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except Exception:
                continue
            if ev.get("type") == "message_start":
                m = ev.get("message") or {}
                model = m.get("model")
                u.update(m.get("usage") or {})
            elif ev.get("type") == "message_delta":
                for k, v in (ev.get("usage") or {}).items():
                    if v is not None:
                        u[k] = v
    if u:
        with open(USAGE_OUT, "a") as f:
            f.write(json.dumps({"t": time.time(), "model": model, "usage": u}) + "\n")


OPENAI_PATHS = ("/v1/responses", "/v1/chat/completions")
# Remote compaction is billed like a response, though its body names no model.
OPENAI_COMPACT_PATH = "/v1/responses/compact"
# The events that end a Responses API response, streamed over SSE or the WebSocket.
RESPONSE_TERMINAL = ("response.completed", "response.incomplete", "response.failed")


def _write_usage(rec):
    with open(USAGE_OUT, "a") as f:
        f.write(json.dumps(dict(rec, t=time.time())) + "\n")


def _openai_path(flow):
    """The request path without its query string, or None when the host is not OpenAI."""
    r = flow.request
    return r.path.split("?", 1)[0] if r.pretty_host == "api.openai.com" else None


def _is_openai_model(flow):
    """A request to an OpenAI generation endpoint, not token counting or a stored-response read."""
    return _openai_path(flow) in OPENAI_PATHS


def _openai_usage(body):
    """(model, usage) from a Responses or Chat Completions body, JSON or SSE; usage None when absent."""
    if body.lstrip().startswith("{"):
        j = json.loads(body)
        r = j.get("response") if j.get("type") in RESPONSE_TERMINAL else j
        return r.get("model"), r.get("usage")
    model, usage = None, None
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except Exception:
            continue
        if isinstance(ev.get("response"), dict):
            model = ev["response"].get("model") or model
            if ev.get("type") in RESPONSE_TERMINAL:
                usage = ev["response"].get("usage")
        elif ev.get("object") == "chat.completion.chunk":
            model = ev.get("model") or model
            if ev.get("usage"):
                usage = ev["usage"]
    return model, usage


def _openai_http_usage(flow):
    """One usage record per billed OpenAI HTTP response; a body without usage is recorded as a gap."""
    path = _openai_path(flow)
    if flow.request.method != "POST" or (path not in OPENAI_PATHS and path != OPENAI_COMPACT_PATH):
        return
    if not flow.response or not 200 <= flow.response.status_code < 300:
        return
    try:
        model, usage = _openai_usage(flow.response.get_text(strict=False) or "")
    except Exception:
        model, usage = None, None
    # Price under the model the server says it used, which can differ from the alias the
    # body names; then the body's (compaction names none), then the one the request asked for.
    model = flow.response.headers.get("openai-model") or model
    if not model:
        try:
            model = json.loads(flow.request.get_text(strict=False) or "").get("model")
        except Exception:
            pass
    _write_usage({"provider": "openai", "model": model, "usage": usage})


def _header_model(headers):
    """The served model from a JSON headers object (openai-model or x-openai-model), else None."""
    if not isinstance(headers, dict):
        return None
    for name, value in headers.items():
        if name.lower() in ("openai-model", "x-openai-model"):
            if isinstance(value, list):
                value = value[0] if value else None
            if isinstance(value, str) and value:
                return value
    return None


def _ws_event_model(ev):
    """The served model a WebSocket event reports: its response's headers, then its own."""
    resp = ev.get("response")
    return _header_model(resp.get("headers") if isinstance(resp, dict) else None) or _header_model(ev.get("headers"))


# Codex's WebSocket model requests still waiting for their terminal event, per flow and
# lane: requests on one stream_id finish first in, first out, and a request without one
# is on the default lane. Each entry is [id, requested model, served model, generated]: a
# terminal event need not repeat the model, and the server reports the one it served in
# headers, on the upgrade or on an event while the request is in flight. generated turns
# true once the server streams a response event past the opening ones; Codex's own
# events (codex.*, such as metadata or rate limits) carry no output and leave it false.
_ws_pending = {}
_ws_count = {}
# Per flow and lane, the [requested, served] models of the request a rejection error (an
# invalid request, a rate limit or an exhausted quota) turned away before any generation.
# Its failed response can follow without usage and was not billed, so it records no usage
# gap; one that carries usage is priced under them. A later request being created, or its
# own error, on the lane clears it: no such follow-up is coming.
_ws_rejected = {}
WS_OPENING = ("response.created", "response.queued", "response.in_progress")
# The error types and codes OpenAI uses to turn a request away unbilled when the error
# carries no status. Any other error, such as a server error once the response has
# started, may follow billed work.
WS_REJECTION_CODES = ("insufficient_quota", "credit_balance_exhausted", "rate_limit_exceeded", "usage_limit_reached")


def _ws_rejection(ev):
    """Whether an error event turned its request away before any work: a client error
    status (an invalid request, a rate limit) or a quota or rate-limit code."""
    status = ev.get("status")
    if isinstance(status, int) and 400 <= status < 500:
        return True
    err = ev.get("error") if isinstance(ev.get("error"), dict) else {}
    return any(c in WS_REJECTION_CODES for c in (err.get("type"), err.get("code"), ev.get("code")))


def websocket_message(flow):
    if not _is_openai_model(flow):
        return
    m = flow.websocket.messages[-1]
    if not m.is_text:
        return
    try:
        ev = json.loads(m.text)
    except Exception:
        return
    if not isinstance(ev, dict):
        return
    r = flow.request
    lanes = _ws_pending.setdefault(flow.id, {})
    lane = ev.get("stream_id")
    if m.from_client:
        if ev.get("type") != "response.create":
            return
        n = _ws_count[flow.id] = _ws_count.get(flow.id, 0) + 1
        rid = flow.id + "#" + str(n)
        upgrade = flow.response.headers.get("openai-model") if flow.response else None
        lanes.setdefault(lane, []).append([rid, ev.get("model"), upgrade, False])
        with open(STARTED_OUT, "a") as f:
            f.write(json.dumps({"t": time.time(), "id": rid, "method": "WS", "host": r.pretty_host, "path": r.path[:500]}) + "\n")
        return
    queue = lanes.get(lane)
    served = _ws_event_model(ev)
    kind = ev.get("type")
    rejected = _ws_rejected.setdefault(flow.id, {})
    # The failed response of a request rejected before generation (such as on an exhausted
    # quota) can follow its error without usage; it was not billed. Requests on a lane run
    # in order, so it arrives before anything of a later request the client may already have
    # queued, and answers the rejection rather than that request. One that carries usage is
    # still priced, and the rejection cannot later swallow another's missing usage.
    if kind in RESPONSE_TERMINAL and rejected.get(lane):
        requested, prior = rejected.pop(lane)
        resp = ev.get("response") or {}
        if resp.get("usage") is not None:
            _write_usage({"provider": "openai", "model": served or prior or resp.get("model") or requested, "usage": resp.get("usage")})
        return
    if served and queue:
        queue[0][2] = served
    if kind not in RESPONSE_TERMINAL and kind != "error":
        # A later request can be queued while a rejection's failed response is still to come,
        # so that leaves the rejection. Requests on a lane do not overlap, so once a later one
        # is created no such follow-up is coming and its own failure must not be taken for one.
        if queue and isinstance(kind, str) and kind.startswith("response."):
            if kind != "response.queued":
                rejected.pop(lane, None)
            if kind not in WS_OPENING:
                queue[0][3] = True
        return
    rid, requested, served, generated = queue.pop(0) if queue else (None, None, served, False)
    if kind == "error" and rid is not None:
        # A later request's own error means no earlier rejection's failed response is still coming.
        if not generated and _ws_rejection(ev):
            rejected[lane] = [requested, served]
        else:
            rejected.pop(lane, None)
    if kind in RESPONSE_TERMINAL:
        # After any other error, a response without usage stays a gap: generation may have been.
        resp = ev.get("response") or {}
        # Price under the model the server says it served, as for HTTP; then the event's, then the requested one.
        _write_usage({"provider": "openai", "model": served or resp.get("model") or requested, "usage": resp.get("usage")})
    if rid is None:
        return
    rec = {"t": time.time(), "id": rid, "method": "WS", "host": r.pretty_host, "path": r.path[:500]}
    if kind == "response.failed":
        rec["error"] = kind
    elif kind == "error" and not isinstance(ev.get("status"), int):
        rec["error"] = json.dumps(ev.get("error"))[:200]
    else:
        # A completed or incomplete response is billed like a 200; a rejected one carries its status.
        rec.update(status=ev.get("status") if kind == "error" else 200, bytes=len(m.content), ua=(r.headers.get("user-agent") or "")[:120])
    _write(rec)


def websocket_end(flow):
    # Requests still pending stay unfinished in the logs: the agent was stopped mid-call.
    _ws_pending.pop(flow.id, None)
    _ws_count.pop(flow.id, None)
    _ws_rejected.pop(flow.id, None)


def request(flow):
    r = flow.request
    with open(STARTED_OUT, "a") as f:
        f.write(json.dumps({"t": time.time(), "id": flow.id, "method": r.method, "host": r.pretty_host, "path": r.path[:500]}) + "\n")


def response(flow):
    try:
        _anthropic_usage(flow)
    except Exception:
        pass
    try:
        _openai_http_usage(flow)
    except Exception:
        pass
    r = flow.request
    _write({
        "t": time.time(), "id": flow.id, "method": r.method, "host": r.pretty_host, "path": r.path[:500],
        "status": flow.response.status_code if flow.response else None,
        "bytes": len(flow.response.raw_content or b"") if flow.response else None,
        "ua": (r.headers.get("user-agent") or "")[:120],
    })


def error(flow):
    r = flow.request
    _write({"t": time.time(), "id": flow.id, "method": r.method, "host": r.pretty_host, "path": r.path[:500], "error": str(flow.error)[:200]})


def tls_failed_client(data):
    _write({"t": time.time(), "tls_failed_client": str(getattr(data.context.client, "sni", None)), "error": str(data.conn.error)[:200]})
`;

/**
 * `setsid bash agent-session.sh <sid-file> <command...>`: under setsid this shell leads the
 * new session, so its pid is the session id. It records that for stop-agent.sh, then
 * becomes the command with the same pid. A recorded id does not depend on how the image's
 * process table shows the command (Vercel Sandbox runs coreutils as one binary).
 */
export const AGENT_SESSION_SH = script`#!/usr/bin/env bash
echo $$ > "$1"
shift
exec "$@"
`;

/**
 * `bash stop-agent.sh <sid-file>`: stops every process in the recorded agent session (the
 * CLI and the installers, generators and servers it started) and prints the outcome as
 * JSON members: agentFound (a live session was there) and killed (it was, and is now gone).
 */
export const STOP_AGENT_SH = script`#!/usr/bin/env bash
SID=$(cat "$1" 2>/dev/null)
# Zombies are dead already; only live processes keep the session running.
alive() { ps -o stat= -s "$SID" 2>/dev/null | grep -qv '^Z'; }
case "$SID" in ''|*[!0-9]*) echo '"agentFound":false,"killed":false'; exit 0 ;; esac
alive || { echo '"agentFound":false,"killed":false'; exit 0; }
pkill -TERM -s "$SID"
for i in $(seq 1 10); do alive || break; sleep 0.2; done
pkill -KILL -s "$SID"
for i in $(seq 1 25); do alive || break; sleep 0.2; done
if alive; then echo '"agentFound":true,"killed":false'; else echo '"agentFound":true,"killed":true'; fi
`;
