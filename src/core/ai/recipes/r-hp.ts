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
      supports_prompt_cache: false,
      // The promoted Qwen runtime serves a quantized 65,536-token KV cache.
      // Keep this aligned with the appliance health contract; lower stale
      // declarations make otherwise-valid GBrain prompts fail before inference.
      max_context_tokens: 65536,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-21',
    },
  },
  setup_hint: 'Start Unsloth Studio on r-hp and set R_HP_BASE_URL / R_HP_API_KEY.',
};
