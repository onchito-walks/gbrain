/**
 * B13 — drain truthfulness for a batch that REFUSES to run.
 *
 * Before B13 a refused batch (the B11 unpriced cost gate, or the B12
 * fail-closed quarantine re-check) returned `atoms_extracted: 0`,
 * `failures: []` and no budget skips, so the drain fell into the ordinary
 * zero-progress path: it recounted an unchanged backlog and reported
 * `status: 'ok'` / `stopped: 'no_progress'`, or even `drained` on a zero
 * recount. That is the false-green B13 exists to prevent: a durable job
 * completed, a CLI exited 0, and the backlog was never touched.
 *
 * The behavior pinned here:
 *   1. a blocked batch latches `status: 'blocked'` + `stopped: 'blocked'` +
 *      `blocked_reason`, stops after that ONE batch (no in-run hot retry), and
 *      survives a zero final recount — it never reads as `ok`/`no_progress`/
 *      `drained`;
 *   2. the native expected-budget stop (`pages_skipped_budget > 0`) is
 *      untouched: `status: 'ok'`, `stopped: 'budget'`, spend reported;
 *   3. the pure classifier maps the two refusal shapes and deliberately does
 *      NOT key off `budget_exhausted` (which the native `no_pricing` receipt
 *      sets true — keying off it is exactly the refusal-vs-outage conflation);
 *   4. the refusal text is its own message, never the provider-outage text;
 *   5. the REAL control path (eligible page + unpriced route + the real
 *      per-source cycle lock + the real Minion handler) refuses with zero model
 *      calls and throws a retryable Error before the deadline,
 *      `UnrecoverableError` past it, leaving the source lock free.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  deriveExtractAtomsBatchOutcome,
  formatDrainBlockedRefusal,
  runExtractAtomsDrain,
  runExtractAtomsDrainForSource,
  type ExtractAtomsDrainDeps,
  type ExtractAtomsDrainResult,
} from '../src/core/cycle/extract-atoms-drain.ts';
import { makeExtractAtomsDrainHandler } from '../src/core/minions/handlers/extract-atoms-drain.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { UnrecoverableError } from '../src/core/minions/errors.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const passThroughLock: ExtractAtomsDrainDeps['withLock'] = (work) => work(new AbortController().signal);

describe('B13 — runExtractAtomsDrain surfaces a refused batch (pure)', () => {
  it('latches status=blocked (not ok/no_progress) and stops after one batch', async () => {
    let batches = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 5, // never drains: the refusal is not progress
        runBatch: async () => {
          batches++;
          return { extracted: 0, skipped: 0, blocked: true, blockedReason: 'no_pricing' };
        },
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('blocked');
    expect(result.stopped).toBe('blocked');
    expect(result.blocked_reason).toBe('no_pricing');
    // The hot-loop guard: one refused batch, not a spin over an unchanged backlog.
    expect(batches).toBe(1);
    expect(result.batches).toBe(1);
    expect(result.remaining).toBe(5);
    // A refusal is not an outage and not a per-item failure.
    expect(result.failure_count).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('keeps the refusal even when the final recount is 0 (never reported as drained)', async () => {
    const counts = [3, 0];
    let i = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => counts[Math.min(i++, counts.length - 1)]!,
        runBatch: async () => ({ extracted: 0, skipped: 0, blocked: true, blockedReason: 'quarantine_recheck_failed' }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('blocked');
    expect(result.stopped).toBe('blocked');
    expect(result.blocked_reason).toBe('quarantine_recheck_failed');
    expect(result.remaining).toBe(0);
  });

  it('names the refusal "blocked" when the adapter supplied no reason', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 2,
        runBatch: async () => ({ extracted: 0, skipped: 0, blocked: true }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('blocked');
    expect(result.blocked_reason).toBe('blocked');
  });

  it('prefers the refusal arm when a batch reports blocked and providerFailure together', async () => {
    // Defensive ordering: the refusal never reached a provider, so the outage
    // text must not win. (In production the two are mutually exclusive.)
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 4,
        runBatch: async () => ({ extracted: 0, skipped: 0, blocked: true, blockedReason: 'no_pricing', providerFailure: true }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('blocked');
    expect(result.stopped).toBe('blocked');
    expect(result.blocked_reason).toBe('no_pricing');
  });

  it('leaves the native expected-budget stop alone (status ok, stopped budget)', async () => {
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => 7,
        runBatch: async () => ({ extracted: 0, skipped: 0, budgetSkipped: 2, budget: { spentUsd: 0.5, capUsd: 0.5 } }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.status).toBe('ok');
    expect(result.stopped).toBe('budget');
    expect(result.spent_usd).toBe(0.5);
    expect(result.budget_usd).toBe(0.5);
    expect(result.blocked_reason).toBeUndefined();
  });
});

describe('B13 — deriveExtractAtomsBatchOutcome (pure classifier)', () => {
  it('maps the fail-closed quarantine re-check refusal and keeps its reason', () => {
    expect(deriveExtractAtomsBatchOutcome({ blocked: true, blocked_reason: 'quarantine_recheck_failed' }))
      .toEqual({ blocked: true, blockedReason: 'quarantine_recheck_failed' });
  });

  it('maps the unpriced cost-gate refusal by its native reason, even with budget_exhausted set', () => {
    // The native no_pricing receipt sets budget_exhausted: true by design.
    expect(deriveExtractAtomsBatchOutcome({ reason: 'no_pricing', budget_exhausted: true, cap_source: 'default' }))
      .toEqual({ blocked: true, blockedReason: 'no_pricing' });
  });

  it('reports blocked with no reason when the shape carries none', () => {
    expect(deriveExtractAtomsBatchOutcome({ blocked: true })).toEqual({ blocked: true });
  });

  it('does NOT treat a budget flag or an ordinary reason as a refusal', () => {
    // The conflation B13 forbids: a spent cap and a skipped-budget batch are
    // normal, expected stops, not refusals, and an outage is not one either.
    expect(deriveExtractAtomsBatchOutcome({ budget_exhausted: true, pages_skipped_budget: 3, reason: 'budget' }))
      .toEqual({ blocked: false });
    expect(deriveExtractAtomsBatchOutcome({ budget_exhausted: true })).toEqual({ blocked: false });
    expect(deriveExtractAtomsBatchOutcome({ reason: 'no_work' })).toEqual({ blocked: false });
    expect(deriveExtractAtomsBatchOutcome({ blocked: 'yes' })).toEqual({ blocked: false });
    expect(deriveExtractAtomsBatchOutcome(undefined)).toEqual({ blocked: false });
  });
});

describe('B13 — formatDrainBlockedRefusal (refusal text is its own message)', () => {
  const base = { batches: 1, remaining: 151, blocked_reason: 'no_pricing' } as Pick<
    ExtractAtomsDrainResult,
    'batches' | 'remaining' | 'blocked_reason'
  >;

  it('names the refusal, not the provider outage', () => {
    const msg = formatDrainBlockedRefusal(base)!;
    expect(msg).toContain('refused this batch before any model call');
    expect(msg).toContain('reason=no_pricing');
    expect(msg).toContain('batches=1');
    expect(msg).toContain('remaining=151');
    expect(msg).toContain('retrying');
    expect(msg).not.toContain('provider calls failed');
    expect(formatDrainBlockedRefusal(base, { final: true })).not.toContain('retrying');
  });

  it('returns null for a run that was not blocked', () => {
    expect(formatDrainBlockedRefusal({ batches: 1, remaining: 0 })).toBeNull();
  });
});

describe('B13 — the real control path: an unpriced route refuses the batch', () => {
  const UNPRICED_CHAT = 'litellm:custom-chat';
  const PRICED_EMBED = 'openai:text-embedding-3-large';
  const DIMS = 1536;

  let engine: PGLiteEngine;
  let chatCalls = 0;

  const seedEligiblePage = (slug: string) => engine.putPage(slug, {
    type: 'note', title: slug, compiled_truth: 'A durable decision recorded in prose. '.repeat(20),
  } as never, { sourceId: 'default' });

  const drainJob = (deadlineAtMs: number | null) => ({
    id: 1, name: 'extract-atoms-drain', attempts_made: 0,
    data: { sourceId: 'default', window: 5 },
    signal: new AbortController().signal, deadlineAtMs,
    shutdownSignal: new AbortController().signal,
  }) as unknown as MinionJobContext;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });

  afterEach(async () => {
    chatCalls = 0;
    await engine.unsetConfig('models.dream.extract_atoms');
    await engine.unsetConfig('pricing.overrides');
    for (const key of await engine.listConfigKeys('cycle.extract_atoms.no_pricing.')) await engine.unsetConfig(key);
    await engine.executeRaw(`DELETE FROM pages`);
  });

  async function refuseSetup(): Promise<void> {
    resetGateway();
    configureGateway({ embedding_model: PRICED_EMBED, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async (args: { values: string[] }) => ({
      embeddings: args.values.map(() => Array.from({ length: DIMS }, () => 0.01)),
      usage: { tokens: 10 * args.values.length },
    })) as never);
    // A chat transport that fails loudly: the gate must refuse BEFORE any call.
    __setChatTransportForTests((async () => { chatCalls++; throw new Error('chat must not be called on a refused batch'); }) as never);
    await engine.setConfig('models.dream.extract_atoms', UNPRICED_CHAT);
    await seedEligiblePage('notes/refusal-probe');
  }

  it('reports status=blocked with reason no_pricing short of the deadline and makes zero model calls', async () => {
    await refuseSetup();

    const before = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);

    const result = await runExtractAtomsDrainForSource(engine, {
      sourceId: 'default', windowSeconds: 5, maxBatches: 1,
    });
    expect(result.status).toBe('blocked');
    expect(result.stopped).toBe('blocked');
    expect(result.blocked_reason).toBe('no_pricing');
    expect(result.batches).toBe(1);
    expect(result.extracted).toBe(0);
    expect(chatCalls).toBe(0);
    // The backlog is unchanged — the refusal was not progress and not a drain.
    expect(result.remaining).toBeGreaterThan(0);
    const after = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));

    // The Minion handler turns it into a RETRYABLE failure with the refusal
    // text (not the provider-outage text), and releases the source's lock.
    const err = await makeExtractAtomsDrainHandler(engine)(drainJob(Date.now() + 60_000)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('refused this batch before any model call');
    expect((err as Error).message).toContain('reason=no_pricing');
    expect((err as Error).message).not.toContain('provider calls failed');
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle:default'`)).toEqual([]);
  }, 90_000);

  it('dead-letters (UnrecoverableError) past the job deadline instead of retrying forever', async () => {
    await refuseSetup();

    const err = await makeExtractAtomsDrainHandler(engine)(drainJob(Date.now() - 1)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain('reason=no_pricing');
    expect((err as Error).message).not.toContain('retrying');
    expect(chatCalls).toBe(0);
    expect(await engine.executeRaw(`SELECT id FROM gbrain_cycle_locks WHERE id = 'gbrain-cycle:default'`)).toEqual([]);
  }, 90_000);
});
