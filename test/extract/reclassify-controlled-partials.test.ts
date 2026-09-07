// v147 — extract_rollup reclassification of historic controlled-partial
// receipts (EXTRACT-HEALTH accounting repair).
//
// Pins:
//   - A receipt explicitly marked controlled_partial (v146 write path)
//     reclassifies exactly ONE misrecorded halt → controlled_partial_count,
//     clamped by halt_count > 0, and is stamp-guarded for idempotency.
//   - Genuine halts (beyond qualifying receipts) are structurally untouched.
//   - Pre-v146 provenance evidence (run_id shortForm in the slug) classifies
//     an otherwise-unmarked receipt and stamps controlled_partial: true.
//   - Re-running the backfill is a no-op.
//   - Doctor extract_health reads the reconciled rollup as OK and surfaces the
//     controlled_partial_count as visible capacity/progress info.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { reclassifyHistoricControlledPartials } from '../../src/core/extract/reclassify-controlled-partials.ts';
import { computeExtractHealthCheck } from '../../src/commands/doctor.ts';

let engine: PGLiteEngine;

// Rollup rows + receipt dates must share a day; use the engine's CURRENT_DATE.
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function clearAll() {
  await engine.executeRaw('DELETE FROM extract_rollup_7d', []);
  await engine.executeRaw(
    "DELETE FROM pages WHERE type = 'extract_receipt'",
    [],
  );
}

/** Insert a receipt page directly (provenance writing path not under test). */
async function addReceipt(
  slug: string,
  fm: Record<string, unknown>,
  body = '',
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter)
     VALUES ('default', $1, 'extract_receipt', $1, $2, $3::jsonb)`,
    [slug, body, JSON.stringify(fm)],
  );
}

/** (Re)seed the facts.conversation rollup row. */
async function setRollup(halt: number, controlled: number, completed: number, day = 'CURRENT_DATE') {
  await engine.executeRaw(
    `INSERT INTO extract_rollup_7d
       (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count,
        halt_count, controlled_partial_count, round_completed_count, rollup_write_failures, updated_at)
     VALUES ('facts.conversation', 'default', ${day}, 0.42, 0, 0, ${halt}, ${controlled}, ${completed}, 0, NOW())`,
    [],
  );
}

async function rollupCounts() {
  const rows = await engine.executeRaw<{
    halt_count: number;
    controlled_partial_count: number;
    round_completed_count: number;
  }>(
    `SELECT halt_count, controlled_partial_count, round_completed_count
       FROM extract_rollup_7d
      WHERE kind = 'facts.conversation' AND source_id = 'default'`,
    [],
  );
  return rows[0];
}

async function receiptFrontmatter(slug: string): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
    'SELECT frontmatter FROM pages WHERE slug = $1',
    [slug],
  );
  return rows[0]?.frontmatter ?? {};
}

describe('reclassifyHistoricControlledPartials — v146-marked receipt', () => {
  test('reclassifies ONE misrecorded halt and leaves genuine halts untouched', async () => {
    await clearAll();
    // Mimic the live brain: 3 recorded halts (one is the misrecorded
    // controlled partial), 0 controlled partials, 20 completed rounds.
    await setRollup(3, 0, 20);

    // One receipt explicitly marked controlled_partial (v146 write path).
    await addReceipt(
      'extracts/2026-08-22/facts.conversation/default/ecf-aaaa/round-full',
      {
        kind: 'facts.conversation',
        source_id: 'default',
        extracted_at: `${TODAY}T23:08:56.835Z`,
        controlled_partial: true,
        type: 'extract_receipt',
      },
      'Stopped at the --max-runtime-minutes deadline (controlled partial completion).',
    );

    const res = await reclassifyHistoricControlledPartials(engine);
    expect(res.qualifying_receipts).toBe(1);
    expect(res.reclassified).toBe(1);
    expect(res.skipped_no_halt).toBe(0);

    const row = await rollupCounts();
    // Exactly ONE halt reclassified; the other 2 genuine halts remain.
    expect(row.halt_count).toBe(2);
    expect(row.controlled_partial_count).toBe(1);
    expect(row.round_completed_count).toBe(20);

    // Receipt stamped for idempotency; controlled_partial already present.
    const fm = await receiptFrontmatter(
      'extracts/2026-08-22/facts.conversation/default/ecf-aaaa/round-full',
    );
    expect(fm.backfilled_controlled_partial).toBe(true);
    expect(fm.controlled_partial).toBe(true);
  });

  test('doctor extract_health reads the reconciled rollup as OK + shows controlled count', async () => {
    // Reuses the persisted state from the test above IF not cleared below;
    // to stay hermetic, recreate the reconciled aggregate explicitly.
    await clearAll();
    await setRollup(2, 1, 20); // post-reclassification: 2/23 = 8.7% < 10%
    const check = await computeExtractHealthCheck(engine);
    expect(check.name).toBe('extract_health');
    expect(check.status).toBe('ok');
    const kind = (check.details as any).kinds[0];
    expect(kind.kind).toBe('facts.conversation');
    expect(kind.halt_rate).toBeLessThan(0.10);
    // Controlled partial count remains visible as capacity/progress info.
    expect(kind.controlled_partial_count).toBe(1);
    expect(check.message).toContain('controlled partial');
  });

  test('re-running the backfill is a no-op (idempotent)', async () => {
    await clearAll();
    await setRollup(3, 0, 20);
    await addReceipt(
      'extracts/2026-08-22/facts.conversation/default/ecf-aaaa/round-full',
      {
        kind: 'facts.conversation',
        source_id: 'default',
        extracted_at: `${TODAY}T23:08:56.835Z`,
        controlled_partial: true,
        type: 'extract_receipt',
      },
    );

    const first = await reclassifyHistoricControlledPartials(engine);
    const second = await reclassifyHistoricControlledPartials(engine);
    expect(first.qualifying_receipts).toBe(1);
    expect(first.reclassified).toBe(1);
    // Second run: the receipt is already stamped → skipped, nothing shifts.
    expect(second.qualifying_receipts).toBe(0);
    expect(second.reclassified).toBe(0);
    const row = await rollupCounts();
    expect(row.halt_count).toBe(2);
    expect(row.controlled_partial_count).toBe(1);
  });
});

describe('reclassifyHistoricControlledPartials — safety guards', () => {
  test('does not fabricate reclassification when no misrecorded halt exists', async () => {
    await clearAll();
    await setRollup(0, 5, 20); // no halts at all
    await addReceipt(
      'extracts/2026-08-22/facts.conversation/default/ecf-bbbb/round-full',
      {
        kind: 'facts.conversation',
        source_id: 'default',
        extracted_at: `${TODAY}T12:00:00.000Z`,
        controlled_partial: true,
        type: 'extract_receipt',
      },
    );

    const res = await reclassifyHistoricControlledPartials(engine);
    expect(res.qualifying_receipts).toBe(1);
    expect(res.reclassified).toBe(0);
    expect(res.skipped_no_halt).toBe(1);

    const row = await rollupCounts();
    expect(row.halt_count).toBe(0);
    expect(row.controlled_partial_count).toBe(5);

    // Receipt left unstamped so it retries if a misrecorded halt later appears.
    const fm = await receiptFrontmatter(
      'extracts/2026-08-22/facts.conversation/default/ecf-bbbb/round-full',
    );
    expect(fm.backfilled_controlled_partial).toBeUndefined();
  });

  test('never shifts more halts than qualifying receipts (genuine halts protected)', async () => {
    await clearAll();
    await setRollup(1, 0, 10); // only 1 halt available
    await addReceipt(
      'extracts/2026-08-22/facts.conversation/default/ecf-cccc/round-full',
      {
        kind: 'facts.conversation',
        source_id: 'default',
        extracted_at: `${TODAY}T08:00:00.000Z`,
        controlled_partial: true,
        type: 'extract_receipt',
      },
    );
    await addReceipt(
      'extracts/2026-08-22/facts.conversation/default/ecf-dddd/round-full',
      {
        kind: 'facts.conversation',
        source_id: 'default',
        extracted_at: `${TODAY}T09:00:00.000Z`,
        controlled_partial: true,
        type: 'extract_receipt',
      },
    );

    const res = await reclassifyHistoricControlledPartials(engine);
    // Only one shift possible (halt clamp); the second receipt is skipped.
    expect(res.reclassified).toBe(1);
    expect(res.skipped_no_halt).toBe(1);
    const row = await rollupCounts();
    expect(row.halt_count).toBe(0);
    expect(row.controlled_partial_count).toBe(1);
  });

  test('ignores receipts with no controlled-partial evidence (no false positives)', async () => {
    await clearAll();
    await setRollup(3, 0, 20);
    // A plain completed receipt — NO controlled-partial mark, body has no marker.
    await addReceipt(
      'extracts/2026-08-22/facts.conversation/default/ecf-eeee/round-full',
      {
        kind: 'facts.conversation',
        source_id: 'default',
        extracted_at: `${TODAY}T10:00:00.000Z`,
        type: 'extract_receipt',
      },
      'Extracted 17 facts from 1/1 eligible pages.',
    );

    const res = await reclassifyHistoricControlledPartials(engine);
    expect(res.qualifying_receipts).toBe(0);
    expect(res.reclassified).toBe(0);
    const row = await rollupCounts();
    expect(row.halt_count).toBe(3); // genuinely halted; untouched
    expect(row.controlled_partial_count).toBe(0);
  });
});

describe('reclassifyHistoricControlledPartials — pre-v146 provenance evidence', () => {
  test('classifies an otherwise-unmarked receipt by run_id provenance + stamps it', async () => {
    await clearAll();
    await setRollup(3, 0, 20);
    // The live "1-minute deadline proof" receipt: written pre-v146, so it has
    // NO controlled_partial mark. Its slug carries the shortRunId.
    await addReceipt(
      'extracts/2026-08-22/facts.conversation/default/ecf-mt4z/round-full',
      {
        kind: 'facts.conversation',
        source_id: 'default',
        extracted_at: `${TODAY}T23:08:56.835Z`,
        type: 'extract_receipt',
      },
    );

    const res = await reclassifyHistoricControlledPartials(engine, {
      preV126Evidence: [{ kind: 'facts.conversation', source_id: 'default', run_prefix: 'ecf-mt4z' }],
    });
    expect(res.qualifying_receipts).toBe(1);
    expect(res.reclassified).toBe(1);

    const row = await rollupCounts();
    expect(row.halt_count).toBe(2);
    expect(row.controlled_partial_count).toBe(1);

    // Receipt stamped with the v146-style controlled_partial + idempotency mark.
    const fm = await receiptFrontmatter(
      'extracts/2026-08-22/facts.conversation/default/ecf-mt4z/round-full',
    );
    expect(fm.controlled_partial).toBe(true);
    expect(fm.backfilled_controlled_partial).toBe(true);
  });
});