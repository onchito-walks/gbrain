/**
 * v147 — Reclassify historic controlled-partial receipts in the extract
 * rollup (EXTRACT-HEALTH accounting repair).
 *
 * Migration v146 (924759542) made NEW `--max-runtime-minutes` CONTROLLED
 * partial completions record into `extract_rollup_7d.controlled_partial_count`
 * instead of `halt_count`, but it did NOT repair the EXISTING rolling
 * aggregate: runs that stopped at their designed wall-clock deadline before
 * v146's write path was deployed were still recorded as `halt_delta=1`,
 * inflating doctor's `extract_health` halt_rate.
 *
 * This backfill reclassifies a historic MISRECORDED halt back to a
 * controlled_partial_count entry — but ONLY where there is explicit,
 * conservatively-scoped evidence that the run was a CONTROLLED partial:
 *
 *   - an extract receipt explicitly marked `controlled_partial` /
 *     `runtime_aborted` (v146+ write path), OR
 *   - a pre-v146 receipt explicitly identified by its run provenance
 *     (kind + source_id + the receipt-writer `shortRunId` segment), passed
 *     via `preV126Evidence`. This is how a documented pre-v146 controlled
 *     partial proof is surfaced without guessing.
 *
 * Guardrails:
 *   - NEVER touches genuine halts (budget/overage/page-failure). Each
 *     qualifying receipt reclassifies AT MOST ONE halt, and the per-row
 *     UPDATE is clamped by `halt_count > 0`, so we can never shift more
 *     misrecorded halts than exist — genuine halts are structurally out of
 *     reach.
 *   - NEVER hides evidence. Receipt pages are preserved; the backfill only
 *     ADDS idempotency frontmatter flags and never deletes/rewrites the body.
 *   - Idempotent. Each qualifying receipt reclassifies at most once and is
 *     stamp-guarded (`backfilled_controlled_partial: true`), so re-running
 *     is a no-op.
 */

import type { BrainEngine } from '../engine.ts';

/** a row of the extract_rollup_7d table (subset we read/write). */
export interface ReclassifyBackfillResult {
  /** receipts matched as explicit controlled-partial evidence (not yet reclassified). */
  qualifying_receipts: number;
  /** receipts whose one misrecorded halt was reclassified to controlled_partial_count. */
  reclassified: number;
  /** qualifying receipts skipped because their (kind, source, day) row has no halt to shift. */
  skipped_no_halt: number;
  /** receipts skipped because they were already reclassified in a prior run. */
  skipped_already_reclassified: number;
  /** distinct extract_rollup_7d rows whose counters were adjusted. */
  rollup_rows_touched: number;
}

/**
 * Explicit provenance for a PRE-v146 controlled-partial receipt that carries
 * no `controlled_partial` frontmatter mark (that stamp only exists on the
 * v146 write path). Identified by the receipt's canonical provenance
 * (kind + source + the `shortRunId` slug segment), per the receipt-writer
 * contract that "provenance is run_id + round".
 */
export interface PreV126ControlledPartialEvidence {
  /** extractor kind recorded on the receipt (e.g. 'facts.conversation'). */
  kind: string;
  source_id: string;
  /** receipt-writer shortRunId slug segment (first 8 chars of run_id). */
  run_prefix: string;
}

interface ReceiptRow {
  slug: string;
  frontmatter: Record<string, unknown>;
  compiled_truth: string | null;
}

interface EligibleReceipt {
  slug: string;
  kind: string;
  source_id: string;
  day: string;
  /** true when matched via preV126 provenance (needs the controlled_partial stamp too). */
  preV126Only: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Idempotent, evidence-based backfill. See module docstring.
 *
 * Modeled to be safe to call from a migration handler OR from an operator
 * re-run (e.g. after receipts are marked): stamp-guarded + clamped, so
 * repeated invocation converges to a fixed point.
 */
export async function reclassifyHistoricControlledPartials(
  engine: BrainEngine,
  opts: { preV126Evidence?: PreV126ControlledPartialEvidence[] } = {},
): Promise<ReclassifyBackfillResult> {
  const result: ReclassifyBackfillResult = {
    qualifying_receipts: 0,
    reclassified: 0,
    skipped_no_halt: 0,
    skipped_already_reclassified: 0,
    rollup_rows_touched: 0,
  };

  let receipts: ReceiptRow[];
  try {
    receipts = await engine.executeRaw<ReceiptRow>(
      `SELECT slug, frontmatter, compiled_truth
         FROM pages
        WHERE type = 'extract_receipt'`,
      [],
    );
  } catch (err) {
    const msg = (err as Error).message || String(err);
    throw new Error(`[reclassify-controlled-partials] could not read extract receipts: ${msg}`);
  }

  const preV126 = opts.preV126Evidence ?? [];

  const eligible: EligibleReceipt[] = [];

  for (const r of receipts) {
    const fm = r.frontmatter && typeof r.frontmatter === 'object' ? r.frontmatter : {};
    const slug = String(r.slug ?? '');

    // Idempotency guard: already reclassified in a prior run.
    if (fm.backfilled_controlled_partial === true) {
      result.skipped_already_reclassified++;
      continue;
    }

    // Explicit controlled-partial evidence on the receipt itself.
    const body = r.compiled_truth && typeof r.compiled_truth === 'string' ? r.compiled_truth : '';
    const markedEvidence =
      fm.controlled_partial === true ||
      fm.runtime_aborted === true ||
      /controlled partial|--max-runtime-?\s*minutes\s+deadline/i.test(body);

    // Pre-v146 provenance evidence (run_id short form in the slug).
    let preV126Only = false;
    let provenanceMatch = false;
    for (const ev of preV126) {
      if (
        String(fm.kind ?? '') === ev.kind &&
        String(fm.source_id ?? '') === ev.source_id &&
        new RegExp(`/${escapeRegex(ev.run_prefix)}/`).test(slug)
      ) {
        provenanceMatch = true;
        preV126Only = true;
        break;
      }
    }

    if (!markedEvidence && !provenanceMatch) continue;

    const kind = String(fm.kind ?? '');
    const source_id = String(fm.source_id ?? '');
    const extractedAt = String(fm.extracted_at ?? '');
    const day = extractedAt.slice(0, 10);
    if (!kind || !source_id || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    eligible.push({ slug, kind, source_id, day, preV126Only });
    result.qualifying_receipts++;
  }

  // Reclassify each qualifying receipt: shift ONE misrecorded halt →
  // controlled_partial_count on its (kind, source_id, day) rollup row,
  // clamped by halt_count > 0, then stamp the receipt for idempotency.
  // Both statements commit atomically inside engine.transaction.
  for (const rec of eligible) {
    let shifted = false;
    try {
      shifted = await engine.transaction(async (tx) => {
        const upd = await tx.executeRaw<{ kind: string }>(
          `UPDATE extract_rollup_7d
              SET halt_count = halt_count - 1,
                  controlled_partial_count = controlled_partial_count + 1,
                  updated_at = now()
            WHERE kind = $1 AND source_id = $2 AND day = $3 AND halt_count > 0
            RETURNING kind`,
          [rec.kind, rec.source_id, rec.day],
        );
        if (upd.length === 0) return false;

        // Idempotency stamp: mark this receipt already-reclassified.
        await tx.executeRaw(
          `UPDATE pages
              SET frontmatter = frontmatter || jsonb_build_object('backfilled_controlled_partial', true)
            WHERE slug = $1`,
          [rec.slug],
        );

        // For a pre-v146 provenance receipt, also stamp controlled_partial:
        // true so the frontmatter reflects reality (matching the v146
        // write-path stamp this receipt never received). Harmless if the key
        // already exists.
        if (rec.preV126Only) {
          await tx.executeRaw(
            `UPDATE pages
                SET frontmatter = frontmatter || jsonb_build_object('controlled_partial', true)
              WHERE slug = $1`,
            [rec.slug],
          );
        }
        return true;
      });
    } catch (err) {
      // A single receipt failing must not abort the whole backfill; log and
      // continue so the operator sees the receipts that could not shift.
      const msg = (err as Error).message || String(err);
      console.error(`[reclassify-controlled-partials] failed for receipt ${rec.slug}: ${msg}`);
      continue;
    }

    if (shifted) {
      result.reclassified++;
      result.rollup_rows_touched++;
    } else {
      // No misrecorded halt on this (kind, source, day). Leave the receipt
      // unstamped so it retries if a misrecorded halt later appears.
      result.skipped_no_halt++;
    }
  }

  return result;
}
