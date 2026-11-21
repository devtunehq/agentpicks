# @devtune/agentpicks

Test which tools the coding agents installed on your machine pick when they build your kind of app. `agentpicks run` gives an agent a real request (add error tracking, choose a database) in a committed starter app or your own repository, inside a fresh Docker container, and writes what it did to a bundle on disk: its transcript, its code changes, every URL it fetched and every package it installed. `agentpicks results` reads which tool each run picked from those bundles.

Apache-2.0. None of this needs a DevTune account:

```sh
npx @devtune/agentpicks init                              # writes a setup file, such as agentpicks/error-tracking.yaml
npx @devtune/agentpicks run error-tracking --no-upload    # runs it; see Setups
npx @devtune/agentpicks run --category error-tracking --stack nextjs --no-upload
npx @devtune/agentpicks results
npm install -g @devtune/agentpicks   # then: agentpicks run ...
```

Set `AGENTPICKS_NO_UPLOAD=1` to keep every run on this machine without passing `--no-upload`.

To have DevTune analyse the runs (what the agent said it picked, pick rates, loss reasons and the Actions that follow), sign in, save the setup and upload what you already ran:

```sh
npx @devtune/agentpicks login
npx @devtune/agentpicks push
npx @devtune/agentpicks upload ./agentpicks-runs
```

A kept run uploads once its setup is pushed with the same `from`, add request and tools the run tested. See [Upload](#upload). No DevTune account yet? [Sign up](https://devtune.ai/auth/sign-up) and create a project, or have your coding agent [set one up](https://docs.devtune.ai/getting-started/agent-setup).

## Requirements

- Docker, running. Each run uses a fresh container with 2 CPUs and 4 GB of memory, needs 20 GB free on Docker's disk and may write up to 15 GB there. The image is built for your machine's own architecture, x86_64 or arm64, so nothing is emulated.
- Node.js 20 or later.
- A coding agent installed and signed in: Claude Code, Codex, OpenCode or Pi.
- To upload, a DevTune sign-in or project API key with the Agent Picks Run scope, on an Agent Picks Local Runner, Cloud or Enterprise plan; Visibility too for a linked setup file, a DevTune setup's name or a category, and Actions Write for a category the project has no copy of yet. See [Upload](#upload). `--no-upload` needs neither.

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
| `--no-upload` | Keep bundles on this machine only. Send them later with `agentpicks upload`; a custom setup's once `agentpicks push` saves it (see [Setups](#setups)). `AGENTPICKS_NO_UPLOAD`, set to anything, does the same for every run. |

`agentpicks --help`, or `--help` after any command, prints the usage and exits successfully.

Each run asks the category's `add` request. An unknown category, stack or agent is refused with the valid values. Cursor is refused: there is no capture for its runs yet.

Uploading, `--category` runs the project's own copy of the category, as `agentpicks run <copy>` runs it with the same flags, so its runs upload under the copy and are listed on it. Without `--agent`, it runs the copy's agents. If the project has no copy, `run` creates one first, with the category's default stacks and the agent the run uses, and prints its name and the `agentpicks pull <name>` that writes it as a file. If the project has several, it runs the one named after the category, else the first DevTune lists, and says which. If the copy asks an add request of its own, `run` refuses it before Docker starts: anyone who can edit the setup in DevTune could change that request, and the agent runs it with your keys. `agentpicks pull` it, commit the file and run that. Reading the project's setups needs the Visibility scope, and creating a copy needs Actions Write; if DevTune refuses either, `run` stops before Docker starts and says how to fix it. With `--no-upload`, `--category` runs the public category itself.

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

Set a custom `ANTHROPIC_BASE_URL` to an HTTP or HTTPS address the sandbox can reach. Use an IP address rather than a name only your network resolves; `localhost` points to the sandbox itself.

A copied sign-in leaves out its refresh token, so the container can't renew it and so can't sign this machine out. The access token has to last the run: a sign-in that expires within 40 minutes is refused until you renew it by running the agent here. Copies are deleted with the container.

Claude Code on macOS keeps its sign-in in the Keychain, which `agentpicks` never reads. Run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` to the token it prints. Codex set to keep its sign-in in the system keyring is refused the same way; set `OPENAI_API_KEY`.

### Upload

```sh
agentpicks login
agentpicks login --no-browser
agentpicks login --api-key [--project <project id>]
agentpicks upload ./agentpicks-runs
agentpicks upload ./agentpicks-runs/<run id>
```

`agentpicks login` signs in to DevTune in your browser, where you choose the project and approve its scopes. Uploading needs Agent Picks Run; `login` prints every scope the sign-in holds. If no browser opens, or with `--no-browser`, it prints the address: open it in a browser on the same machine. The sign-in is renewed when it expires. Before anything starts, `run` and `upload` ask DevTune what the sign-in may do now, and stop, saying to log in again, if DevTune refuses to renew it or it lacks Agent Picks Run. If DevTune can't be reached or is briefly unavailable, they warn and carry on, and the upload checks again. If a renewal's answer is lost, so DevTune may have renewed the sign-in without `agentpicks` saving it, they stop; run `login` again. A sign-in revoked during a long `run`, or one DevTune no longer renews, is refused at upload, and the bundle stays on disk. Uploads act as the signed-in member, who needs DevTune management permission on the account and edit rights on the project.

On a terminal, `agentpicks` with no command, `--help` and a successful `login` show the DevTune logo first. Set `AGENTPICKS_NO_LOGO=1` to leave it out.

`agentpicks login --api-key` reads a project API key from standard input instead: paste it at the prompt, which doesn't echo it, or pipe it in. Create the key under **API Keys** in DevTune, with the **Agent Picks Run** scope. `login` asks DevTune which project the key belongs to, which needs the key's Project Read scope too; with `--project`, it saves the key for that project without asking.

Either login is saved to `agentpicks/credentials.json` under `$XDG_CONFIG_HOME`, or else `%APPDATA%` on Windows and `~/.config` elsewhere, in a file with mode 0600, so only your user can read it, and replaces the other. `agentpicks` never prints a key or token.

In CI, set `DEVTUNE_API_KEY` and `DEVTUNE_PROJECT_ID` instead: they override the saved login. Without `DEVTUNE_API_KEY`, a saved sign-in is used only for its own API address and project. `DEVTUNE_API_BASE_URL` sets the API address, default `https://devtune.ai/api/v2`. These are the names the `devtune` CLI reads.

`run` checks for a sign-in or key before anything starts, and refuses without one unless you pass `--no-upload` or set `AGENTPICKS_NO_UPLOAD`. Once a run's bundle is written, `run` lists its files, their sizes and the redactions, then uploads it: the manifest to DevTune, and each artifact straight to storage. It prints the run id and the upload's API address. If DevTune refuses the upload, `run` prints DevTune's reason and the command that sends the bundle later, and starts no further runs. The bundle stays on disk either way.

A `--repo` run needs the repository to have a remote that `agentpicks` records (see [The bundle](#the-bundle)), since DevTune groups a repository's runs by its remote. Without one, `run` refuses before anything starts; add an `origin` remote, or pass `--no-upload`.

`agentpicks upload` takes one bundle directory, or the `--out` directory of `run`, and uploads every bundle in it. Uploading a bundle again is safe: an upload that stopped partway sends only the artifacts DevTune hasn't stored, and one that completed is left as it is. A bundle whose files changed after it was written is refused before anything is sent.

### Results

```sh
agentpicks results
agentpicks results ./agentpicks-runs ./ci-runs --json
```

`agentpicks results` prints a row for each run in `./agentpicks-runs`, or the directories named: its run id, setup or category, agent, model and pick, then how many runs in each setup picked each tool. The pick is read from the bundle with the early-stop patterns the run recorded, in the order the early stop checks them: the packages the agent added that the patterns name, else the first added line of code they match, else a config file the agent created that they match. The pick shows the package names, the code or the file, not a tool name. A run with no pick shows `none`. A run shows `Unmeasured`, with the reason printed under the counts, when:

- its bundle fails its checks, or was written before `agentpicks` recorded a run's early-stop patterns;
- a check is unread, because its package files or diff weren't captured or the diff was cut at its size limit, and no check before it found a pick;
- the early stop saw a pick during the run that the final files no longer show by the same check: a package for an install, or code or a config file for code;
- no check found a pick, and the setup measures a catalogue tool its early stop doesn't hold (one it names by key, or one its DevTune setup measures beside your tool and competitors), whose signals only DevTune has.

`--json` prints the rows as JSON. A directory with no bundle in it exits 1.

What an agent said it picked, and rates across runs, come from DevTune's analysis of an uploaded run.

### Clean up

```sh
agentpicks cleanup
```

Removes every container and image `agentpicks` made: all are labelled `dev.devtune.agentpicks`. The sandbox image is built from `docker/Dockerfile` the first time, tagged with this package's version; building a new version's image removes the older ones.

## Setups

A setup is what you test, kept as a YAML file in your repository: one file per setup in the `agentpicks` folder at the repository root (the git root above where you run `agentpicks`). A setup's name is its file name without `.yaml` or `.yml`.

```sh
agentpicks init
agentpicks init --yes
agentpicks init --category authentication --tool clerk --competitors authjs,okta --stack nextjs --agent claude-code --name auth --yes
```

`agentpicks init` writes a setup file from a few questions. Each shows its default in brackets, and Enter takes it. Categories, a category's tools and stacks are listed numbered: answer with a number or a key, and give competitors and stacks as a comma list that may hold ranges, such as `2, 5-8`.

- **Job**: a built-in category, which the file inherits with `from:`, or a job line of your own. The default is the category of your tool.
- **Requests**, for a job of your own: the add request a run asks, the recommend request `push` saves with it, and a hosted request or none.
- **Your tool**: a catalogue tool named by your `package.json` name or scope, or your git remote's repository or owner, such as `sentry` from `getsentry/sentry-docs`.
- **Competitors**: for a category, its tools; for your own job, typed as npm packages.
- **Where to test**: this repository (`repo`, written `repo: .`), every stack the job runs in (`all`), or stacks by number or range. The default is `repo` in a git repository with at least one commit, else the stacks your `package.json` and lockfiles name (`next`, `@tanstack/react-start`, `@sveltejs/kit` and `express`, a pnpm monorepo's apps included, plus FastAPI and Rails).
- **Agents**: those installed here that `run` could start now, with their sign-in or key.
- **Runs** and the setup's **name**.

For a custom setup, run `agentpicks push <setup>` before running it with uploads.

Each question also has a flag, which takes keys, never list numbers: `--category <category>` or `--job <line>`, `--tool <tool>` or `none`, `--competitors <tool>,<tool>` or `all`, `--repo .` or `--stack <stack>` or `all`, `--agent <agent>` or `any`, `--runs <n>` and `--name <name>`. `--stack` and `--agent` repeat, or take a comma list. `init` asks only what the flags leave, and refuses a flag value that doesn't read, naming the flag. A job line's requests and tools have no flags: answer them on a terminal or, signed in, take DevTune's drafts with `--yes`. Without a sign-in, type them on a terminal, or have your coding agent write the file against `agentpicks schema` and check it with `agentpicks validate`.

`agentpicks catalogue` lists the category, tool and stack keys the flags take: every category and the stacks a job line can run in. `agentpicks catalogue <category>` lists the category's tool keys and the stacks it runs in. `--json` prints either as one JSON object.

After writing a category setup, `init` prints the command that writes the same setup in another repository, such as `To write the same setup in another repository: agentpicks init --category error-tracking --tool sentry --repo . --agent claude-code --name error-tracking --yes`.

Signed in with `agentpicks login`, or with `DEVTUNE_API_KEY` and `DEVTUNE_PROJECT_ID` set, a job of your own is drafted by DevTune: its requests, its competitors, and each tool's packages and config names. Drafts count against your project's hourly draft allowance. If DevTune refuses a draft or can't be reached, `init` prints one warning and asks for the rest itself.

`init` checks the file as `validate` does before writing it. On a terminal it asks again for a typed answer until the file passes; a flag's value, or a default `--yes` took, that fails is refused instead, naming the problem. It won't replace a setup of the same name without `--force`. `--yes` takes every default without asking, and fails, naming what it couldn't detect, when there's no default for the job or where to test. Off a terminal, a question no flag answers takes its default with `--yes`, where it has one; without `--yes`, `init` stops at it and names its flag. Off a terminal, a job line needs `--yes`.

`agentpicks/error-tracking.yaml` tests the built-in error tracking category:

```yaml
job: Add error tracking
from: error-tracking
stacks: [nextjs]
```

`agentpicks/feature-flags.yaml` tests a job of your own:

```yaml
job: Add feature flags
requests:
  add: Add feature flags to this app, and put a new checkout page behind one.
tools:
  own:
    key: acme-flags
    name: Acme Flags
    domain: acme.dev
    signals:
      packages:
        npm: ['@acme/flags']
      configNames: [ACME_FLAGS_KEY]
  competitors:
    - key: launchdarkly
      name: LaunchDarkly
      domain: launchdarkly.com
      signals:
        packages:
          npm: ['@launchdarkly/node-server-sdk', launchdarkly-node-server-sdk]
        configNames: [LAUNCHDARKLY_SDK_KEY]
stacks: [nextjs, express]
agents: [claude-code, codex]
runs: 3
```

| Field | |
|---|---|
| `job` | The job line, one line of up to 300 characters, which labels the setup; a run asks `requests.add`. A new job line is at least 8 characters; a file linked to a DevTune job may keep the shorter line that job is saved with. Required without `from`. |
| `from` | A built-in category, as `--category` takes it. The setup inherits its job, requests and tools. |
| `requests` | One request per intent: `add`, `recommend`, `hosted` and `improve`, each one line of 8 to 300 characters that names none of the setup's own tools. A run asks `add`, which a setup without `from` must give. With `from`, `null` leaves out the category's request of that intent, except `add`. |
| `tools` | `own`, your tool, and `competitors`. Each is the key of a tool in DevTune's catalogue (`sentry`), or a full entry: `key`, `name` and `signals`, and optionally `domain`. A full entry's key can't be one of the `from` category's. Your setup lists up to six `competitors`; a file pulled from one of DevTune's public boards may list every tool the board ranks. A setup without `from` needs at least one tool and holds at most seven; a setup `from` a category holds its category's tools plus seven. A setup from a category that names a catalogue tool its category doesn't measure is custom. |
| `signals` | How a tool is recognised: `packages` by `npm`, `pypi` or `gem` (a name ending in `*` matches every package that starts with the text before the `*`, and one ending in `/` every package under that scope or path, so `@acme/` matches `@acme/flags`), `configNames` (environment variable names or API hosts, not starting with `-`), and `importPatterns`, `configFiles`, `configPatterns`, `commandPatterns`, `selfHosted` (patterns of up to 200 characters that RE2 compiles), `aliases`, `brandDomains`, `frameworkBuiltIn`, `yieldsTo` and `receivesFrom`. A tool can give only `aliases` and `brandDomains`: DevTune recognizes it when an agent names it as its pick, and the early stop doesn't watch for it. Tools can't yield to each other in a loop. |
| `stacks` | Starter apps to test in, as `--stack` takes them, each once. A setup without `from` can't use `nextjs-github-actions`, `fastapi-aws` or `rails-own-servers-eu`, which run in some categories only or carry a deploy context. |
| `repo` | Your repository, in place of `stacks`: a path relative to the repository root, such as `.`, or `path` and `ref`. |
| `agents` | `claude-code`, `codex`, `opencode` or `pi`, each once and installed on the machine that runs it. Without `agents`, the one agent installed runs. |
| `runs` | Runs per agent and stack. Default 1. |
| `id` | The DevTune setup the file is linked to. `pull` and `push` write it. |
| `synced` | What the file and its DevTune setup held when they last matched: `setup`, the setup's digest, and `file`, the file's. `pull` and `push` write it; don't edit it. |

`agentpicks schema` prints the file's JSON Schema. It is `schema/setup.v1.json` in this package, and each version's is at `https://raw.githubusercontent.com/devtunehq/agentpicks/v<version>/schema/setup.v1.json`. `init` and `pull` start a file with `# yaml-language-server: $schema=<that address>`, so an editor with YAML support completes and checks it. To have a coding agent write a setup, give it the schema and this section, and have it run `agentpicks validate` until the file passes.

```sh
agentpicks run feature-flags --no-upload
agentpicks run agentpicks/feature-flags.yaml --agent codex --runs 1 --no-upload
agentpicks run
```

`agentpicks run <setup>` takes the setup's name or the path of its file. Each run asks the setup's `add` request, once per agent and stack. Claude Code's early stop watches for the `from` category's tools and for the package and config names of the setup's own tools; a tool that yields to another tool in the setup (`yieldsTo`) doesn't stop it, and nor does a tool named by key alone or a full entry with no package or config name, so a setup whose tools are all like these isn't stopped early. Flags override the file: `--stack` or `--repo` replaces its stacks or repo, `--ref` its commit, `--agent` its agents, and `--runs` its runs. `--model` sets one agent's model, so a setup with several agents needs `--agent` with it. On a terminal, `agentpicks run` with no setup and no `--category` lists the setups and asks which to run.

A setup file linked to a DevTune setup (it has an `id`) uploads under that setup. An unlinked setup `from` a category, with no requests or tool signals of its own, uploads as that category. Naming the category's tools under `tools` doesn't change that. Any other setup is custom, and can't share its name with a built-in category: until `agentpicks push` saves it to DevTune, `run` refuses to start it without `--no-upload`. A run of a linked file whose DevTune setup is gone is refused before it starts, and so is a run of a linked file with changes not pushed (push it first) or whose DevTune setup changed since the file last saw it (pull it first). DevTune refuses an upload whose prompt isn't its setup's current request, as `prompt_mismatch`. A `--no-upload` bundle of a custom setup, or of a linked file's changes not pushed, uploads once `agentpicks push` has saved the file with the same `from`, add request and tools the run tested: run `upload` from the repository that holds the file. Adding what `push` needs and a run doesn't, such as a `recommend` request, is fine. A bundle of an add request or tools the file or DevTune no longer holds can't file under the setup; run the setup again.

```sh
agentpicks list
agentpicks validate
agentpicks validate feature-flags agentpicks/error-tracking.yaml
```

`agentpicks list` prints each setup's name, job, `from`, stacks or repo, agents and runs, and flags a file that fails its checks. Signed in, it also lists the project's DevTune setups, with where each setup is (`local`, `DevTune` or `both`) and, for a linked file, whether it is in sync or which side changed. When the table is wider than the terminal, it prints each setup as a block, one line per field; piped output is always the table. `agentpicks validate` checks every setup file, or the ones named, against the schema and the catalogue: a known `from`, tool keys in DevTune's catalogue, stacks it runs in, known agents, and the limits above. With no setup named, two files with one name, such as `x.yaml` and `x.yml`, both fail; a file named by path is checked alone, as `run <path>` runs it. It prints each problem as `file: field: fix` and exits 1 if any file fails, so CI can run it.

### DevTune setups

```sh
agentpicks pull
agentpicks pull feature-flags --force
agentpicks push feature-flags
agentpicks run add-feature-flags
```

`agentpicks pull` writes each of the project's DevTune setups to `agentpicks/<name>.yaml`, or into the file already linked to it, with its `id` and `synced`; `pull <setup>` writes one. It leaves a file in sync alone, and refuses to replace a file with changes not yet pushed, or an unlinked file of that name, unless you pass `--force`. A setup's name is its `from` category for an unedited copy of one, else its job line in lowercase with dashes, cut at a word to at most 30 characters.

`agentpicks push` saves every setup file to DevTune, and `push <setup>` one. A new file becomes a new DevTune setup, and push writes its `id` and `synced` into the file. A linked file in sync sends nothing. If the DevTune setup changed since the file last saw it, push refuses with `setup_changed` and saves nothing: pull it, apply your changes again, and push. A setup `from` a category saves as the project's setup of that category. Adding or editing a full entry (`key`, `name` and `signals`) for a tool outside DevTune's catalogue, or adding a catalogue tool by key outside the category, saves the category's copy with those tools. Use catalogue keys alone; a full entry with edited catalogue signals is refused. A tool from DevTune's catalogue goes by key alone: `pull` writes it that way, and DevTune fills in its signals when you push. A job or copy can name, by key, any tool of a category DevTune publishes. When adding or editing tools this way, keep `requests.add` and `requests.recommend` as text and `requests.improve` at its inherited or pulled value. Push the tools first, then push any supported request omissions or improve changes separately; `requests.hosted: null` can be saved with the tools. What a file can't say, such as agent models and a job's building blocks, push keeps as DevTune holds it. For a new file with `repo`, push detects the repository's stacks from its manifests and lockfiles and saves those to DevTune. The file keeps `repo`, so `run <setup>` still tests your repository. If no supported stack is detected, replace `repo` with `stacks` before pushing and pass `--repo` when running. A linked file with `repo` keeps the stacks DevTune already holds.

`agentpicks run <name>` also runs a DevTune setup that has no file here, by the name `list` shows, and its runs upload under that setup. A job, or a copy that asks an add request of its own, is refused before Docker starts: anyone who can edit the setup in DevTune could change that request, and the agent runs it with your keys. `agentpicks pull` it and run the file.

`list`, `pull`, `run <name>` and an uploading `run --category` need the sign-in to read DevTune (Visibility Read), and `push`, and `run --category` when the project has no copy of the category, to edit setups (Actions Write); `agentpicks login` asks for both.

## GitHub Actions

The `devtunehq/agentpicks` action runs a setup in your workflow and uploads each run to your DevTune project. Commit the setup file to your repository (see [Setups](#setups)), such as `agentpicks/error-tracking.yaml`, then name it in `setup`.

This workflow runs that setup with Claude Code every Monday:

```yaml
name: Agent Picks
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  agentpicks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm install -g @anthropic-ai/claude-code@2.1.323
      - uses: devtunehq/agentpicks@v0.4.10
        with:
          setup: agentpicks/error-tracking.yaml
          agent: claude-code
          devtune-api-key: ${{ secrets.DEVTUNE_API_KEY }}
          devtune-project-id: ${{ vars.DEVTUNE_PROJECT_ID }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`setup` is a setup file's path in the checkout, or the name of a DevTune setup with no file, as `list` shows it. A name runs the DevTune setup, unless it is a job or a copy that asks an add request of its own, which runs only from a committed file. The action refuses a name that is also a file in the checkout's `agentpicks` folder, so name the file by its path. To run a built-in category with no setup file, set `category` with `stack` or `repo` in place of `setup`. Set one of `setup` and `category`, not both.

Use a Linux runner: `ubuntu-latest` has Docker and Node.js 20 or later. Without Docker, `run` refuses; without Node.js 20 or later, the action does. The action uses the runner's Node.js and doesn't change it for later steps.

Pin a release tag, such as `v0.4.10`. The action runs the `@devtune/agentpicks` version in the `package.json` of its ref, so a tag runs the same CLI every time. A branch moves to each new version when the mirror syncs, and fails while that version isn't on npm.

| Input | Passed as |
|---|---|
| `setup` | `run <setup>`. A path resolves in the checkout. |
| `category` | `--category`, in place of `setup`. |
| `stack` | `--stack`, in place of the setup's stacks or repo. |
| `repo` | `--repo`, in place of the setup's stacks or repo. `.` is the checkout. |
| `runs` | `--runs` |
| `agent` | `--agent`, in place of the setup's agents. |
| `model` | `--model` |
| `out` | `--out`. Default `./agentpicks-runs`. |
| `no-upload` | `--no-upload` when `true`. Default `false`. |
| `devtune-api-key` | `DEVTUNE_API_KEY` |
| `devtune-project-id` | `DEVTUNE_PROJECT_ID` |
| `devtune-api-base-url` | `DEVTUNE_API_BASE_URL` |

The DevTune values reach the CLI only through those environment variables, never its command line, and neither the action nor the CLI prints the key. Set `devtune-api-key` and `devtune-project-id` together: with one set, all three DevTune values come from the inputs, and the action refuses to upload when the other is empty, which is how a missing or misnamed secret shows up. With both empty, the action uses the `DEVTUNE_*` variables set on the step or job, and ignores `devtune-api-base-url`. The `bundle-dir` output is the absolute path of `out`, which holds one bundle per completed run; with `no-upload: true`, keep them with `actions/upload-artifact`.

**The API key.** Create a project API key under **API Keys** in DevTune with these scopes, and add it as the `DEVTUNE_API_KEY` secret. `DEVTUNE_PROJECT_ID` isn't secret, so it can be a variable.

| Scope | Needed to |
|---|---|
| **Agent Picks Run** | Upload each run. |
| **Visibility** | Upload the runs of a linked setup file (one with an `id`), run a DevTune setup by name, or run a `category`: `run` reads the project's DevTune setups to find the one its runs file under. |
| **Actions Write** | Run a `category` the project has no copy of yet: `run` creates the copy first. |

A linked file's run is refused before Docker starts when the file has changes not pushed, or its DevTune setup changed since the file last saw it: `push` or `pull` on your own machine after `agentpicks login`, which needs Visibility and Actions Write, then commit the file. The CI key needs no login, and Actions Write only for a `category` the project has no copy of. See [DevTune setups](#devtune-setups).

**The agent's key.** Pass it through `env:` under a name from [Credentials](#credentials): `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` for Claude Code, `OPENAI_API_KEY` or `CODEX_API_KEY` for Codex, and for OpenCode and Pi `ANTHROPIC_API_KEY` with an `anthropic/` model or `OPENAI_API_KEY` with an `openai/` model. `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`, is the only subscription sign-in that works in CI: the others are saved to a file or a keyring when you log in to the agent, and a fresh runner has none to copy.

**The agent.** `agentpicks` tests the agent installed on the runner, and installs the same version in its container, so install it at a pinned version before the action: `npm install -g @openai/codex@<version>` for Codex. Install and authenticate each agent the setup lists, or pick one with `agent`. With `agent` set, or a setup that lists its agents, a run whose agent isn't installed is refused, naming it; otherwise a runner with no agent installed is refused, listing the agents `agentpicks` can run.

**Your repository.** A setup with `repo: .`, or `repo: .` on the action, tests the checked-out commit. `actions/checkout` sets the `origin` remote that an upload needs. Files the workflow writes into the checkout, `out` included, aren't read: only committed files are tested.

### Other CI systems

Install Docker, Node.js 20 or later and the agent, set `DEVTUNE_API_KEY`, `DEVTUNE_PROJECT_ID` and the agent's key from the CI system's secrets, and call the CLI at a pinned version from the checkout:

```sh
npm install -g @anthropic-ai/claude-code@2.1.323
npx --yes @devtune/agentpicks@0.4.10 run error-tracking --agent claude-code
```

## The bundle

Each completed run writes one directory, `<out>/<run id>/`. A run that fails writes nothing, and that includes an agent that exits nonzero, unless the early stop stopped it.

```
manifest.json      the run's context
redactions.json    what redaction removed, per artifact
artifacts/         what the run captured, already redacted
```

`manifest.json` holds `bundleVersion` (1), the generated `runId`, the runner's version, the agent's kind, version and model, the host's OS and architecture, the image digest, the container's egress IP, the stack with its starter and lock digest or the repository with its remote address (`origin`, or the first remote) as host and path alone, without user, password, query, fragment or `transport::` prefix, or `null` with no remote, a local path, or an address it can't read with confidence, and its full commit id, the category (`setup:<name>` for a custom setup), request intent (`add`) and exact prompt, start and end times, and each artifact's size and SHA-256. An artifact that analysis doesn't read and that is over DevTune's upload limit (50 MiB) is trimmed to whole lines within it, and the manifest records its size before and after under `truncation`: `mitm.log` and `agent.err` keep their end, and the rest keep their start. The artifacts analysis reads (the transcript, `requests.jsonl`, the diff and the source files, and the package and manifest files before and after) are never trimmed, so a result is never drawn from part of a run; over the limit, `agentpicks upload` refuses the bundle and names the limit. The egress IP is read inside the container before setup from DevTune's `/api/public/egress-ip`, at the origin of `DEVTUNE_API_BASE_URL` (`https://devtune.ai` by default), which answers with the caller's address as plain text; when it can't be read it is `null`.

The artifacts are those a DevTune managed run captures: `transcript.jsonl`, `diff.patch`, `requests.jsonl` (every request the agent's traffic made through the logging proxy), `llm-usage.jsonl`, `deps.txt`, the manifests and lockfiles before and after, `meta.json` (the agent's exit code) and `earlystop.json`, among others.

Every artifact is redacted before it is written: the credential values the run used, every secret the agent wrote itself (a value of 12 characters or more assigned to a name such as `AUTH_SECRET`, `API_KEY` or `DB_PASSWORD` in a dotenv or shell line, YAML or a quoted string, unless it is a placeholder or a reference; for a URL, its credentials), wherever it then appears, credentials in URLs and private keys, and the [gitleaks](https://github.com/gitleaks/gitleaks) rules. `agentpicks` prints each file's size and the number of redactions. A run that wrote more than 200 secrets writes no bundle, and no further runs start.

The schema is `bundleManifestSchema` and `redactionSummarySchema` in `src/bundle/schema.ts`. Every run also writes `earlyStop`, the patterns its early stop watched for, into `manifest.json`, and a run of a setup file writes `setup` (its name, `from`, `id` and job line). Both are `agentpicks`' own, outside the bundle format, so an upload never sends them.

## The package

This package is also the open half of DevTune's Agent Picks: the `Sandbox` interface and the Docker provider, the scripts a run uploads into the sandbox (environment setup, the logging proxy, the early-stop watcher, each agent's install and launch), the run lifecycle (`runInSandbox`), the category requests, the committed starters and the trace redaction. DevTune's managed runs use the same code. Classification, parsing, cost and the model proxy stay with DevTune.

Build the CLI with `pnpm --filter @devtune/agentpicks build:cli`, which writes `dist/cli.js`. The npm package ships only that CLI, the Dockerfile and the setup file's JSON Schema; the code above is imported from source inside the monorepo.

`src/catalogue/early-stop.generated.ts` holds each category's early-stop patterns, which DevTune derives from its tool signals, and `src/catalogue/category-tools.generated.ts` each category's tool keys and names; both are generated by `pnpm --filter @kit/agent-picks generate:early-stop`.

`src/run/trace-rules.generated.ts` is generated from the gitleaks rules in `vendor/gitleaks` (MIT) by `python3 packages/agentpicks/scripts/generate-trace-rules.py`.
