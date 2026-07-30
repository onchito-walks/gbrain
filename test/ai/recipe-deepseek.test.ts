import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { defaultResolveAuth } from '../../src/core/ai/gateway.ts';
import { assertTouchpoint } from '../../src/core/ai/model-resolver.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';

describe('recipe: deepseek', () => {
  test('is registered as an OpenAI-compatible chat provider', () => {
    const recipe = getRecipe('deepseek');
    expect(recipe).toBeDefined();
    expect(recipe!.base_url_default).toBe('https://api.deepseek.com/v1');
    expect(recipe!.auth_env?.required).toEqual(['DEEPSEEK_API_KEY']);
    expect(recipe!.touchpoints.chat?.supports_prompt_cache).toBe(false);
    expect(recipe!.touchpoints.chat?.supports_subagent_loop).toBe(true);
    expect(() => assertTouchpoint(recipe!, 'chat', 'deepseek-chat')).not.toThrow();
    expect(() => assertTouchpoint(recipe!, 'chat', 'deepseek-reasoner')).not.toThrow();
  });

  test('resolves config-plane DeepSeek credentials without exposing them', () => {
    const gateway = buildGatewayConfig({
      engine: 'pglite',
      deepseek_api_key: 'test-deepseek-key',
    });
    expect(gateway.env.DEEPSEEK_API_KEY).toBe('test-deepseek-key');
    const auth = defaultResolveAuth(getRecipe('deepseek')!, gateway.env, 'chat');
    expect(auth.token).toBe('Bearer test-deepseek-key');
  });
});
