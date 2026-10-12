/**
 * Execution-boundary quarantine re-check for extract_atoms (B12).
 *
 * Candidate SELECTION already excludes quarantined pages — `discoverExtractablePages`
 * and `countExtractAtomsBacklog` both carry `quarantineFilterFragment('p')` — so a
 * page the content-quality gate marked `quarantine` (high-confidence junk:
 * Cloudflare/CAPTCHA interstitials, operator literals) never enters the
 * candidate list in the first place.
 *
 * This helper closes the RACE: a page can be quarantined BETWEEN listing and
 * execution (a concurrent `quarantine scan`, an import/sync disposition, or a
 * capture write). The drain holds a single continuous lock, but sync/capture
 * run on their own connections, so the page list can be stale by the time the
 * work loop reaches a page. Re-checking the marker here, at the execution
 * boundary, keeps the "junk never reaches the model" guarantee true even when
 * the quarantine lands after discovery — one batched query for every page in
 * the batch, not per item.
 *
 * Split out of extract-atoms.ts to respect the module-size/function-size
 * ratchets; stateless and pure over the engine seam so it is unit-testable
 * against PGLite. Reads only: it never touches the managed atom writer, the
 * per-source cycle lock, or any page row.
 */

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { QUARANTINE_KEY } from '../quarantine.ts';
import type { AtomWorkItem } from './extract-atoms-work.ts';

/**
 * Thrown when the execution-boundary quarantine re-check cannot be answered
 * (query error / DB unavailable). Carries the underlying message so the phase
 * can surface WHY it refused to run.
 */
export class QuarantineRecheckError extends Error {
  readonly tag = 'QUARANTINE_RECHECK_FAILED' as const;
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`quarantine re-check failed: ${msg}`);
    this.name = 'QuarantineRecheckError';
  }
}

/**
 * Return the subset of `slugs` that currently carry the `quarantine` marker in
 * the given source. Marker semantics mirror `isQuarantined` /
 * `quarantineFilterFragment`: key EXISTENCE (non-null) triggers, not a value,
 * and the key name comes from QUARANTINE_KEY so it cannot drift.
 *
 * Scoped by `source_id`: a page is only "quarantined" for the source whose
 * cycle is listing it, so this cannot borrow another source's visibility.
 *
 * FAIL-CLOSED on a query error: throws `QuarantineRecheckError` instead of
 * returning the empty set. Returning empty would claim "none of these pages
 * are quarantined" when the true answer is UNKNOWN, and the phase would then
 * send the batch to the model — exactly the fail-OPEN that lets quarantined
 * junk reach the LLM. The caller treats a throw as "refuse to run, zero model
 * calls" (see `quarantineRecheckFailedResult`). The quarantine status of a
 * candidate is never assumed when it cannot be verified.
 */
export async function quarantinedSlugsAmong(
  engine: BrainEngine,
  sourceId: string,
  slugs: readonly string[],
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  try {
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug
         FROM pages
        WHERE source_id = $1
          AND deleted_at IS NULL
          AND slug = ANY($2::text[])
          AND (COALESCE(frontmatter, '{}'::jsonb) ? '${QUARANTINE_KEY}')`,
      [sourceId, [...slugs]],
    );
    return new Set(rows.map((r) => r.slug));
  } catch (err) {
    throw new QuarantineRecheckError(err);
  }
}

export interface QuarantineRecheckFailedContext {
  sourceId: string;
  /** Transcripts that WOULD have been processed; reported, never processed. */
  transcriptsTotal: number;
  /** Pages listed for execution whose quarantine status could not be verified. */
  pagesTotal: number;
  duplicatesSkipped: number;
  /**
   * The per-run cost cap, or `null` when the refusal happens before the phase
   * resolves it. The re-check runs BEFORE the cost gate, so this refusal claims
   * no cap at all rather than repeating the built-in default as if it applied.
   */
  budgetUsd: number | null;
  dryRun: boolean;
}

/**
 * Build the FAIL-CLOSED phase result for an unanswerable quarantine re-check.
 *
 * The phase makes ZERO model calls: neither the pages whose status is unknown
 * NOR anything else runs, because a DB that cannot answer the re-check is not
 * a DB whose listing snapshot we can trust. The result is `skipped` with
 * `blocked: true` / `blocked_reason: 'quarantine_recheck_failed'` so the drain
 * adapter and operators see WHY nothing was extracted instead of a silent
 * empty batch. `budget_exhausted` is deliberately NOT set: this is a refusal,
 * not a cap stop, and the two must not be conflated downstream.
 */
export function quarantineRecheckFailedResult(
  cause: unknown,
  ctx: QuarantineRecheckFailedContext,
): PhaseResult {
  const msg = cause instanceof Error ? cause.message : String(cause);
  console.error(
    `[extract_atoms] FAIL-CLOSED: quarantine re-check failed — refusing to run (0 model calls) ` +
      `rather than risk sending quarantined junk to the model: ${msg}`,
  );
  return {
    phase: 'extract_atoms',
    status: 'skipped',
    duration_ms: 0,
    summary: 'extract_atoms: fail-closed — quarantine re-check failed, 0 model calls',
    details: {
      reason: 'quarantine_recheck_failed',
      blocked: true,
      blocked_reason: 'quarantine_recheck_failed',
      source_id: ctx.sourceId,
      dry_run: ctx.dryRun,
      atoms_extracted: 0,
      transcripts_processed: 0,
      transcripts_total: ctx.transcriptsTotal,
      transcripts_skipped_budget: 0,
      pages_processed: 0,
      pages_total: ctx.pagesTotal,
      pages_excluded_quarantined: 0,
      duplicates_skipped: ctx.duplicatesSkipped,
      failures: [],
      estimated_spend_usd: 0,
      budget_usd: ctx.budgetUsd,
    },
  };
}

/**
 * Drop every PAGE work item whose slug is quarantined at the execution
 * boundary, in place, and report how many were dropped.
 *
 * Returns `{ failed }` (the fail-closed phase result) when the re-check cannot
 * be answered, so the caller returns it verbatim and makes no model call.
 * Transcript items are never re-checked: they are filesystem paths, not
 * brain pages, and the quarantine marker is a page-frontmatter contract.
 */
export async function dropQuarantinedListedPages(
  engine: BrainEngine,
  sourceId: string,
  work: AtomWorkItem[],
  ctx: QuarantineRecheckFailedContext,
): Promise<{ excluded: number } | { failed: PhaseResult }> {
  const slugs = work
    .filter((w): w is Extract<AtomWorkItem, { kind: 'page' }> => w.kind === 'page')
    .map((w) => w.slug);
  if (slugs.length === 0) return { excluded: 0 };
  let quarantined: Set<string>;
  try {
    quarantined = await quarantinedSlugsAmong(engine, sourceId, slugs);
  } catch (err) {
    return { failed: quarantineRecheckFailedResult(err, ctx) };
  }
  let excluded = 0;
  for (let i = work.length - 1; i >= 0; i--) {
    const item = work[i]!;
    if (item.kind === 'page' && quarantined.has(item.slug)) {
      work.splice(i, 1);
      excluded++;
    }
  }
  return { excluded };
}
