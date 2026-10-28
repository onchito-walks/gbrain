/**
 * Chat-lane cache telemetry normalization (`gateway.chat()` → `usageOut`).
 *
 * `ChatResult.usage.input_tokens` is the TOTAL prompt and the cache buckets are
 * subsets of it (the `recordChatUsage` pricing contract). Before this fix the
 * gateway only read Anthropic `providerMetadata` and the legacy flat
 * `usage.cachedInputTokens`, so an AI SDK v6 result whose cache counts live in
 * `usage.inputTokenDetails` recorded 0/0 cache tokens even though the provider
 * charged for them.
 *
 * These tests drive the real gateway usage assembly through the generateText
 * seam (so `chat()` runs, the ledger record runs, and cache math prices
 * correctly) and pin:
 *   - v6 nested cache reads AND writes (input total preserved, not double-counted)
 *   - providerMetadata / legacy flat fallbacks, and precedence between them
 *   - zero cache on a caching-capable model and on a proxy that declares no
 *     prompt caching — absence of evidence is 0, never inferred from the name
 *   - invalid candidates (NaN, Infinity, negative, non-numeric) falling through
 *     to a real value, then to 0
 *   - the raw Messages-API shape, whose `input_tokens` EXCLUDES the buckets, so
 *     the total must be reconstructed (the sdkInvocationUsage convention differs)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  __setGenerateTextTransportForTests,
  chat,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  estimateChatCostUsd,
  setChatUsageSink,
  type ChatUsageRecord,
} from '../src/core/ai/chat-usage.ts';
import { sdkInvocationUsage } from '../src/core/ai/invocation-guard.ts';

interface RunResult {
  usage: ChatResult['usage'];
  record: ChatUsageRecord;
}

/** Run one chat() against a fake AI-SDK generateText result, capturing the ledger row. */
async function runChat(model: string, result: Record<string, unknown>): Promise<RunResult> {
  __setGenerateTextTransportForTests((async () => ({
    content: [{ type: 'text', text: 'ok' }],
    finishReason: 'stop',
    ...result,
  })) as never);
  const records: ChatUsageRecord[] = [];
  setChatUsageSink((r) => { records.push(r); });
  const res = await chat({ model, messages: [{ role: 'user', content: 'hi' }] });
  // The sink runs fire-and-forget; drain the microtask queue before asserting.
  await new Promise((r) => setTimeout(r, 10));
  expect(records.length).toBe(1);
  return { usage: res.usage, record: records[0]! };
}

const ANTHROPIC = 'anthropic:claude-haiku-4-5';
const OPENAI = 'openai:gpt-4o';

beforeEach(() => {
  configureGateway({ env: { ANTHROPIC_API_KEY: 'sk-ant-fake', OPENAI_API_KEY: 'sk-fake' } });
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  setChatUsageSink(null);
  resetGateway();
});

describe('gateway.chat() cache telemetry — AI SDK v6 nested details', () => {
  test('records nested cacheReadTokens and cacheWriteTokens, keeping input_tokens the total', async () => {
    const { usage, record } = await runChat(ANTHROPIC, {
      usage: {
        inputTokens: 35,
        outputTokens: 2,
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 },
      },
    });

    // 35 total = 10 uncached + 20 read + 5 written; buckets are subsets.
    expect(usage.input_tokens).toBe(35);
    expect(usage.output_tokens).toBe(2);
    expect(usage.cache_read_tokens).toBe(20);
    expect(usage.cache_creation_tokens).toBe(5);

    // The durable ledger gets the same read AND write counts (cache_write_tokens).
    expect(record.input_tokens).toBe(35);
    expect(record.cache_read_tokens).toBe(20);
    expect(record.cache_write_tokens).toBe(5);
    // Priced as 10 uncached input + 20 cache-read + 5 cache-write — the cache
    // tokens are not charged a second time at the input rate.
    expect(record.cost_usd).toBeCloseTo(
      estimateChatCostUsd(ANTHROPIC, { input_tokens: 10, output_tokens: 2, cache_read_tokens: 20, cache_write_tokens: 5 })!,
      12,
    );
  });

  test('a bare noCacheTokens detail without a total reconstructs the total from its parts', async () => {
    const { usage, record } = await runChat(ANTHROPIC, {
      usage: {
        outputTokens: 4,
        inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 3 },
      },
    });
    expect(usage.input_tokens).toBe(21);
    expect(record.input_tokens).toBe(21);
    expect(record.cache_read_tokens).toBe(11);
    expect(record.cache_write_tokens).toBe(3);
  });
});

describe('gateway.chat() cache telemetry — metadata and legacy fallbacks', () => {
  test('falls back to providerMetadata.anthropic when no nested details are present', async () => {
    const { usage, record } = await runChat(ANTHROPIC, {
      usage: { inputTokens: 100, outputTokens: 10 },
      providerMetadata: { anthropic: { cacheReadInputTokens: 60, cacheCreationInputTokens: 5 } },
    });
    expect(usage).toMatchObject({ input_tokens: 100, cache_read_tokens: 60, cache_creation_tokens: 5 });
    expect(record).toMatchObject({ input_tokens: 100, cache_read_tokens: 60, cache_write_tokens: 5 });
  });

  test('falls back to legacy flat usage.cachedInputTokens (AI SDK v5 / OpenAI-compatible shape)', async () => {
    const { usage, record } = await runChat(OPENAI, {
      usage: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 },
    });
    expect(usage).toMatchObject({ input_tokens: 100, cache_read_tokens: 60, cache_creation_tokens: 0 });
    expect(record).toMatchObject({ input_tokens: 100, cache_read_tokens: 60, cache_write_tokens: 0 });
    // cachedInputTokens is a subset of inputTokens, so pricing is 40 + 60 cache-read.
    expect(record.cost_usd).toBeCloseTo(
      estimateChatCostUsd(OPENAI, { input_tokens: 40, output_tokens: 10, cache_read_tokens: 60 })!,
      12,
    );
  });

  test('nested details win over legacy and metadata when both are present', async () => {
    const { record } = await runChat(ANTHROPIC, {
      usage: {
        inputTokens: 50,
        outputTokens: 1,
        inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
        cachedInputTokens: 999,
      },
      providerMetadata: { anthropic: { cacheReadInputTokens: 888, cacheCreationInputTokens: 777 } },
    });
    expect(record.cache_read_tokens).toBe(30);
    expect(record.cache_write_tokens).toBe(0);
    expect(record.input_tokens).toBe(50);
  });
});

describe('gateway.chat() cache telemetry — zero cache is not inferred from the model name', () => {
  // `anthropic` DECLARES supports_prompt_cache: true; `litellm` declares false.
  // Neither declaration may manufacture cache tokens: only observed counts count.
  for (const model of [ANTHROPIC, 'litellm:claude-sonnet-4-5']) {
    test(`${model}: no cache fields reported → 0 read / 0 write`, async () => {
      const { usage, record } = await runChat(model, {
        usage: { inputTokens: 100, outputTokens: 10, inputTokenDetails: { noCacheTokens: 100 } },
      });
      expect(usage.cache_read_tokens).toBe(0);
      expect(usage.cache_creation_tokens).toBe(0);
      expect(record.cache_read_tokens).toBe(0);
      expect(record.cache_write_tokens).toBe(0);
      expect(record.input_tokens).toBe(100);
      // Priced entirely as uncached input (a proxy model with no shipped price
      // stays NULL rather than a fabricated cache-inflated number).
      const expected = estimateChatCostUsd(model, { input_tokens: 100, output_tokens: 10 });
      if (expected === null) expect(record.cost_usd).toBeNull();
      else expect(record.cost_usd).toBeCloseTo(expected, 12);
    });
  }
});

describe('gateway.chat() cache telemetry — invalid numbers never poison the ledger', () => {
  test('NaN / Infinity / negative nested cache counts fall back to 0', async () => {
    const { usage, record } = await runChat(ANTHROPIC, {
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        inputTokenDetails: { cacheReadTokens: NaN, cacheWriteTokens: Infinity },
      },
    });
    expect(usage.cache_read_tokens).toBe(0);
    expect(usage.cache_creation_tokens).toBe(0);
    expect(record.cache_read_tokens).toBe(0);
    expect(record.cache_write_tokens).toBe(0);
    expect(Number.isFinite(record.input_tokens)).toBe(true);
    expect(record.input_tokens).toBe(100);
  });

  test('an invalid nested count falls through to the next valid source', async () => {
    const { record } = await runChat(ANTHROPIC, {
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        inputTokenDetails: { cacheReadTokens: -5, cacheWriteTokens: Number.NaN },
        cachedInputTokens: 40,
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 4 } },
    });
    expect(record.cache_read_tokens).toBe(40);
    expect(record.cache_write_tokens).toBe(4);
  });

  test('non-numeric and empty-string cache counts are ignored, never coerced to 0-over-a-real-value', async () => {
    const { record } = await runChat(ANTHROPIC, {
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 'not-a-number', cacheWriteTokens: '' },
        cachedInputTokens: 25,
      },
    });
    expect(record.cache_read_tokens).toBe(25);
    expect(record.cache_write_tokens).toBe(0);
  });
});

describe('gateway.chat() cache telemetry — raw Messages-API shape', () => {
  test('raw uncached input_tokens is converted to the gateway TOTAL convention', async () => {
    const rawUsage = {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
    };
    const { usage, record } = await runChat(ANTHROPIC, { usage: rawUsage });

    // Gateway contract: total = 10 uncached + 20 read + 5 written.
    expect(usage.input_tokens).toBe(35);
    expect(usage.output_tokens).toBe(2);
    expect(usage.cache_read_tokens).toBe(20);
    expect(usage.cache_creation_tokens).toBe(5);
    expect(record).toMatchObject({ input_tokens: 35, cache_read_tokens: 20, cache_write_tokens: 5 });
    expect(record.cost_usd).toBeCloseTo(
      estimateChatCostUsd(ANTHROPIC, { input_tokens: 10, output_tokens: 2, cache_read_tokens: 20, cache_write_tokens: 5 })!,
      12,
    );

    // The budget-guard helper keeps the OPPOSITE (uncached-input) convention —
    // proof the two lanes must not share one normalizer.
    expect(sdkInvocationUsage({ usage: rawUsage })!.inputTokens).toBe(10);
  });
});
