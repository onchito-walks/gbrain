import { describe, expect, test } from 'bun:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { applyResolveAuth, opencodeGoSessionHeaders } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import type { AIGatewayConfig } from '../../src/core/ai/types.ts';

function config(id: string, url: string, session?: string): AIGatewayConfig {
  return { base_urls: { [id]: url }, env: { DEEPSEEK_API_KEY: 'fixture', LITELLM_API_KEY: 'fixture', OPENCODE_GO_SESSION: session, HOSTNAME: 'fixture-host' }, chat_model: 'deepseek:fixture' } as AIGatewayConfig;
}

describe('OpenCode GO unified auth', () => {
  test.each(['deepseek', 'litellm'])('%s sends session through real SDK transport for each touchpoint', async id => {
    const recipe = getRecipe(id)!;
    const cfg = config(id, 'https://opencode.ai/zen/go/v1', ' deployment-fixture ');
    for (const touchpoint of ['embedding', 'expansion', 'chat', 'reranker'] as const) {
      const auth = applyResolveAuth(recipe, cfg, touchpoint);
      let captured: Headers | undefined;
      const provider = createOpenAICompatible({ name: id, baseURL: cfg.base_urls![id]!, ...auth,
        fetch: async (_url, init) => {
          captured = new Headers(init?.headers);
          return new Response(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
        } });
      await generateText({ model: provider.chatModel('fixture'), prompt: 'fixture', maxRetries: 0 });
      expect(captured!.get('x-opencode-session')).toBe('deployment-fixture');
      expect(captured!.get('authorization')).toBe('Bearer fixture');
    }
  });
  test.each(['https://api.deepseek.com/v1', 'http://localhost:4000/v1', 'https://opencode.ai.example/v1', 'invalid'])('no header for %s', url => {
    expect(opencodeGoSessionHeaders(getRecipe('deepseek')!, config('deepseek', url))).toBeUndefined();
  });
  test('recipe scope, stable fallback, and subdomain', () => {
    expect(opencodeGoSessionHeaders(getRecipe('groq')!, config('groq', 'https://opencode.ai/v1'))).toBeUndefined();
    expect(opencodeGoSessionHeaders(getRecipe('deepseek')!, config('deepseek', 'https://api.opencode.ai/v1', '   '))).toEqual({ 'x-opencode-session': 'gbrain-go-session:fixture-host' });
  });
  test('default headers preserved and auth shadow still refused', () => {
    const recipe = { ...getRecipe('deepseek')!, default_headers: { 'x-fixture': 'yes' } };
    const cfg = config('deepseek', 'https://opencode.ai/v1');
    expect(applyResolveAuth(recipe, cfg, 'chat').headers?.['x-fixture']).toBe('yes');
    expect(() => applyResolveAuth({ ...recipe, default_headers: { Authorization: 'shadow' } }, cfg, 'chat')).toThrow('shadow');
  });
});
