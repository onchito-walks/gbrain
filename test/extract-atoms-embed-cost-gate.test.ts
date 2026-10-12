/**
 * Regression: extract_atoms gated its cost cap on the CHAT model alone, but
 * the atom write site (importFromContent) also embeds inside the same
 * withBudgetTracker scope. A $0 local chat model (ollama / llama-server) kept
 * the cap on, and an unpriced embedding route — `litellm:*`, deliberately not
 * assumed free because a proxy can front a paid provider — made
 * BudgetTracker.reserve() throw BudgetExhausted(no_pricing) on the FIRST atom
 * import. `budgetExhausted` latched, every remaining item was skipped, and the
 * phase reported 0 atoms / `budget_exhausted: true` / $0 spent on every run.
 *
 * The phase also never loaded `pricing.overrides` (#4312), so the operator
 * fix its own error message advertised did nothing here.
 *
 * B11: an unpriced billable route now REFUSES the run (zero model calls) under
 * the DEFAULT cap too, with the native `no_pricing` receipt — it no longer
 * drops the cap and runs uncapped, and it never reports the route as priced
 * $0. `explicitBudget` only labels which cap was unenforceable.
 *
 * Pure-helper cases first; the PGLite describes exercise the real phase. No
 * model calls anywhere — chat is stubbed via the `_chat` seam and the embed
 * transport via __setEmbedTransportForTests.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import {
  resolveExtractAtomsCostGate,
  readExtractAtomsNoPricing,
  ATOMS_NO_PRICING_KEY_PREFIX,
} from '../src/core/cycle/extract-atoms-cost-gate.ts';
import { parsePricingOverrides } from '../src/core/budget/budget-tracker.ts';
import {
  configureGateway,
  resetGateway,
  isAvailable,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

const FREE_CHAT = 'llama-server:local-27b';
const UNPRICED_CHAT = 'groq:llama-3.3-70b';
const PRICED_EMBED = 'openai:text-embedding-3-large';
const UNPRICED_EMBED = 'litellm:nvidia/some-local-embedder';

describe('resolveExtractAtomsCostGate', () => {
  test('priced chat + priced embed → cap enforced', () => {
    expect(resolveExtractAtomsCostGate('claude-haiku-4-5-20251001', PRICED_EMBED))
      .toEqual({ enforceCap: true });
  });

  test('free local chat + no embedding configured → cap enforced (nothing unpriced bills)', () => {
    expect(resolveExtractAtomsCostGate(FREE_CHAT, null)).toEqual({ enforceCap: true });
  });

  test('free local chat + free local embed → cap enforced at $0', () => {
    expect(resolveExtractAtomsCostGate(FREE_CHAT, 'ollama:nomic-embed-text')).toEqual({ enforceCap: true });
  });

  // B11: the default cap used to be DROPPED for an unpriced route (warn and
  // run uncapped). It now refuses, so the run never reports a spent total that
  // silently excludes an unpriced call.
  test('unpriced chat model under the DEFAULT cap → refusal, naming the chat model and the default cap', () => {
    const gate = resolveExtractAtomsCostGate(UNPRICED_CHAT, PRICED_EMBED);
    expect(gate).toMatchObject({
      enforceCap: true,
      unpricedModel: UNPRICED_CHAT,
      unpricedKind: 'chat',
      unpricedCapSource: 'default',
    });
    expect(gate.refusal).toMatchObject({ code: 'no_pricing', model: UNPRICED_CHAT, kind: 'chat' });
    expect(gate.refusal!.register_command).toStartWith(`gbrain pricing set ${UNPRICED_CHAT} --input`);
  });

  // The defect: a $0 chat model kept the cap on while an unpriced EMBED route
  // billed at $0 inside the same tracker. Same refusal, no override invented.
  test('free local chat + UNPRICED embed under the DEFAULT cap → refusal, naming the embed model', () => {
    const gate = resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED);
    expect(gate).toMatchObject({
      enforceCap: true,
      unpricedModel: UNPRICED_EMBED,
      unpricedKind: 'embed',
      unpricedCapSource: 'default',
    });
    expect(gate.refusal).toMatchObject({ code: 'no_pricing', model: UNPRICED_EMBED, kind: 'embed' });
    // Tightening (carried from the old $0-pretend case): the gate never merges
    // a synthetic $0 row into the operator's overrides to "keep" the cap.
    expect('pricingOverrides' in gate).toBe(false);
  });

  test('an explicit operator budget refuses the same way, labelled as the operator cap', () => {
    const gate = resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, undefined, { explicitBudget: true });
    expect(gate).toMatchObject({ enforceCap: true, unpricedModel: UNPRICED_EMBED, unpricedKind: 'embed', unpricedCapSource: 'operator' });
    expect(gate.refusal).toMatchObject({ code: 'no_pricing', model: UNPRICED_EMBED, kind: 'embed', units: ['usd_per_1m_tokens'] });
    expect(gate.refusal!.register_command).toStartWith(`gbrain pricing set ${UNPRICED_EMBED} --rate`);
  });

  test('an explicit budget never invents a $0 embed row; other overrides are left as they were', () => {
    const overrides = parsePricingOverrides(JSON.stringify({ 'litellm:gpt-4o': { input: 2.5, output: 10 } }))!;
    const gate = resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, overrides, { explicitBudget: true });
    expect(gate.refusal?.model).toBe(UNPRICED_EMBED);
    expect('pricingOverrides' in gate).toBe(false);
    expect(overrides).toEqual({ 'litellm:gpt-4o': { input: 2.5, output: 10 } });
  });

  test('an explicit budget refuses an unpriced CHAT model instead of dropping the cap', () => {
    const gate = resolveExtractAtomsCostGate(UNPRICED_CHAT, UNPRICED_EMBED, undefined, { explicitBudget: true });
    expect(gate).toMatchObject({ enforceCap: true, unpricedModel: UNPRICED_CHAT, unpricedKind: 'chat', unpricedCapSource: 'operator' });
    expect(gate.refusal).toMatchObject({ code: 'no_pricing', model: UNPRICED_CHAT, provider: 'groq', kind: 'chat' });
  });

  test('an operator pricing override for the unpriced route restores the cap', () => {
    const overrides = parsePricingOverrides(JSON.stringify({ [UNPRICED_EMBED]: 0 }));
    expect(overrides).toBeDefined();
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, overrides)).toEqual({ enforceCap: true });
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, overrides, { explicitBudget: true })).toEqual({ enforceCap: true });
  });

  // The Life Chronicle phase shares this gate but accounts for unknown spend
  // itself (`unpriced_calls`, rows marked `unpriced: true`), so it opts out of
  // the refusal for a DEFAULT cap. An operator cap still refuses for it.
  test("unpricedPolicy 'uncapped' keeps the drop-the-cap shape (chronicle's opt-out)", () => {
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, undefined, { unpricedPolicy: 'uncapped' })).toEqual({
      enforceCap: false,
      unpricedModel: UNPRICED_EMBED,
      unpricedKind: 'embed',
    });
    const explicit = resolveExtractAtomsCostGate(UNPRICED_CHAT, PRICED_EMBED, undefined, { explicitBudget: true, unpricedPolicy: 'uncapped' });
    expect(explicit).toMatchObject({ enforceCap: true, unpricedCapSource: 'operator' });
    expect(explicit.refusal).toBeDefined();
  });

  test('override lookup is case-insensitive, matching BudgetTracker.reserve()', () => {
    const overrides = parsePricingOverrides(JSON.stringify({ [UNPRICED_EMBED.toUpperCase()]: 0 }));
    expect(resolveExtractAtomsCostGate(FREE_CHAT, UNPRICED_EMBED, overrides)).toEqual({ enforceCap: true });
  });
});

describe('extract_atoms with a $0 chat model and an unpriced embedding model (PGLite round-trip)', () => {
  let engine: PGLiteEngine;
  const DIMS = 1536; // matches the preload's schema width

  beforeAll(async () => {
    // Hermetic: keyless env, an embedding model with NO pricing entry, and a
    // stubbed embed transport so isAvailable('embedding') is true and the atom
    // import really embeds — under the phase's BudgetTracker — without a network.
    configureGateway({
      embedding_model: UNPRICED_EMBED,
      embedding_dimensions: DIMS,
      env: {},
    });
    // Same shape as the ai-sdk embedMany result the gateway consumes (see
    // test/asymmetric-encoding-contract.test.ts).
    __setEmbedTransportForTests((async (args: any) => ({
      embeddings: (args.values as string[]).map(() => Array.from({ length: DIMS }, () => 0.01)),
      usage: { tokens: 10 * (args.values as string[]).length },
    })) as any);
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('models.dream.extract_atoms', FREE_CHAT);
  });
  afterAll(async () => {
    await engine.disconnect();
    __setEmbedTransportForTests(null);
    resetGateway();
  });
  afterEach(async () => {
    await engine.unsetConfig('pricing.overrides');
    await engine.unsetConfig('cycle.extract_atoms.budget_usd');
    await engine.unsetConfig(`${ATOMS_NO_PRICING_KEY_PREFIX}default`);
  });

  const chat = async (_o: ChatOpts): Promise<ChatResult> => ({
    text: `[{"title":"Embedded atom","atom_type":"insight","body":"Local inference costs electricity, not tokens."}]`,
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: FREE_CHAT,
    providerId: 'llama-server',
  });

  /**
   * Run the phase with a call counter on BOTH transports. The refusal contract
   * is "zero model calls", so every refusal case asserts the counters, not just
   * the returned status.
   */
  async function runCounting(opts: {
    transcript: { filePath: string; content: string; contentHash: string };
  }): Promise<{ result: Awaited<ReturnType<typeof runPhaseExtractAtoms>>; chatCalls: number; embedCalls: number; stderr: string }> {
    let chatCalls = 0;
    let embedCalls = 0;
    __setEmbedTransportForTests((async (args: any) => {
      embedCalls++;
      return {
        embeddings: (args.values as string[]).map(() => Array.from({ length: DIMS }, () => 0.01)),
        usage: { tokens: 10 * (args.values as string[]).length },
      };
    }) as any);
    const stderr: string[] = [];
    const saved = console.error;
    console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
    try {
      const result = await runPhaseExtractAtoms(engine, {
        _transcripts: [opts.transcript],
        _pages: [],
        _chat: async (o) => { chatCalls++; return chat(o); },
      });
      return { result, chatCalls, embedCalls, stderr: stderr.join('\n') };
    } finally {
      console.error = saved;
      __setEmbedTransportForTests(null);
    }
  }

  // B11: used to run uncapped with the embed route billed at $0 (the spent
  // total then excluded every embed call). Now the run is REFUSED, makes no
  // model call, and records the native no_pricing receipt for doctor.
  test('DEFAULT cap + unpriced embed → refused: 0 chat, 0 embed, no_pricing receipt recorded', async () => {
    expect(isAvailable('embedding')).toBe(true);
    const { result, chatCalls, embedCalls, stderr } = await runCounting({
      transcript: { filePath: '/fake/meeting-a.txt', content: 'transcript content a', contentHash: 'a1b2c3d4e5f60718' },
    });

    expect(result.status).toBe('warn');
    expect(result.details?.reason).toBe('no_pricing');
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.budget_exhausted).toBe(true);
    expect(result.details?.cap_source).toBe('default');
    expect(result.details?.no_pricing).toMatchObject({ model: UNPRICED_EMBED, kind: 'embed' });
    // THE GUARANTEE: an unpriced route spends nothing, because nothing runs.
    expect(chatCalls).toBe(0);
    expect(embedCalls).toBe(0);
    // The cap was NOT dropped and the run did NOT proceed uncapped.
    expect(stderr).not.toContain('running without a cost gate');
    expect(stderr).toContain(`gbrain pricing set ${UNPRICED_EMBED} --rate`);

    // Truthful accounting: the receipt names the UNKNOWN pricing (and which cap
    // it blocked), never a $0 rate; doctor reads the same record.
    const raw = await engine.getConfig(`${ATOMS_NO_PRICING_KEY_PREFIX}default`);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toMatchObject({ code: 'no_pricing', model: UNPRICED_EMBED, kind: 'embed', cap_source: 'default' });
    expect(JSON.stringify(parsed)).not.toContain('"rate":0');
    const refusals = await readExtractAtomsNoPricing(engine);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ source_id: 'default', model: UNPRICED_EMBED, kind: 'embed' });
  }, 60000);

  test('an EXPLICIT cycle.extract_atoms.budget_usd refuses identically, labelled as the operator cap', async () => {
    await engine.setConfig('cycle.extract_atoms.budget_usd', '0.05');
    const { result, chatCalls, embedCalls } = await runCounting({
      transcript: { filePath: '/fake/meeting-c.txt', content: 'transcript content c', contentHash: 'c1b2c3d4e5f60718' },
    });
    expect(result.status).toBe('warn');
    expect(result.details?.reason).toBe('no_pricing');
    expect(result.details?.budget_usd).toBe(0.05);
    expect(result.details?.cap_source).toBe('operator');
    expect(chatCalls).toBe(0);
    expect(embedCalls).toBe(0);
    expect(JSON.parse((await engine.getConfig(`${ATOMS_NO_PRICING_KEY_PREFIX}default`))!).cap_source).toBe('operator');
  }, 60000);

  // The operator escape hatch the refusal advertises: declare the rate and the
  // run proceeds with the cap enforced — which also clears the recorded refusal.
  test('a $0 pricing override for the embed model restores the cap, extracts, and clears the receipt', async () => {
    await engine.setConfig('pricing.overrides', JSON.stringify({ [UNPRICED_EMBED]: 0 }));
    const { result, chatCalls, embedCalls } = await runCounting({
      transcript: { filePath: '/fake/meeting-b.txt', content: 'transcript content b', contentHash: 'b1b2c3d4e5f60718' },
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.budget_exhausted).toBe(false);
    expect(chatCalls).toBe(1);
    expect(embedCalls).toBeGreaterThan(0);
    expect(await engine.getConfig(`${ATOMS_NO_PRICING_KEY_PREFIX}default`)).toBeNull();
    expect(await readExtractAtomsNoPricing(engine)).toHaveLength(0);
  }, 60000);
});
