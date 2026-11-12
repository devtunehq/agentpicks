/** ABOUTME: The request intents a category asks agents in, which environments leave out by name. */

/** Every request intent, in the order tests list and show them. */
export const PROMPT_INTENTS = [
  'add',
  'recommend',
  'hosted',
  'improve',
] as const;

export type PromptIntent = (typeof PROMPT_INTENTS)[number];
