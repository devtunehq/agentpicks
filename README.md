# @devtune/agentpicks

Test which tools the coding agents installed on your machine pick when they build your kind of app. `agentpicks run` gives an agent a real request (add error tracking, choose a database) in a committed starter app or your own repository, inside a fresh Docker container, and writes what it did to a bundle on disk: its transcript, its code changes, every URL it fetched and every package it installed.

Apache-2.0.

```sh
npx @devtune/agentpicks run --category error-tracking --stack nextjs
npm install -g @devtune/agentpicks   # then: agentpicks run ...
```

## Requirements

- Docker, running. Each run uses a fresh container with 2 CPUs and 4 GB of memory, needs 20 GB free on Docker's disk and may write up to 15 GB there. The image is built for your machine's own architecture, x86_64 or arm64, so nothing is emulated.
- Node.js 20 or later.
- A coding agent installed and signed in: Claude Code, Codex, OpenCode or Pi.

## Run

```sh
agentpicks run --category error-tracking --stack nextjs --runs 3
agentpicks run --category error-tracking --repo .
```

| Flag | |
|---|---|
| `--category` | `authentication`, `payments`, `transactional-email`, `databases`, `error-tracking` or `ci`. |
| `--stack` | The starter app: `empty`, `nextjs`, `nextjs-noinstr`, `nextjs-supabase`, `nextjs-github-actions`, `tanstack`, `sveltekit`, `express`, `fastapi`, `rails`, `fastapi-aws`, or `rails-own-servers-eu` (error tracking only). The Rails stacks need an x86_64 machine. |
| `--repo` | Test your repository instead of a starter. See [Your repository](#your-repository). |
| `--ref` | With `--repo`, the commit, tag or branch to test. Default `HEAD`. |
| `--runs` | How many runs, one after another. Default 1. |
| `--agent` | `claude-code`, `codex`, `opencode` or `pi`. Required when several are installed. |
| `--model` | The model to ask for. OpenCode and Pi take `anthropic/<model>` or `openai/<model>`. |
| `--out` | Where bundles go. Default `./agentpicks-runs`. |

Each run asks the category's `add` request. An unknown category, stack or agent is refused with the valid values. Cursor is refused: there is no capture for its runs yet.

### Your repository

`--repo <path>` tests the git repository at that path at one commit: `HEAD`, or `--ref`. Every run copies that commit's committed files into its container, read from git's object store: never the working tree, and never `.git`, so no history, remotes, hooks or config. Your checkout is only read. The agent's changes are diffed against that commit's files.

Uncommitted changes and untracked files aren't included: the run tests the commit, and says which before the first run. Commit what you want tested. A path outside a git repository, a repository with no commit, a `--ref` that names no commit, a commit with submodules, and a partial clone missing the commit's files are refused.

`agentpicks` reads the repository with git, against the git directory at that path alone, in an environment that keeps none of your `GIT_*` variables. It reads only committed objects, so no hook, fsmonitor or filter runs, and it allows git no transport and no lazy fetch, so it never fetches. On git older than 2.45, which may fetch a partial clone's missing objects anyway, a partial clone is refused: update git, or test a full clone. Replace objects are ignored, so the recorded commit's files are its own. git's system config isn't read.

Dependencies install frozen from the lockfiles at the repository's root:

| Root files | Install |
|---|---|
| `package-lock.json` or `npm-shrinkwrap.json` | `npm ci` |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --immutable` (Yarn 2+, with `.yarnrc.yml`) or `--frozen-lockfile`, through Corepack |
| `uv.lock` | `uv sync --frozen` |
| `requirements.txt`, with every line pinned with `==` and a `--hash` | `pip install --require-hashes -r requirements.txt` into `.venv` |
| `Gemfile.lock`, listing `ruby` or an `x86_64-linux` platform (x86_64 machines only) | `bundle install`, frozen |

A repository with none of these installs nothing. `package.json`, `pyproject.toml` or `Gemfile` without its lockfile is refused, and so is a `requirements.txt` with a line not pinned and hashed, as are several Node lockfiles and Bun, Deno, Poetry, Pipenv, PDM, Go, Cargo, Composer, Maven, Gradle, Mix, SwiftPM and pub projects. Every refusal comes before a container starts. A repository's committed files can total at most 200 MB.

### The agent

`agentpicks` finds the agent on your `PATH`, reads its version and the model its own config sets, and installs that same version in the container. `--agent` and `--model` override what it finds. Claude Code runs with its early stop: 60 seconds after the agent installs or wires in a tool of the category, it is stopped.

### Credentials

Before the first run, `agentpicks` prints what it passes and copies.

| Agent | Passed from your environment, for the run only | Copied into the container |
|---|---|---|
| Claude Code | `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, with `ANTHROPIC_BASE_URL`; also read from the `env` block of Claude Code's `settings.json` | On Linux, the sign-in in `~/.claude/.credentials.json` |
| Codex | `OPENAI_API_KEY` or `CODEX_API_KEY` | The sign-in in `~/.codex/auth.json` |
| OpenCode, Pi | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, for the model's provider | Nothing |

A copied sign-in leaves out its refresh token, so the container can't renew it and so can't sign this machine out. The access token has to last the run: a sign-in that expires within 40 minutes is refused until you renew it by running the agent here. Copies are deleted with the container.

Claude Code on macOS keeps its sign-in in the Keychain, which `agentpicks` never reads. Run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` to the token it prints. Codex set to keep its sign-in in the system keyring is refused the same way; set `OPENAI_API_KEY`.

### Clean up

```sh
agentpicks cleanup
```

Removes every container and image `agentpicks` made: all are labelled `dev.devtune.agentpicks`. The sandbox image is built from `docker/Dockerfile` the first time, tagged with this package's version; building a new version's image removes the older ones.

## The bundle

Each completed run writes one directory, `<out>/<run id>/`. A run that fails writes nothing, and that includes an agent that exits nonzero, unless the early stop stopped it.

```
manifest.json      the run's context
redactions.json    what redaction removed, per artifact
artifacts/         what the run captured, already redacted
```

`manifest.json` holds `bundleVersion` (1), the generated `runId`, the runner's version, the agent's kind, version and model, the host's OS and architecture, the image digest, the container's egress IP, the stack with its starter and lock digest or the repository with its remote address (`origin`, or the first remote) as host and path alone, without user, password, query, fragment or `transport::` prefix, or `null` with no remote, a local path, or an address it can't read with confidence, and its full commit id, the category, request intent (`add`) and exact prompt, start and end times, and each artifact's size and SHA-256. The egress IP is read inside the container from `https://api.ipify.org` before setup; when it can't be read it is `null`.

The artifacts are those a DevTune managed run captures: `transcript.jsonl`, `diff.patch`, `requests.jsonl` (every request the agent's traffic made through the logging proxy), `llm-usage.jsonl`, `deps.txt`, the manifests and lockfiles before and after, `meta.json` (the agent's exit code) and `earlystop.json`, among others.

Every artifact is redacted before it is written: the credential values the run used, every secret the agent wrote itself (a value of 12 characters or more assigned to a name such as `AUTH_SECRET`, `API_KEY` or `DB_PASSWORD` in a dotenv or shell line, YAML or a quoted string, unless it is a placeholder or a reference; for a URL, its credentials), wherever it then appears, credentials in URLs and private keys, and the [gitleaks](https://github.com/gitleaks/gitleaks) rules. `agentpicks` prints each file's size and the number of redactions. A run that wrote more than 200 secrets writes no bundle, and no further runs start.

The schema is `bundleManifestSchema` and `redactionSummarySchema` in `src/bundle/schema.ts`.

## The package

This package is also the open half of DevTune's Agent Picks: the `Sandbox` interface and the Docker provider, the scripts a run uploads into the sandbox (environment setup, the logging proxy, the early-stop watcher, each agent's install and launch), the run lifecycle (`runInSandbox`), the category requests, the committed starters and the trace redaction. DevTune's managed runs use the same code. Classification, parsing, cost and the model proxy stay with DevTune.

Build the CLI with `pnpm --filter @devtune/agentpicks build:cli`, which writes `dist/cli.js`. The npm package ships only that CLI and the Dockerfile; the code above is imported from source inside the monorepo.

`src/catalogue/early-stop.generated.ts` holds each category's early-stop patterns, which DevTune derives from its tool signals; it is generated by `pnpm --filter @kit/agent-picks generate:early-stop`.

`src/run/trace-rules.generated.ts` is generated from the gitleaks rules in `vendor/gitleaks` (MIT) by `python3 packages/agentpicks/scripts/generate-trace-rules.py`.
