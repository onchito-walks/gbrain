import type { Recipe } from '../types.ts';

/** Private r-hp Unsloth Studio inference host (Tailscale-only). */
export const rhp: Recipe = {
  id: 'r-hp',
  name: 'r-hp Unsloth Studio (private local inference)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://100.107.145.48:8888/v1',
  // The appliance endpoint is selected by environment so service units can
  // promote a different compatible runner without patching the recipe.
  resolveOpenAICompatConfig: (env) => ({
    baseURL: (env.R_HP_BASE_URL || 'http://100.107.145.48:8888/v1').replace(/\/+$/, ''),
  }),
  auth_env: {
    required: ['R_HP_API_KEY'],
    optional: ['R_HP_BASE_URL'],
    setup_url: 'tailscale://r-hp',
  },
  touchpoints: {
    chat: {
      models: [],
      supports_tools: true,
      supports_subagent_loop: true,
      // r-hp retains the Qwen KV/prefix cache locally for the promoted runtime.
      // This is real local prompt reuse (not an Anthropic billing feature):
      // repeated subagent turns share the appliance's stable prompt prefix at
      // zero marginal token cost.  Keep it aligned with the r-hp health
      // contract; declaring this false incorrectly blocks the local loop.
      supports_prompt_cache: true,
      max_context_tokens: 65536,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-21',
    },
  },
  setup_hint: 'Start Unsloth Studio on r-hp and set R_HP_BASE_URL / R_HP_API_KEY.',
};
