import { describe, expect, test } from 'bun:test';
import { applyOpenAICompatConfig } from '../../src/core/ai/gateway.ts';
import { rhp } from '../../src/core/ai/recipes/r-hp.ts';

describe('r-hp recipe endpoint resolution', () => {
  test('honors R_HP_BASE_URL rather than always using the Unsloth default', () => {
    expect(applyOpenAICompatConfig(rhp, {
      env: { R_HP_BASE_URL: 'http://100.107.145.48:8891/v1/' },
    } as any).baseURL).toBe('http://100.107.145.48:8891/v1');
  });
});
