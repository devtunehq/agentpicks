/**
 * ABOUTME: The environment catalogue as data: each entry is one project an agent starts
 * from (empty folder, a version-pinned official starter, or a starter with an existing
 * tool installed). Shaped like the spec's `agent_pick_environments`, plus the committed
 * starter it lays down, the recipe that generates that starter when its locks are
 * regenerated, and the starter's dependency baseline. Also which projects are ticked by
 * default, a context project's host and the requests it leaves out, and the retired slugs.
 */
import type { PromptIntent } from './prompt-intents';

export type ProjectState = 'empty' | 'starter' | 'starter_with_existing_tool';

/**
 * What a context project adds to its starter (spec 40 §2.2): the host whose own deploy setup
 * its files carry, and the requests its sentence (`promptPrefix`) contradicts. A context is
 * never revised in place: a changed file or sentence is a new slug, and the old slug goes in
 * `RETIRED_ENVIRONMENT_SLUGS`.
 */
export interface EnvironmentContext {
  /**
   * The host the committed files deploy to. Wherever the host or one of its products is a tool
   * of a category the project runs in, that tool is in `existingToolKeys`.
   */
  host?: { name: string; domain: string };
  /** Requests the sentence contradicts, which never run in this project. */
  leavesOut?: PromptIntent[];
}

export interface EnvironmentDefinition {
  slug: string;
  name: string;
  framework: string;
  /** Version-pinned generator or template; empty for an empty project. */
  starterRef: string;
  projectState: ProjectState;
  notes: string;
  /** The committed starter setup lays down and installs frozen, by key in `STARTERS`. */
  starter: StarterKey;
  /** Remove agent instruction files (AGENTS.md, CLAUDE.md, .cursor, ...) before the baseline commit. */
  stripInstructions?: boolean;
  /**
   * Tools already installed in the starter, by tool key in each category they belong to
   * (Supabase is `supabase-auth` for authentication and `supabase` for databases). Using
   * one counts as picking it.
   */
  existingToolKeys?: string[];
  /**
   * The category slugs this environment runs in; omitted, it runs in every category. A scoped
   * environment is left out of other categories' default tests, refused when a request names it
   * for one, and never offered for a job (a `job-…` slug).
   */
  categories?: string[];
  /** Prepended to every prompt run in this environment. It names no tool of a category it runs in. */
  promptPrefix?: string;
  /**
   * Whether a new setup, a clone and a category's default test tick the project; omitted, they
   * do. A context project sets false and is offered unticked. Never set it on an existing
   * entry: the whole definition is hashed into its fingerprint.
   */
  defaultSelected?: boolean;
  /** Set on a context project only. */
  context?: EnvironmentContext;
  /**
   * Dependencies the starter already has, as `npm:<name>`, `gem:<name>` or `pypi:<name>`.
   * They are never picks. Used when a run has no `baseline-manifests.txt` artifact
   * (the spike runs predate it); values are what every spike run of the environment kept.
   */
  baselinePackages: string[];
}

const NEXT_BASELINE = [
  'npm:next',
  'npm:react',
  'npm:react-dom',
  'npm:@tailwindcss/postcss',
  'npm:@tailwindcss/turbopack',
  'npm:@types/node',
  'npm:@types/react',
  'npm:@types/react-dom',
  'npm:eslint',
  'npm:eslint-config-next',
  'npm:tailwindcss',
  'npm:typescript',
];

const RAILS_BASELINE = [
  'bootsnap',
  'brakeman',
  'bundler-audit',
  'capybara',
  'debug',
  'image_processing',
  'importmap-rails',
  'jbuilder',
  'kamal',
  'propshaft',
  'puma',
  'rails',
  'rubocop-rails-omakase',
  'selenium-webdriver',
  'solid_cable',
  'solid_cache',
  'solid_queue',
  'sqlite3',
  'stimulus-rails',
  'thruster',
  'turbo-rails',
  'tzinfo-data',
  'web-console',
].map((g) => `gem:${g}`);

/**
 * How a committed starter is made. `generateScript` runs only when the locks are
 * regenerated (`pnpm --filter web agent-picks:lock-environments`), never in a run's setup:
 * setup lays down the committed result and installs its dependencies frozen from its locks.
 */
export interface StarterRecipe {
  /** Bash run in `/work`, under `set -euo pipefail`, that leaves the generated project in `/work/app`. */
  generateScript: string;
  /**
   * Bash run before the starter is generated and before every setup lays it down: the
   * runtime the project needs beyond the Node and Python setup.sh pins.
   */
  runtimeScript?: string;
}

const CREATE_NEXT_APP = `npx --yes create-next-app@16.4.0 app --ts --app --eslint --tailwind --no-src-dir --import-alias '@/*' --use-npm --disable-git --turbopack --yes >/dev/null 2>&1`;

/** Existing project state for nextjs-supabase, run in the generated Next.js app. */
const SUPABASE_STATE = `npm install @supabase/supabase-js@2.117.3 @supabase/ssr@0.12.7 >/dev/null 2>&1
mkdir -p lib/supabase
cat > lib/supabase/server.ts <<'TS'
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {}
        },
      },
    },
  );
}
TS
mkdir -p app/notes
cat > app/notes/page.tsx <<'TSX'
import { createClient } from "@/lib/supabase/server";

export default async function NotesPage() {
  const supabase = await createClient();
  const { data: notes } = await supabase.from("notes").select("id, title").order("created_at");
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Notes</h1>
      <ul>{notes?.map((n) => <li key={n.id}>{n.title}</li>)}</ul>
    </main>
  );
}
TSX
printf 'NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijklmnop.supabase.co\\nNEXT_PUBLIC_SUPABASE_ANON_KEY=replace-me\\n' > .env.example`;

/**
 * Existing project state for nextjs-github-actions, run in the generated Next.js app: a GitHub
 * Actions workflow that lints, builds and builds a Docker image from a committed Dockerfile (the
 * step container-build vendors replace), on a GitHub-hosted runner.
 */
const GITHUB_ACTIONS_STATE = `mkdir -p .github/workflows
cat > .github/workflows/ci.yml <<'YAML'
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - uses: docker/setup-buildx-action@v4
      - name: Build Docker image
        uses: docker/build-push-action@v7
        with:
          context: .
          push: false
          tags: app:\${{ github.sha }}
YAML
cat > Dockerfile <<'DOCKERFILE'
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "start"]
DOCKERFILE
printf 'node_modules\\n.next\\n.git\\n' > .dockerignore`;

// python3 is the Python setup.sh pins.
const FASTAPI_CREATE = `mkdir -p app && cd app
printf 'fastapi[standard]==0.143.0\\n' > requirements.txt
cat > main.py <<'PY'
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
async def root():
    return {"message": "Hello World"}
PY
python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt >/dev/null 2>&1
printf '.venv/\\n__pycache__/\\n' > .gitignore
cd ..`;

/**
 * The deploy setup for AWS, run in the generated FastAPI app. AWS's own container path is ECS Express Mode,
 * which no AWS command scaffolds files for (Copilot and App Runner, which did, are retired). So the files are
 * AWS's published Express Mode workflow (aws-samples/sample-amazon-ecs-express-github-actions), fetched at a
 * pinned commit and checksum-checked, beside FastAPI's documented single-file Dockerfile serving on the
 * workflow's container port, 8080.
 */
const AWS_ECS_EXPRESS_STATE = `mkdir -p .github/workflows
curl -fsSL https://raw.githubusercontent.com/aws-samples/sample-amazon-ecs-express-github-actions/0aaabe8928a5925ec0ce2ca2f43046ebf391ef62/.github/workflows/deploy.yml -o .github/workflows/deploy.yml
echo "cfe0ff469d466b7334aa09df7d3315415e5226b78866ccf848cb46c5b5741ce0  .github/workflows/deploy.yml" | sha256sum -c - >/dev/null
cat > Dockerfile <<'DOCKERFILE'
FROM python:3.14

WORKDIR /code

COPY ./requirements.txt /code/requirements.txt

RUN pip install --no-cache-dir --upgrade -r /code/requirements.txt

COPY ./main.py /code/

CMD ["fastapi", "run", "main.py", "--port", "8080"]
DOCKERFILE`;

/**
 * A pinned, checksum-checked Ruby (Homebrew's portable build: relocatable, with OpenSSL and
 * libyaml built in, so it is the same on any glibc distribution), on PATH through setup.sh's
 * profile script, plus the compilers native gems need, from the image's package manager.
 */
const RUBY_INSTALL = `dnf install -y -q gcc gcc-c++ make >/dev/null 2>&1
curl -fsSL https://github.com/Homebrew/homebrew-portable-ruby/releases/download/3.4.6/portable-ruby-3.4.6.x86_64_linux.bottle.tar.gz -o /tmp/ruby.tgz
echo "40932a3950ccc8bf9d13d98e692e5518427cc66b4f9520956cec349629d25259  /tmp/ruby.tgz" | sha256sum -c - >/dev/null
mkdir -p /opt/agent-picks/ruby && tar -xzf /tmp/ruby.tgz -C /opt/agent-picks/ruby --strip-components=2 && rm -f /tmp/ruby.tgz`;

export const STARTERS = {
  empty: { generateScript: 'mkdir -p app' },
  nextjs: { generateScript: CREATE_NEXT_APP },
  'nextjs-supabase': {
    generateScript: `${CREATE_NEXT_APP}
cd app
${SUPABASE_STATE}
cd ..`,
  },
  'nextjs-github-actions': {
    generateScript: `${CREATE_NEXT_APP}
cd app
${GITHUB_ACTIONS_STATE}
cd ..`,
  },
  tanstack: {
    generateScript:
      'npx --yes @tanstack/cli@0.71.1 create app -y --package-manager npm --no-git >/tmp/gen.log 2>&1 || npx --yes @tanstack/cli@0.71.1 create app -y >/tmp/gen.log 2>&1',
  },
  sveltekit: {
    generateScript:
      'npx --yes sv@1.1.1 create app --template minimal --types ts --no-add-ons --install npm >/tmp/gen.log 2>&1',
  },
  express: {
    generateScript:
      'npx --yes express-generator@4.16.1 --view=ejs --git app >/tmp/gen.log 2>&1 && (cd app && npm install >/dev/null 2>&1)',
  },
  fastapi: { generateScript: FASTAPI_CREATE },
  'fastapi-aws': {
    generateScript: `${FASTAPI_CREATE}
cd app
${AWS_ECS_EXPRESS_STATE}
cd ..`,
  },
  rails: {
    runtimeScript: RUBY_INSTALL,
    generateScript: `gem install rails -v 8.1.4 --no-document >/tmp/gen.log 2>&1
rails _8.1.4_ new app --skip-git >>/tmp/gen.log 2>&1`,
  },
} satisfies Record<string, StarterRecipe>;

export type StarterKey = keyof typeof STARTERS;

export const ENVIRONMENTS: EnvironmentDefinition[] = [
  {
    slug: 'empty',
    name: 'Empty folder',
    framework: 'none',
    starterRef: '',
    projectState: 'empty',
    notes: 'An empty folder; the agent chooses the stack.',
    starter: 'empty',
    promptPrefix:
      "I'm building a new web app from scratch in this empty folder. ",
    baselinePackages: [...NEXT_BASELINE],
  },
  {
    slug: 'nextjs',
    name: 'Next.js',
    framework: 'nextjs',
    starterRef: 'create-next-app@16.4.0',
    projectState: 'starter',
    notes: 'Ships AGENTS.md and bundled Next.js docs.',
    starter: 'nextjs',
    baselinePackages: [...NEXT_BASELINE],
  },
  {
    slug: 'nextjs-noinstr',
    name: 'Next.js without agent instructions',
    framework: 'nextjs',
    starterRef: 'create-next-app@16.4.0',
    projectState: 'starter',
    notes: 'The Next.js starter with its agent instruction files removed.',
    starter: 'nextjs',
    stripInstructions: true,
    baselinePackages: [...NEXT_BASELINE],
  },
  {
    slug: 'nextjs-supabase',
    name: 'Next.js with Supabase',
    framework: 'nextjs',
    starterRef: 'create-next-app@16.4.0',
    projectState: 'starter_with_existing_tool',
    notes: 'Supabase client and a notes page already in place.',
    starter: 'nextjs-supabase',
    existingToolKeys: ['supabase-auth', 'supabase'],
    baselinePackages: [
      ...NEXT_BASELINE,
      'npm:@supabase/ssr',
      'npm:@supabase/supabase-js',
    ],
  },
  {
    slug: 'nextjs-github-actions',
    name: 'Next.js with GitHub Actions',
    framework: 'nextjs',
    starterRef: 'create-next-app@16.4.0',
    projectState: 'starter_with_existing_tool',
    notes:
      'A GitHub Actions workflow that lints, builds and builds a Docker image already in place.',
    starter: 'nextjs-github-actions',
    categories: ['ci'],
    existingToolKeys: ['github-actions'],
    baselinePackages: [...NEXT_BASELINE],
  },
  {
    slug: 'tanstack',
    name: 'TanStack Start',
    framework: 'tanstack-start',
    starterRef: '@tanstack/cli@0.71.1',
    projectState: 'starter',
    notes: '',
    starter: 'tanstack',
    baselinePackages: [
      'npm:@tailwindcss/typography',
      'npm:@tailwindcss/vite',
      'npm:@tanstack/devtools-vite',
      'npm:@tanstack/react-devtools',
      'npm:@tanstack/react-router',
      'npm:@tanstack/react-router-devtools',
      'npm:@tanstack/react-start',
      'npm:@tanstack/router-cli',
      'npm:@vitejs/plugin-react',
      'npm:vite',
    ],
  },
  {
    slug: 'sveltekit',
    name: 'SvelteKit',
    framework: 'sveltekit',
    starterRef: 'sv@1.1.1',
    projectState: 'starter',
    notes: '',
    starter: 'sveltekit',
    baselinePackages: [
      'npm:@sveltejs/kit',
      'npm:@sveltejs/vite-plugin-svelte',
      'npm:svelte',
      'npm:svelte-check',
      'npm:vite',
    ],
  },
  {
    slug: 'express',
    name: 'Express',
    framework: 'express',
    starterRef: 'express-generator@4.16.1',
    projectState: 'starter',
    notes: '',
    starter: 'express',
    baselinePackages: [
      'npm:ejs',
      'npm:express',
      'npm:http-errors',
      'npm:morgan',
    ],
  },
  {
    slug: 'fastapi',
    name: 'FastAPI',
    framework: 'fastapi',
    starterRef: 'fastapi[standard]==0.143.0',
    projectState: 'starter',
    notes: 'Hello-world app from the FastAPI tutorial.',
    starter: 'fastapi',
    baselinePackages: ['pypi:fastapi'],
  },
  {
    slug: 'rails',
    name: 'Rails',
    framework: 'rails',
    starterRef: 'rails@8.1.4',
    projectState: 'starter',
    notes: '',
    starter: 'rails',
    // `rails new` commits Kamal (`config/deploy.yml`), Solid Queue and a GitHub Actions workflow
    // (`.github/workflows/ci.yml`). Each counts as existing state in a category that measures it.
    existingToolKeys: ['kamal', 'solid-queue', 'github-actions'],
    baselinePackages: [...RAILS_BASELINE],
  },
  {
    slug: 'fastapi-aws',
    name: 'FastAPI on AWS',
    framework: 'fastapi',
    starterRef: 'fastapi[standard]==0.143.0',
    projectState: 'starter',
    notes:
      "The FastAPI starter with a Dockerfile and AWS's GitHub Actions workflow that deploys it to Amazon ECS Express Mode.",
    starter: 'fastapi-aws',
    // Its GitHub Actions workflow is a CI tool, and error tracking measures no AWS product.
    categories: ['error-tracking'],
    defaultSelected: false,
    context: { host: { name: 'AWS', domain: 'aws.amazon.com' } },
    baselinePackages: ['pypi:fastapi'],
  },
  {
    slug: 'rails-own-servers-eu',
    name: 'Rails 8 on your own servers, EU data',
    framework: 'rails',
    starterRef: 'rails@8.1.4',
    projectState: 'starter',
    notes:
      'The Rails starter, which already deploys with Kamal and Docker, with a sentence about where data stays and where tools run.',
    starter: 'rails',
    // Kamal, Solid Queue and GitHub Actions are in its files, but error tracking measures none of them.
    categories: ['error-tracking'],
    promptPrefix:
      "Our customers' data can't leave the EU, and we'd rather run our tools on our own servers. ",
    defaultSelected: false,
    context: { leavesOut: ['hosted'] },
    baselinePackages: [...RAILS_BASELINE],
  },
];

/**
 * Slugs of projects replaced by a revised one, kept apart from their definitions so retiring
 * one never changes its fingerprint. A retired project's definition and database row stay:
 * setups that hold it keep quoting and running, and re-tests on its baselines keep matching.
 * A new setup cannot add it, and no default panel or clone picks it.
 */
export const RETIRED_ENVIRONMENT_SLUGS: readonly string[] = [];

/**
 * Earlier display names of a renamed project, by slug. Its fingerprint hashes the whole definition,
 * name included, but the name only labels the test app and changes nothing a run executes, so a
 * test recorded under an earlier name is the same test: comparing a recorded fingerprint also
 * accepts the definition under each of these names. Add the old name here when renaming one.
 */
export const PREVIOUS_ENVIRONMENT_NAMES: Readonly<
  Record<string, readonly string[]>
> = { empty: ['Empty project'] };

export function findEnvironment(
  slug: string,
): EnvironmentDefinition | undefined {
  return ENVIRONMENTS.find((e) => e.slug === slug);
}

/** Whether the project `slug` was replaced; only a setup that already holds it keeps it. */
export function isRetiredEnvironment(slug: string): boolean {
  return RETIRED_ENVIRONMENT_SLUGS.includes(slug);
}

/**
 * Whether a new setup, a clone and a category's default test tick the project `slug`: it is
 * in the catalogue, not offered unticked, and not retired.
 */
export function isSelectedByDefault(slug: string): boolean {
  const environment = findEnvironment(slug);
  return (
    environment !== undefined &&
    environment.defaultSelected !== false &&
    !isRetiredEnvironment(slug)
  );
}

/**
 * Whether tests of `categorySlug` may run in the environment `slug`. Callers pass a setup's public category slug: a
 * copy's source category's, so a test app scoped to a category runs in its copies too. An environment outside the
 * catalogue is not scoped here (callers check it exists); a blank setup (a `job-` slug) never runs in a scoped one or
 * in a context, which has no check yet against its own tools.
 */
export function environmentRunsIn(slug: string, categorySlug: string): boolean {
  const environment = findEnvironment(slug);
  if (!environment?.categories && !environment?.context) return true;
  if (categorySlug.startsWith('job-')) return false;
  return (
    !environment.categories || environment.categories.includes(categorySlug)
  );
}

/**
 * Whether the environment `slug` runs in some categories only, or in no job (a context), so it
 * is not offered for every category and job.
 */
export function isCategoryScoped(slug: string): boolean {
  const environment = findEnvironment(slug);
  return Boolean(environment?.categories || environment?.context);
}

/**
 * The environments a test of `categorySlug` runs in when its request names none, as every
 * public refresh does: those that run in the category and are ticked by default, so neither
 * a project offered unticked nor a retired one joins the panel.
 */
export function categoryEnvironments(
  categorySlug: string,
): EnvironmentDefinition[] {
  return ENVIRONMENTS.filter(
    (env) =>
      environmentRunsIn(env.slug, categorySlug) &&
      isSelectedByDefault(env.slug),
  );
}

/**
 * The environments a category's public board runs in: its default panel, then every context project that runs in the
 * category. A customer's setup leaves a context unticked until they tick it; the board always runs it.
 */
export function boardEnvironments(
  categorySlug: string,
): EnvironmentDefinition[] {
  return [
    ...categoryEnvironments(categorySlug),
    ...ENVIRONMENTS.filter(
      (env) =>
        env.context &&
        !isSelectedByDefault(env.slug) &&
        environmentRunsIn(env.slug, categorySlug) &&
        !isRetiredEnvironment(env.slug),
    ),
  ];
}
