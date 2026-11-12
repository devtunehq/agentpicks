/**
 * ABOUTME: Pinned OpenCode provider catalogue for the priced models, captured from https://models.opencode.ai/api.json.
 * The gateway entry is that catalogue's `vercel` provider for the gateway models, renamed `gateway` and called over
 * the gateway's OpenAI-compatible Chat Completions API (`@ai-sdk/openai-compatible`), which the model proxy meters.
 */

export const OPENCODE_MODELS = {
  anthropic: {
    id: 'anthropic',
    env: [],
    npm: '@ai-sdk/anthropic',
    name: 'Anthropic',
    doc: 'https://docs.anthropic.com/en/docs/about-claude/models',
    models: {
      'claude-fable-5-1': {
        id: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        description:
          'Claude model for demanding reasoning and long-horizon agentic work',
        family: 'claude-fable',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-06',
        release_date: '2026-09-01',
        last_updated: '2026-09-01',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 10,
          output: 50,
          cache_read: 0.25,
          cache_write: 12.5,
        },
        canonical_model_id: 'anthropic/claude-fable-5-1',
      },
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        description:
          'Claude model for long-running agentic coding and knowledge work',
        family: 'claude-opus',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-06',
        release_date: '2026-09-22',
        last_updated: '2026-09-22',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1000000,
          output: 128000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 8,
                output: 40,
                cache_read: 0.4,
                cache_write: 10,
              },
              provider: {
                body: {
                  speed: 'fast',
                },
                headers: {
                  'anthropic-beta': 'fast-mode-2026-02-01',
                },
              },
            },
          },
        },
        cost: {
          input: 4,
          output: 20,
          cache_read: 0.2,
          cache_write: 5,
        },
        canonical_model_id: 'anthropic/claude-opus-5-5',
      },
      'claude-sonnet-5': {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        description:
          'Everyday Claude agent model for coding, planning, browsing, and general work',
        family: 'claude-sonnet',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'toggle',
          },
          {
            type: 'effort',
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-01-31',
        release_date: '2026-06-29',
        last_updated: '2026-06-30',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.2,
          cache_write: 2.5,
        },
      },
      'claude-sonnet-5-5': {
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        description:
          'Fast Claude model for everyday coding, agents, and knowledge work',
        family: 'claude-sonnet',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-06',
        release_date: '2026-09-28',
        last_updated: '2026-09-28',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.1,
          cache_write: 2.5,
        },
        canonical_model_id: 'anthropic/claude-sonnet-5-5',
      },
      'claude-haiku-5-5': {
        id: 'claude-haiku-5-5',
        name: 'Claude Haiku 5.5',
        description:
          'Fast Claude model for responsive assistance, classification, and lightweight agents',
        family: 'claude-haiku',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'toggle',
          },
          {
            type: 'effort',
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-06',
        release_date: '2026-10-07',
        last_updated: '2026-10-07',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1000000,
          output: 128000,
        },
        cost: {
          input: 0.1,
          output: 0.5,
          cache_read: 0.01,
          cache_write: 0.125,
          tiers: [
            {
              input: 0.5,
              output: 2.5,
              cache_read: 0.05,
              cache_write: 0.625,
              tier: {
                type: 'context',
                size: 100000,
              },
            },
          ],
        },
        canonical_model_id: 'anthropic/claude-haiku-5-5',
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5 (latest)',
        description:
          'Fast Claude lane for lightweight agents, office tasks, and responsive chat',
        family: 'claude-haiku',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'budget_tokens',
            min: 1024,
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: true,
        knowledge: '2025-02-28',
        release_date: '2025-10-15',
        last_updated: '2025-10-15',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 200000,
          output: 64000,
        },
        cost: {
          input: 1,
          output: 5,
          cache_read: 0.1,
          cache_write: 1.25,
        },
        canonical_model_id: 'anthropic/claude-haiku-4-5',
      },
    },
  },
  openai: {
    id: 'openai',
    env: [],
    npm: '@ai-sdk/openai',
    name: 'OpenAI',
    doc: 'https://platform.openai.com/docs/models',
    models: {
      'gpt-6-astra': {
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        description:
          "GPT-6 Astra is OpenAI's most capable model for complex reasoning, coding, computer use, research, and document creation.",
        family: 'gpt-astra',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-04-30',
        release_date: '2026-09-04',
        last_updated: '2026-09-04',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 20,
                output: 100,
                cache_read: 2,
                cache_write: 25,
              },
              provider: {
                body: {
                  service_tier: 'priority',
                },
              },
            },
            pro: {
              provider: {
                body: {
                  reasoning: {
                    mode: 'pro',
                  },
                },
              },
            },
            ultrafast: {
              cost: {
                input: 60,
                output: 300,
                cache_read: 6,
                cache_write: 75,
              },
              provider: {
                body: {
                  service_tier: 'ultrafast',
                },
              },
            },
          },
        },
        cost: {
          input: 10,
          output: 50,
          cache_read: 1,
          cache_write: 12.5,
          tiers: [
            {
              input: 20,
              output: 75,
              cache_read: 2,
              cache_write: 25,
              tier: {
                type: 'context',
                size: 272000,
              },
            },
          ],
          context_over_200k: {
            input: 20,
            output: 75,
            cache_read: 2,
            cache_write: 25,
          },
        },
        canonical_model_id: 'openai/gpt-6-astra',
      },
      'gpt-6.1-sol': {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        description:
          'Near-Astra performance for complex coding, computer use, and professional work at a lower cost.',
        family: 'gpt-sol',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-04-30',
        release_date: '2026-09-29',
        last_updated: '2026-09-29',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 4,
                output: 20,
                cache_read: 0.2,
                cache_write: 5,
              },
              provider: {
                body: {
                  service_tier: 'priority',
                },
              },
            },
            pro: {
              provider: {
                body: {
                  reasoning: {
                    mode: 'pro',
                  },
                },
              },
            },
            ultrafast: {
              cost: {
                input: 12,
                output: 60,
                cache_read: 0.6,
                cache_write: 15,
              },
              provider: {
                body: {
                  service_tier: 'ultrafast',
                },
              },
            },
          },
        },
        cost: {
          input: 2,
          output: 10,
          cache_read: 0.1,
          cache_write: 2.5,
          tiers: [
            {
              input: 4,
              output: 15,
              cache_read: 0.2,
              cache_write: 5,
              tier: {
                type: 'context',
                size: 272000,
              },
            },
          ],
          context_over_200k: {
            input: 4,
            output: 15,
            cache_read: 0.2,
            cache_write: 5,
          },
        },
        canonical_model_id: 'openai/gpt-6.1-sol',
      },
      'gpt-6-luna': {
        id: 'gpt-6-luna',
        name: 'GPT-6 Luna',
        description:
          "OpenAI's most efficient model for focused, high-volume tasks",
        family: 'gpt-luna',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: false,
        knowledge: '2026-05-18',
        release_date: '2026-09-22',
        last_updated: '2026-09-22',
        modalities: {
          input: ['text', 'image', 'pdf'],
          output: ['text'],
        },
        open_weights: false,
        limit: {
          context: 1050000,
          input: 922000,
          output: 128000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 0.2,
                output: 1,
                cache_read: 0.02,
                cache_write: 0.25,
              },
              provider: {
                body: {
                  service_tier: 'priority',
                },
              },
            },
            pro: {
              provider: {
                body: {
                  reasoning: {
                    mode: 'pro',
                  },
                },
              },
            },
          },
        },
        cost: {
          input: 0.1,
          output: 0.5,
          cache_read: 0.01,
          cache_write: 0.125,
          tiers: [
            {
              input: 0.2,
              output: 0.75,
              cache_read: 0.02,
              cache_write: 0.25,
              tier: {
                type: 'context',
                size: 272000,
              },
            },
          ],
          context_over_200k: {
            input: 0.2,
            output: 0.75,
            cache_read: 0.02,
            cache_write: 0.25,
          },
        },
        canonical_model_id: 'openai/gpt-6-luna',
      },
    },
  },
  gateway: {
    id: 'gateway',
    env: [],
    npm: '@ai-sdk/openai-compatible',
    name: 'Vercel AI Gateway',
    doc: 'https://vercel.com/docs/ai-gateway',
    models: {
      'zai/glm-5.3': {
        id: 'zai/glm-5.3',
        name: 'GLM 5.3',
        description:
          'Flagship GLM model for long-horizon coding, agents, and complex project delivery',
        family: 'glm',
        attachment: false,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['low', 'high', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: '2026-08-14',
        last_updated: '2026-08-14',
        modalities: {
          input: ['text'],
          output: ['text'],
        },
        open_weights: true,
        limit: {
          context: 1000000,
          output: 1000000,
        },
        cost: {
          input: 1.4,
          output: 4.4,
          cache_read: 0.14,
        },
        canonical_model_id: 'zhipuai/glm-5.3',
      },
      'zai/glm-5.3-flash': {
        id: 'zai/glm-5.3-flash',
        name: 'GLM 5.3 Flash',
        description:
          'Native multimodal GLM model for efficient coding and long-horizon agent tasks',
        family: 'glm-flash',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['low', 'high', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: '2026-08-26',
        last_updated: '2026-08-26',
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
        open_weights: true,
        limit: {
          context: 1000000,
          output: 131000,
        },
        cost: {
          input: 0.15,
          output: 0.5,
          cache_read: 0.03,
        },
        canonical_model_id: 'zhipuai/glm-5.3-flash',
      },
      'deepseek/deepseek-v4.1-flash-1017': {
        id: 'deepseek/deepseek-v4.1-flash-1017',
        name: 'DeepSeek V4.1 Flash 1017',
        description:
          'Fast DeepSeek model for efficient chat, coding help, and agent loops',
        family: 'deepseek-flash',
        attachment: true,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['none', 'low', 'high', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: true,
        knowledge: '2025-05',
        release_date: '2026-10-17',
        last_updated: '2026-10-17',
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
        open_weights: true,
        limit: {
          context: 1048576,
          output: 262144,
        },
        cost: {
          input: 0.3,
          output: 1.2,
          cache_read: 0.007,
        },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
      },
      'deepseek/deepseek-v4-pro-0813': {
        id: 'deepseek/deepseek-v4-pro-0813',
        name: 'DeepSeek V4 Pro 0813',
        description:
          'Flagship DeepSeek model for coding, reasoning, and agentic work',
        family: 'deepseek-thinking',
        attachment: false,
        reasoning: true,
        reasoning_options: [
          {
            type: 'effort',
            values: ['none', 'low', 'high', 'max'],
          },
        ],
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: '2026-08-13',
        last_updated: '2026-08-22',
        modalities: {
          input: ['text'],
          output: ['text'],
        },
        open_weights: true,
        limit: {
          context: 1000000,
          output: 384000,
        },
        cost: {
          input: 0.66,
          output: 1.98,
          cache_read: 0.066,
        },
        canonical_model_id: 'deepseek/deepseek-v4-pro-0813',
      },
    },
  },
} as const;

export const OPENCODE_MODELS_JSON = JSON.stringify(OPENCODE_MODELS);
