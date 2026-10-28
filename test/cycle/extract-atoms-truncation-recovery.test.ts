/**
 * Bounded truncation recovery for extract_atoms.
 *
 * The invariant under test is that a clipped response never publishes
 * anything: recovery is ONE escalated retry, it is bounded by a hard output
 * ceiling and by the run's remaining budget, and when it does not produce a
 * clean response the item keeps its counted failure (visible reason, page
 * still retryable) with zero atoms written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  MAX_DETERMINISTIC_FAILURES,
} from '../../src/core/cycle/extract-atoms.ts';
import {
  TRUNCATION_RETRY_MAX_TOKENS,
  extractAtomsWithTruncationRetry,
  planTruncationRetry,
} from '../../src/core/cycle/extract-atoms-truncation.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from '../helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

const ATOMS_AT_4096 = JSON.stringify([{ title: 'Prefix atom from the clipped call', atom_type: 'insight', body: 'Must never be published.' }]);
const ATOMS_AT_8192 = JSON.stringify([{ title: 'Complete atom from the escalated call', atom_type: 'insight', body: 'The whole extraction, parsed from a clean end.' }]);

function reply(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  } as ChatResult;
}

describe('planTruncationRetry', () => {
  test('doubles the configured cap and stops at the hard ceiling', () => {
    expect(planTruncationRetry({ maxTokens: 4096, hasBudgetHeadroom: true })).toMatchObject({ retry: true, maxTokens: 8192 });
    expect(planTruncationRetry({ maxTokens: 3000, hasBudgetHeadroom: true })).toMatchObject({ retry: true, maxTokens: 6000 });
    // At or past the ceiling the answer is "no retry": re-asking at the same
    // cap would clip again and bill for it.
    for (const maxTokens of [TRUNCATION_RETRY_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS * 2]) {
      const plan = planTruncationRetry({ maxTokens, hasBudgetHeadroom: true });
      expect(plan.retry).toBe(false);
      expect(plan.maxTokens).toBe(maxTokens);
      expect(plan.reason).toContain('ceiling');
    }
  });

  test('never buys a retry without budget headroom', () => {
    const plan = planTruncationRetry({ maxTokens: 4096, hasBudgetHeadroom: false });
    expect(plan.retry).toBe(false);
    expect(plan.reason).toContain('budget headroom');
  });
});

describe('extractAtomsWithTruncationRetry', () => {
  test('a clipped response is discarded; only the escalated response is parsed', async () => {
    const caps: number[] = [];
    const result = await extractAtomsWithTruncationRetry({
      maxTokens: 4096,
      hasBudgetHeadroom: true,
      call: async (maxTokens) => {
        caps.push(maxTokens);
        return maxTokens === 4096
          ? { text: ATOMS_AT_4096, stopReason: 'length' }
          : { text: ATOMS_AT_8192, stopReason: 'end' };
      },
    });
    expect(caps).toEqual([4096, 8192]);
    expect(result.retried).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.maxTokens).toBe(8192);
    expect(result.outcome.ok).toBe(true);
    expect(result.outcome.ok && result.outcome.atoms.map((atom) => atom.title))
      .toEqual(['Complete atom from the escalated call']);
  });

  test('a retry that clips again yields NO atoms and a failure naming the escalation', async () => {
    let calls = 0;
    const result = await extractAtomsWithTruncationRetry({
      maxTokens: 4096,
      hasBudgetHeadroom: true,
      call: async () => { calls++; return { text: ATOMS_AT_4096, stopReason: 'length' }; },
    });
    expect(calls).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.ok === false && result.outcome.stopped).toBe(true);
    const reason = result.outcome.ok === false ? result.outcome.reason : '';
    expect(reason).toContain('stopReason=length');
    expect(reason).toContain(`maxTokens=${TRUNCATION_RETRY_MAX_TOKENS}`);
    expect(reason).toContain('cycle.extract_atoms.max_output_tokens');
  });

  test('non-truncation stops are not retried', async () => {
    for (const stop of ['refusal', 'content_filter', 'other'] as const) {
      const caps: number[] = [];
      const result = await extractAtomsWithTruncationRetry({
        maxTokens: 4096,
        hasBudgetHeadroom: true,
        call: async (maxTokens) => { caps.push(maxTokens); return { text: '[]', stopReason: stop }; },
      });
      expect(caps).toEqual([4096]);
      expect(result.retried).toBe(false);
      expect(result.outcome.ok).toBe(false);
    }
  });

  test('no budget headroom leaves the truncation as the item failure, with no second call', async () => {
    let calls = 0;
    const result = await extractAtomsWithTruncationRetry({
      maxTokens: 4096,
      hasBudgetHeadroom: () => false,
      call: async () => { calls++; return { text: ATOMS_AT_4096, stopReason: 'length' }; },
    });
    expect(calls).toBe(1);
    expect(result.retried).toBe(false);
    expect(result.recovered).toBe(false);
    const reason = result.outcome.ok === false ? result.outcome.reason : '';
    expect(reason).toContain('stopReason=length');
    expect(reason).toContain('no truncation retry');
    expect(reason).toContain('budget headroom');
  });

  test('a malformed retry is a failure, never a zero-yield success', async () => {
    const result = await extractAtomsWithTruncationRetry({
      maxTokens: 4096,
      hasBudgetHeadroom: true,
      call: async (maxTokens) => maxTokens === 4096
        ? { text: ATOMS_AT_4096, stopReason: 'length' }
        : { text: 'the model rambled instead of answering', stopReason: 'end' },
    });
    expect(result.retried).toBe(true);
    expect(result.outcome.ok).toBe(false);
    expect(result.recovered).toBe(false);
  });
});

const HASH = 'e'.repeat(16);
let engine: PGLiteEngine;

async function seed(slug: string): Promise<void> {
  await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: 'seed body prose' } as never, { sourceId: 'default' });
}

async function atomSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY slug`);
  return rows.map((row) => row.slug);
}

async function state(slug: string) {
  const [row] = await engine.executeRaw<{ fail_count: number; tombstoned: boolean }>(
    `SELECT scan.fail_count, scan.tombstoned FROM extract_atoms_page_state scan JOIN pages p ON p.id=scan.page_id
      WHERE p.source_id='default' AND p.slug=$1 AND scan.content_hash=p.content_hash`, [slug]);
  return row;
}

function run(slug: string, chat: (o: ChatOpts) => Promise<ChatResult>) {
  return runPhaseExtractAtoms(engine, {
    sourceId: 'default', _transcripts: [],
    _pages: [{ slug, content: 'seed body prose', contentHash: HASH }],
    _chat: chat,
  });
}

// ── phase integration (PGLite, no provider) ───────────────────────────────
describe('extract_atoms truncation recovery (phase)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  test('the clipped prefix is never published; the escalated retry is', async () => {
    await seed('note/recovered');
    const caps: number[] = [];
    const result = await run('note/recovered', async (opts) => {
      const cap = opts.maxTokens ?? 0;
      caps.push(cap);
      return cap === 4096 ? reply(ATOMS_AT_4096, 'length') : reply(ATOMS_AT_8192, 'end');
    });
    expect(caps).toEqual([4096, 8192]);
    expect(result.details.truncation_retries).toBe(1);
    expect(result.details.truncation_recovered).toBe(1);
    expect(result.details.stopped_outputs).toBe(0);
    expect(result.details.pages_processed).toBe(1);
    expect(result.details.failures).toEqual([]);
    const slugs = await atomSlugs();
    expect(slugs).toHaveLength(1);
    expect(slugs[0]).toContain('complete-atom-from-the-escalated-call');
    expect(slugs.some((slug) => slug.includes('prefix-atom-from-the-clipped-call'))).toBe(false);
  });

  test('a still-clipped retry publishes nothing, stays retryable, and names the truncation', async () => {
    await seed('note/still-clipped');
    const result = await run('note/still-clipped', async () => reply(ATOMS_AT_4096, 'length'));
    expect(result.details.truncation_retries).toBe(1);
    expect(result.details.truncation_recovered).toBe(0);
    expect(result.details.stopped_outputs).toBe(1);
    expect(await atomSlugs()).toEqual([]);
    expect(await state('note/still-clipped')).toEqual({ fail_count: 1, tombstoned: false });
    const failures = result.details.failures as Array<{ source: string; error: string }>;
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toContain('stopReason=length');
    expect(failures[0].error).toContain(`maxTokens=${TRUNCATION_RETRY_MAX_TOKENS}`);
  });

  test('the retry is bounded at one per item per run, and the strike streak still settles', async () => {
    const slug = 'note/bounded';
    await seed(slug);
    let calls = 0;
    const chat = async () => { calls++; return reply(ATOMS_AT_4096, 'length'); };

    for (let i = 1; i < MAX_DETERMINISTIC_FAILURES; i++) {
      const r = await run(slug, chat);
      expect(r.details.truncation_retries).toBe(1);
      expect(r.details.tombstoned_for_failures).toEqual([]);
      expect((await state(slug))?.fail_count).toBe(i);
    }
    // Exactly two paid calls per run: the first attempt plus the ONE retry —
    // never a third, on any of the runs.
    expect(calls).toBe((MAX_DETERMINISTIC_FAILURES - 1) * 2);

    const last = await run(slug, chat);
    expect(calls).toBe(MAX_DETERMINISTIC_FAILURES * 2);
    expect(last.details.tombstoned_for_failures).toEqual([slug]);
    expect(await atomSlugs()).toEqual([]);
  });

  test('a transcript clipped twice stays rediscoverable and its partial atoms are never written', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default', _pages: [],
      _transcripts: [{ filePath: '/synthetic/2026-01-02-chat.txt', content: 'a chat', contentHash: 'f'.repeat(64) }],
      _chat: async () => reply(ATOMS_AT_4096, 'length'),
    });
    expect(result.details.truncation_retries).toBe(1);
    expect(result.details.stopped_outputs).toBe(1);
    expect(result.details.tombstoned_transcripts).toEqual([]);
    expect(await atomSlugs()).toEqual([]);
    const rows = await engine.executeRaw<{ tombstoned: boolean }>('SELECT tombstoned FROM extract_atoms_transcript_state');
    expect(rows.every((row) => row.tombstoned === false)).toBe(true);
  });
});
