import type { Recipe } from '../types.ts';

/** Dedicated heavy Gemma appliance on r-hp (Tailscale-only). */
export const rhpGemma: Recipe = {
  id: 'r-hp-gemma',
  name: 'r-hp Gemma specialist (private local inference)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://100.107.145.48:8889/v1',
  resolveOpenAICompatConfig: (env) => ({
    baseURL: (env.R_HP_GEMMA_BASE_URL || 'http://100.107.145.48:8889/v1').replace(/\/+$/, ''),
  }),
  auth_env: {
    required: ['R_HP_API_KEY'],
    optional: ['R_HP_GEMMA_BASE_URL'],
    setup_url: 'tailscale://r-hp',
  },
  touchpoints: {
    chat: {
      models: [],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 65536,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-30',
    },
  },
  setup_hint: 'Start the r-hp Gemma server and set R_HP_GEMMA_BASE_URL / R_HP_API_KEY.',
};
