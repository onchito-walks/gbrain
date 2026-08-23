/**
 * Bounded retry for FULLY UNRECOVERABLE malformed extractor output.
 *
 * A turn whose extractor response parses to NO recoverable facts (unparseable
 * JSON / wrong shape, or every candidate schema-invalid) can be transient model
 * formatting variance. At the segment call boundary we retry that case exactly
 * once (2 total chat attempts) so a transient bad format doesn't become an
 * avoidable page-level failure.
 *
 * Deliberately narrow: only the `malformed_output` outcome retries. Provider
 * errors and aborts are NOT retried; the partial-valid case (some candidates
 * recoverable) already succeeds via the 84d3b645 salvage and is NOT retried.
 * A response STILL malformed after the final attempt returns `malformed_output`
 * — a visible, retryable page failure.
 *
 * Hermetic via the gateway chat-transport test seam — no API key, no network.
 */
import { afterAll, describe, test, expect, beforeEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import {
  extractFactsFromTurnWithOutcome,
  MAX_MALFORMED_EXTRACT_ATTEMPTS,
} from '../src/core/facts/extract.ts';

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
});

// Shard hygiene: restore the legacy 1536-d embedding pin so later fresh-schema
// files in this shard don't inherit a dimensionless gateway.
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env },
  });
});

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6',
    providerId: 'anthropic',
  } as ChatResult;
}

const GOOD_JSON =
  '{"facts":[{"fact":"user gave up alcohol","kind":"commitment","entity":null,' +
  '"confidence":1.0,"notability":"high","metric":null,"value":null,"unit":null,' +
  '"period":null}]}';

const VALID_FACT_TEXT = 'gave up alcohol';

// Unparseable in every sense: no JSON at all.
const GARBAGE = 'Sure! Here is what I understood: the user mentioned several things...';

// Every candidate is schema-invalid (`fact` is a number) → parsedShape.facts is
// empty with invalidCandidates>0 → the OTHER malformed branch.
const ALL_INVALID_JSON =
  '{"facts":[{"fact":123,"kind":"fact"},{"fact":null,"kind":42}]}';

// Mixed valid+invalid → partial-valid (recoverable) output; must NOT retry.
const PARTIAL_VALID_JSON =
  '{"facts":[{"fact":"recoverable commitment","kind":"commitment","notability":"high"},' +
  '{"fact":123,"kind":"fact"}]}';

describe('extractFactsFromTurnWithOutcome malformed-output bounded retry', () => {
  test('malformed then valid succeeds after exactly one retry', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(seen.length === 1 ? GARBAGE : GOOD_JSON, 'end');
    });
    const out = await extractFactsFromTurnWithOutcome({
      turnText: 'I gave up alcohol.',
      source: 'test:malformed-retry',
    });
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(2); // initial + one retry
    if (out.ok) expect(out.facts[0]!.fact).toContain(VALID_FACT_TEXT);
  });

  test('every-candidate-invalid (malformed) then valid succeeds after exactly one retry', async () => {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      return chatResult(seen.length === 1 ? ALL_INVALID_JSON : GOOD_JSON, 'end');
    });
    const out = await extractFactsFromTurnWithOutcome({
      turnText: 'I gave up alcohol.',
      source: 'test:malformed-retry',
    });
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(2); // initial + one retry
  });

  test('permanently malformed still fails after exactly bounded attempts', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return chatResult(GARBAGE, 'end');
    });
    const out = await extractFactsFromTurnWithOutcome({
      turnText: 'I gave up alcohol.',
      source: 'test:malformed-retry',
    });
    expect(calls).toBe(MAX_MALFORMED_EXTRACT_ATTEMPTS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('malformed_output');
  });

  test('permanently every-candidate-invalid still fails after exactly bounded attempts', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return chatResult(ALL_INVALID_JSON, 'end');
    });
    const out = await extractFactsFromTurnWithOutcome({
      turnText: 'I gave up alcohol.',
      source: 'test:malformed-retry',
    });
    expect(calls).toBe(MAX_MALFORMED_EXTRACT_ATTEMPTS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('malformed_output');
  });

  test('does NOT retry a provider error', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      throw new Error('upstream 500');
    });
    const out = await extractFactsFromTurnWithOutcome({
      turnText: 'I gave up alcohol.',
      source: 'test:malformed-retry',
    });
    expect(calls).toBe(1); // no retry
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('provider_error');
  });

  test('does NOT retry an abort; the abort is re-thrown', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      const e = new Error('AbortError');
      e.name = 'AbortError';
      throw e;
    });
    await expect(
      extractFactsFromTurnWithOutcome({
        turnText: 'I gave up alcohol.',
        source: 'test:malformed-retry',
      }),
    ).rejects.toThrow('AbortError');
    expect(calls).toBe(1); // no retry
  });

  test('does NOT retry valid output (single attempt)', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return chatResult(GOOD_JSON, 'end');
    });
    const out = await extractFactsFromTurnWithOutcome({
      turnText: 'I gave up alcohol.',
      source: 'test:malformed-retry',
    });
    expect(calls).toBe(1);
    expect(out.ok).toBe(true);
  });

  test('does NOT retry partial-valid output (84d3b645 salvage, single attempt)', async () => {
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return chatResult(PARTIAL_VALID_JSON, 'end');
    });
    const out = await extractFactsFromTurnWithOutcome({
      turnText: 'I made a recoverable commitment.',
      source: 'test:malformed-retry',
    });
    expect(calls).toBe(1); // NOT retried — recoverable facts salvaged immediately
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.facts).toHaveLength(1);
      expect(out.facts[0]!.fact).toBe('recoverable commitment');
    }
  });
});