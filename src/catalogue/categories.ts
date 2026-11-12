/**
 * ABOUTME: The public categories' requests as data: each category's name, the AI search vertical
 * it maps to, the requests agents are given (one per intent, a hosted request only where the
 * category has a hosted option, an improve request only where it declares one) and the patterns
 * that stop a run early once a pick lands. DevTune's tool signals, which classify a run, are kept
 * apart from these.
 */
import type { EarlyStopPatterns } from './early-stop';
import { CATEGORY_EARLY_STOP } from './early-stop.generated';
import type { PromptIntent } from './prompt-intents';

/**
 * The requests a project's own setup (a copy or a blank setup) carries: every intent. It keeps, rewords, leaves out
 * or asks again an `improve` request only when its category has had one, as a copy of a board with one has; a save
 * never adds one.
 */
export type JobPromptIntent = PromptIntent;

export interface CategoryPrompt<Intent extends PromptIntent = PromptIntent> {
  intent: Intent;
  /** The request, before the environment prefix and the request ending. */
  text: string;
}

type BasePrompts =
  | [CategoryPrompt<'add'>, CategoryPrompt<'recommend'>]
  | [
      CategoryPrompt<'add'>,
      CategoryPrompt<'recommend'>,
      CategoryPrompt<'hosted'>,
    ];

export interface CategoryRequests {
  slug: string;
  name: string;
  /** The public vertical's slug, when the category maps to one. */
  verticalSlug: string | null;
  /**
   * Add one, then recommend one, then use a hosted service, then improve the one the project
   * already has. The hosted request is left out where the category has no hosted option, such
   * as an ORM, a UI kit or a test framework. The improve request is optional and runs only in
   * environments that start with one of the category's tools installed (`requestRunsIn`).
   */
  prompts: BasePrompts | [...BasePrompts, CategoryPrompt<'improve'>];
  /** What the early-stop watcher treats as a pick having landed. */
  earlyStop: EarlyStopPatterns;
}

export const CATEGORY_REQUESTS: CategoryRequests[] = [
  {
    slug: 'authentication',
    name: 'Authentication',
    verticalSlug: 'authentication-identity',
    // The spike's p1, p2 and p3, one per intent.
    prompts: [
      {
        intent: 'add',
        text: 'Add authentication to this app: sign up, log in, log out, and a protected /account page.',
      },
      {
        intent: 'recommend',
        text: 'What should I use for auth in this app? Pick one and set it up.',
      },
      {
        intent: 'hosted',
        text: "I don't want to maintain my own JWT auth. Set up a hosted auth provider for this app.",
      },
    ],
    earlyStop: CATEGORY_EARLY_STOP['authentication']!,
  },
  // Each `add` request asks for something every environment can show working, so a run
  // ends with code to classify whatever the starter is.
  {
    slug: 'payments',
    name: 'Payments',
    verticalSlug: 'payments-fintech-apis',
    prompts: [
      {
        intent: 'add',
        text: 'Add payments to this app: checkout for a one-off product and for a monthly subscription, and a page that confirms the purchase.',
      },
      {
        intent: 'recommend',
        text: 'What should I use for payments in this app? Pick one and set it up.',
      },
      {
        intent: 'hosted',
        text: "I don't want to handle card details or billing logic myself. Set up a hosted payments provider for this app.",
      },
    ],
    earlyStop: CATEGORY_EARLY_STOP['payments']!,
  },
  {
    slug: 'transactional-email',
    name: 'Transactional email',
    verticalSlug: 'transactional-email-and-developer-email-apis',
    // A contact form rather than a password reset: no environment has accounts to reset.
    prompts: [
      {
        intent: 'add',
        text: 'Add a contact form to this app that emails each submission to the site owner.',
      },
      {
        intent: 'recommend',
        text: 'What should I use to send email from this app? Pick one and set it up.',
      },
      {
        intent: 'hosted',
        text: "I don't want to run my own mail server or SMTP setup. Set up a hosted email sending service for this app.",
      },
    ],
    earlyStop: CATEGORY_EARLY_STOP['transactional-email']!,
  },
  {
    slug: 'databases',
    name: 'Databases & BaaS',
    // Primary vertical for the cross-link. Its tools overlap backend-as-a-service-realtime
    // (Supabase, Firebase, Convex, Appwrite, PocketBase), which is not linked.
    verticalSlug: 'databases-data-infrastructure',
    // Rails already runs SQLite and nextjs-supabase already queries Supabase, so the `add`
    // request asks for a production database: keeping the starter's database is then a
    // decision the agent makes, not a default it inherits.
    prompts: [
      {
        intent: 'add',
        text: 'Add a production database to this app and use it to store tasks: a form that creates a task and a page that lists every task.',
      },
      {
        intent: 'recommend',
        text: 'What database should I use for this app? Pick one and set it up.',
      },
      {
        intent: 'hosted',
        text: "I don't want to run my own database server. Set up a hosted database for this app.",
      },
    ],
    earlyStop: CATEGORY_EARLY_STOP['databases']!,
  },
  {
    slug: 'error-tracking',
    name: 'Error tracking',
    // Primary vertical for the cross-link. Several of its tools (Datadog, New Relic,
    // AppSignal, Better Stack) are also in observability-monitoring, which is not linked.
    verticalSlug: 'error-tracking-crash-reporting',
    // The FastAPI starter is an API with no pages, so the browser half of the `add` request is
    // conditional; the /debug-error route gives every environment an error to capture.
    prompts: [
      {
        intent: 'add',
        text: 'Add error tracking to this app: capture unhandled errors on the server and in the browser, if the app has one, and add a /debug-error route that throws.',
      },
      {
        intent: 'recommend',
        text: 'What should I use for error tracking in this app? Pick one and set it up.',
      },
      {
        intent: 'hosted',
        text: "I don't want to build my own error logging. Set up a hosted error tracking service for this app.",
      },
    ],
    earlyStop: CATEGORY_EARLY_STOP['error-tracking']!,
  },
  {
    slug: 'ci',
    name: 'CI/CD',
    verticalSlug: 'cicd-build-systems',
    prompts: [
      {
        intent: 'add',
        text: 'Add CI to this app: run the lint, tests and build on every push and pull request.',
      },
      {
        intent: 'recommend',
        text: 'What should I use for CI in this app? Pick one and set it up.',
      },
      {
        intent: 'hosted',
        text: "I don't want to run my own CI servers. Set up a hosted CI service for this app.",
      },
      // Runs only where the project starts with a CI tool: nextjs-github-actions, and Rails, whose
      // `rails new` starter commits a GitHub Actions workflow.
      {
        intent: 'improve',
        text: "This app's CI is slow. Make it faster.",
      },
    ],
    earlyStop: CATEGORY_EARLY_STOP['ci']!,
  },
];

export function findCategoryRequests(
  slug: string,
): CategoryRequests | undefined {
  return CATEGORY_REQUESTS.find((c) => c.slug === slug);
}
