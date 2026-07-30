import { describe, expect, test } from 'bun:test';
import { applyOpenAICompatConfig } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { rhpGemma } from '../../src/core/ai/recipes/r-hp-gemma.ts';

describe('r-hp-gemma recipe endpoint resolution', () => {
  test('is registered for model resolution', () => {
    expect(getRecipe('r-hp-gemma')).toBe(rhpGemma);
  });

  test('uses the dedicated Gemma default endpoint', () => {
    expect(applyOpenAICompatConfig(rhpGemma, { env: {} } as any).baseURL)
      .toBe('http://100.107.145.48:8889/v1');
  });

  test('honors R_HP_GEMMA_BASE_URL and normalizes a trailing slash', () => {
    expect(applyOpenAICompatConfig(rhpGemma, {
      env: { R_HP_GEMMA_BASE_URL: 'http://100.107.145.48:8899/v1/' },
    } as any).baseURL).toBe('http://100.107.145.48:8899/v1');
  });
});
