import type { Recipe } from '../types.ts';

/** DeepSeek's OpenAI-compatible API for GBrain reasoning and agent work. */
export const deepseek: Recipe = {
  id: 'deepseek',
  name: 'DeepSeek',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.deepseek.com/v1',
  auth_env: {
    required: ['DEEPSEEK_API_KEY'],
    setup_url: 'https://platform.deepseek.com/api_keys',
  },
  touchpoints: {
    chat: {
      models: ['deepseek-chat', 'deepseek-reasoner'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      price_last_verified: '2026-07-30',
    },
    expansion: {
      models: ['deepseek-chat', 'deepseek-reasoner'],
      price_last_verified: '2026-07-30',
    },
  },
  setup_hint: 'Set DEEPSEEK_API_KEY and use deepseek:deepseek-chat or deepseek:deepseek-reasoner.',
};
