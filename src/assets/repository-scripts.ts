/**
 * ABOUTME: make-env.sh for a self-run of the customer's own repository (`agentpicks run --repo`):
 * lays down the repository's committed content at one commit from `repository.tsv`, commits
 * exactly that content as the baseline the agent's diff is taken against, then installs its
 * dependencies frozen from its committed lockfiles with the package managers setup already has.
 */
import { STARTERS } from '../catalogue/environments';
import { stopOnFailure, UV_VERSION } from './environment-scripts';
import { script } from './script';
import { UNPACK_FN } from './static-scripts';

/** The package managers a repository installs with; null where it has none of that kind. */
export interface RepositoryInstall {
  node: 'npm' | 'pnpm' | 'yarn' | null;
  python: 'uv' | 'pip' | null;
  ruby: 'bundler' | null;
}

/** A repository at one commit as a run uploads it: its files packed for `unpack`, and how it installs. */
export interface SandboxRepository {
  packed: string;
  install: RepositoryInstall;
}

/** The catalogue slug every repository run reports; it holds no customer data. */
export const CUSTOMER_REPOSITORY_SLUG = 'customer_repository';

const LOG = '>>/tmp/install.log 2>&1';

const NODE_INSTALL: Record<NonNullable<RepositoryInstall['node']>, string> = {
  npm: `npm ci --no-audit --no-fund ${LOG}`,
  pnpm: `pnpm install --frozen-lockfile ${LOG}`,
  // Corepack runs the Yarn the repository's packageManager names; Yarn 2+ reads .yarnrc.yml.
  yarn: `if [ -f .yarnrc.yml ]; then corepack yarn install --immutable ${LOG}; else corepack yarn install --frozen-lockfile ${LOG}; fi`,
};

const PYTHON_INSTALL: Record<
  NonNullable<RepositoryInstall['python']>,
  string
> = {
  uv: `python3 -m pip install -q --disable-pip-version-check uv==${UV_VERSION} ${LOG}\npython3 -m uv sync --frozen ${LOG}`,
  // The runner admits only a requirements.txt pinned with == and hashed throughout.
  pip: `python3 -m venv .venv ${LOG}\n.venv/bin/pip install --disable-pip-version-check --require-hashes -r requirements.txt ${LOG}`,
};

/** The frozen install commands for a repository, run in its directory; empty when it installs nothing. */
export function repositoryInstallScript(install: RepositoryInstall): string {
  return [
    install.node && NODE_INSTALL[install.node],
    install.python && PYTHON_INSTALL[install.python],
    install.ruby && `BUNDLE_FROZEN=true bundle install ${LOG}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** `bash make-env.sh`: lays down /work/app from repository.tsv and commits it as the baseline. */
export function buildRepositoryMakeEnvScript(
  install: RepositoryInstall,
): string {
  const installScript = repositoryInstallScript(install);
  return [
    script`#!/usr/bin/env bash
# Creates /work/app from the customer's repository at one commit, commits exactly that content
# as the baseline, then installs its dependencies frozen from its committed lockfiles.
set -uo pipefail
S=/opt/agent-picks`,
    `ENVIRONMENT=${CUSTOMER_REPOSITORY_SLUG}`,
    UNPACK_FN,
    script`rm -rf /work && mkdir -p /work/app && cd /work
export CI=1 npm_config_yes=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
    install.ruby
      ? stopOnFailure(STARTERS.rails.runtimeScript, 'runtime install failed')
      : '',
    stopOnFailure(
      'unpack /work/app $S/repository.tsv',
      'repository copy failed',
    ),
    script`cd /work/app
# The baseline is the commit's content byte for byte: every committed path staged, ignored or
# not, before anything installs, with no attribute converting line endings or running a filter,
# and what installs recreate kept out.
git init -q 2>/dev/null; git config user.email agent-picks@devtune.ai; git config user.name agent-picks
printf '* -text -filter -ident\n' > .git/info/attributes
printf 'node_modules/\n.venv/\n' >> .git/info/exclude
if [ -s $S/repository.tsv ]; then
  cut -f2 $S/repository.tsv | tr '\n' '\0' | git --literal-pathspecs add -f --pathspec-from-file=- --pathspec-file-nul || { echo 'staging the baseline failed'; exit 3; }
fi
git commit -qm baseline --allow-empty`,
    installScript ? stopOnFailure(installScript, 'frozen install failed') : '',
    script`# Files the install wrote that the repository doesn't ignore are its output, not the agent's.
git ls-files --others --exclude-standard | sed 's/[][*?\\!#]/\\&/g; s|^|/|' >> .git/info/exclude
if ! git diff --quiet; then echo 'the install changed committed files:'; git diff --name-only | head -5; exit 3; fi
INSTR=$(ls -d AGENTS.md CLAUDE.md GEMINI.md .cursor .cursorrules .windsurfrules .github/copilot-instructions.md .claude .agents 2>/dev/null | tr '\n' ' ')
BUNDLED=$([ -d node_modules/next/dist/docs ] && echo next-bundled-docs)
HASH=$(cat AGENTS.md CLAUDE.md .cursorrules .github/copilot-instructions.md 2>/dev/null | sha256sum | cut -c1-12)
chmod -R a+rwX /work
echo "{\"env\":\"$ENVIRONMENT\",\"instructionFiles\":\"$INSTR\",\"bundledDocs\":\"$BUNDLED\",\"instrHash\":\"$HASH\",\"stripped\":false}" > /opt/agent-picks/out/env.json
cat /opt/agent-picks/out/env.json
`,
  ]
    .filter(Boolean)
    .join('\n');
}
