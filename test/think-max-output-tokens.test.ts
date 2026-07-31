/**
 * Pins `maxOutputTokensFor` — the per-model output-token budget `runThink`
 * passes to `client.create`. Thinking-by-default Claude 5 models
 * (`anthropic:claude-*-5`) spend a large share of the budget on internal
 * reasoning before emitting an answer, so the 4000 default left `think` with
 * empty/truncated text. They now get 16000; everything else stays 4000.
 */
import { describe, test, expect } from 'bun:test';
import { maxOutputTokensFor } from '../src/core/think/index.ts';

describe('maxOutputTokensFor — thinking-default headroom', () => {
  test('the local r-hp appliance has a bounded practical output budget', () => {
    expect(maxOutputTokensFor('r-hp:unsloth/Qwen3.5-9B-GGUF')).toBe(1024);
    expect(maxOutputTokensFor('r-hp-gemma:gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf')).toBe(1024);
  });

  test('Claude 5 family gets 16000', () => {
    expect(maxOutputTokensFor('anthropic:claude-sonnet-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-opus-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-fable-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-haiku-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic/claude-sonnet-5')).toBe(16000); // slash form
  });

  test('other non-Claude-5 models keep 4000', () => {
    expect(maxOutputTokensFor('anthropic:claude-opus-4-8')).toBe(4000);
    expect(maxOutputTokensFor('anthropic:claude-haiku-4-5')).toBe(4000);
    expect(maxOutputTokensFor('anthropic:claude-sonnet-4-6')).toBe(4000);
    expect(maxOutputTokensFor('anthropic:claude-3-haiku')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-4o')).toBe(4000);
    expect(maxOutputTokensFor('deepseek:deepseek-reasoner')).toBe(4000);
  });
});
