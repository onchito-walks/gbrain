/**
 * Deterministic re-screen for `content_flag` markers (#6259 follow-up).
 *
 * A page's write-gate verdict is derived once, at import, and stored in
 * `content_flag`. The detector improves over time (`write-gate-patterns.ts`),
 * but a page that is never rewritten keeps the verdict of whichever detector
 * version last saw it. So the flag count grows monotonically and doctor's
 * `flagged_pages` can never go clean even when the current detector would
 * allow the page.
 *
 * This lane re-derives each flag with the CURRENT detector at the page's own
 * stored trust tier, and republishes only the pages that now come back
 * `allow` — the canonical write path then drops the stale marker itself
 * (`import-screen.ts`). Pages whose content still matches keep their flag.
 * No LLM call, no threshold change, no content edit: the same bytes are
 * re-screened and re-published through the owner.
 */
import type { BrainEngine } from './engine.ts';
import { serializePageToMarkdown } from './markdown.ts';
import { CONTENT_FLAG_KEY, QUARANTINE_KEY } from './quarantine.ts';
import { assessPageForGate, DEFAULT_WRITE_GATE_CONFIG, WRITE_GATE_DETECTOR_VERSION, type WriteGateAssessment } from './write-gate.ts';
import { isTrustTier, type TrustTier } from './trust/tier.ts';
import { loadConfig } from './config.ts';
import type { OperationContext } from './ops/contract.ts';

/** Keys only the gate or the operator's clear may set; a re-screen must not republish them. */
const GATE_OWNED = [CONTENT_FLAG_KEY, QUARANTINE_KEY, 'atoms_scan_hash', 'quarantine_override'] as const;

export const RESCREEN_DEFAULT_LIMIT = 500;
export const RESCREEN_MAX_LIMIT = 20000;

export interface RescreenOutcome {
  slug: string;
  source_id: string;
  stored_tier: string;
  detector_version: number;
  /** What the current detector says about the stored content. */
  verdict: WriteGateAssessment['verdict'];
  /** `allow` here means the stored flag is stale. */
  action: 'stale_would_clear' | 'reproduced' | 'cleared' | 'skipped_error';
  families?: string[];
  error?: string;
}

export interface RescreenReport {
  source_id: string;
  applied: boolean;
  scanned: number;
  stale: number;
  cleared: number;
  reproduced: number;
  errors: number;
  detector_version: number;
  outcomes: RescreenOutcome[];
}

export interface FlaggedRow {
  slug: string;
  source_id: string;
  title: string | null;
  type: string | null;
  compiled_truth: string | null;
  timeline: string | null;
  frontmatter: Record<string, unknown> | null;
  trust_tier: string | null;
}

/** Only content the gate actually scans: markers are bookkeeping, not author text. */
function screenable(row: FlaggedRow) {
  const frontmatter = { ...(row.frontmatter ?? {}) };
  for (const key of GATE_OWNED) delete frontmatter[key];
  return {
    title: row.title ?? '', type: row.type ?? 'note',
    compiled_truth: row.compiled_truth ?? '', timeline: row.timeline ?? '', frontmatter,
  };
}

/** The flagged pages of one source (marker present, not quarantined), oldest slug first. */
export async function loadFlaggedRows(engine: BrainEngine, sourceId: string, limit: number): Promise<FlaggedRow[]> {
  return engine.executeRaw<FlaggedRow>(
    `SELECT slug, source_id, title, type, compiled_truth, timeline, frontmatter, trust_tier
       FROM pages
      WHERE deleted_at IS NULL AND source_id = $1 AND frontmatter ? $2
        AND NOT (frontmatter ? $3)
      ORDER BY slug LIMIT $4`,
    [sourceId, CONTENT_FLAG_KEY, QUARANTINE_KEY, limit],
  );
}

/** Pure: what the CURRENT detector says about a row's stored content. */
export function classifyFlaggedRow(row: FlaggedRow): { tier: TrustTier; assessment: WriteGateAssessment } {
  const tier: TrustTier = isTrustTier(row.trust_tier as TrustTier) ? row.trust_tier as TrustTier : 'unknown';
  return { tier, assessment: assessPageForGate(screenable(row), { tier }, DEFAULT_WRITE_GATE_CONFIG) };
}

/** Publish one page unchanged except for the gate-owned markers, through the owner. */
export async function republishWithoutStaleFlag(engine: BrainEngine, row: Pick<FlaggedRow, 'slug' | 'source_id'>): Promise<void> {
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot) throw new Error('page snapshot unavailable');
  const frontmatter = { ...snapshot.page.frontmatter };
  for (const key of GATE_OWNED) delete frontmatter[key];
  const content = serializePageToMarkdown({ ...snapshot.page, frontmatter }, snapshot.tags);
  const { operations } = await import('./operations.ts');
  const putPage = operations.filter((operation) => !operation.localOnly).find((operation) => operation.name === 'put_page');
  if (!putPage) throw new Error('put_page operation missing (gbrain build issue)');
  const config = loadConfig() ?? { engine: engine.kind };
  const ctx: OperationContext = { engine, config, logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false, remote: false, sourceId: row.source_id };
  await putPage.handler(ctx, { slug: row.slug, content, expected_revision: snapshot.revision });
}

/**
 * Re-screen one source's flagged pages. Preview by default; `apply` republishes
 * only stale flags through the canonical owner with the snapshot revision, so a
 * concurrent edit becomes a revision conflict instead of an overwrite.
 */
export async function rescreenContentFlags(
  engine: BrainEngine,
  opts: { sourceId: string; apply?: boolean; limit?: number },
): Promise<RescreenReport> {
  const limit = Math.min(Math.max(1, opts.limit ?? RESCREEN_DEFAULT_LIMIT), RESCREEN_MAX_LIMIT);
  const rows = await loadFlaggedRows(engine, opts.sourceId, limit);

  const report: RescreenReport = { source_id: opts.sourceId, applied: !!opts.apply, scanned: rows.length,
    stale: 0, cleared: 0, reproduced: 0, errors: 0, detector_version: WRITE_GATE_DETECTOR_VERSION, outcomes: [] };

  for (const row of rows) {
    const { tier, assessment } = classifyFlaggedRow(row);
    if (assessment.detectorError) {
      // A detector error is never permission to clear a flag.
      report.errors++;
      report.outcomes.push({ slug: row.slug, source_id: row.source_id, stored_tier: tier,
        detector_version: WRITE_GATE_DETECTOR_VERSION, verdict: assessment.verdict, action: 'skipped_error',
        error: 'detector_error' });
      continue;
    }
    const families = [...new Set(assessment.hits.map((h) => h.family))];
    if (assessment.verdict !== 'allow') {
      report.reproduced++;
      report.outcomes.push({ slug: row.slug, source_id: row.source_id, stored_tier: tier,
        detector_version: WRITE_GATE_DETECTOR_VERSION, verdict: assessment.verdict, action: 'reproduced', families });
      continue;
    }

    report.stale++;
    if (!opts.apply) {
      report.outcomes.push({ slug: row.slug, source_id: row.source_id, stored_tier: tier,
        detector_version: WRITE_GATE_DETECTOR_VERSION, verdict: 'allow', action: 'stale_would_clear' });
      continue;
    }

    try {
      await republishWithoutStaleFlag(engine, row);
      report.cleared++;
      report.outcomes.push({ slug: row.slug, source_id: row.source_id, stored_tier: tier,
        detector_version: WRITE_GATE_DETECTOR_VERSION, verdict: 'allow', action: 'cleared' });
    } catch (err) {
      report.errors++;
      report.outcomes.push({ slug: row.slug, source_id: row.source_id, stored_tier: tier,
        detector_version: WRITE_GATE_DETECTOR_VERSION, verdict: 'allow', action: 'skipped_error',
        error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
