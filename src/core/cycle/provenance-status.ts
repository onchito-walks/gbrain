/**
 * Read-time atom provenance STATUS — a READ-ONLY classification.
 *
 * WHY THIS EXISTS
 * ---------------
 * An atom records `frontmatter.source_hash` — the first 16 hex chars of the
 * source page's `content_hash` at extraction time — plus the verbatim
 * `source_quote` it was distilled from. When the source page is later edited or
 * moved, that hash stops matching any live page ("drift"). Existing tooling
 * could only say drifted / source_changed / source_gone: it never asked whether
 * the quoted passage itself survived. This module answers that question at read
 * time and nothing more.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT a reconciliation, a repair, or a re-bind. It NEVER writes
 * `source_hash` (or anything else), NEVER rewrites frontmatter, and NEVER
 * consults or mutates `page_versions`. A surviving quote is evidence that the
 * *passage* persisted in the live page — it does NOT prove the atom is sound,
 * does NOT restore the atom's source binding, and does NOT re-establish that
 * extraction was correct. Callers must present it as evidence about the quote,
 * never as a verdict about the atom.
 *
 * STATUSES
 * --------
 *   fresh                     source_hash still resolves to a live page in the
 *                             same source — no drift.
 *   quote_present_in_live_page drift, but a live non-atom page in the same
 *                             source still contains the stored source_quote
 *                             (after the shared grounding fold, so it means the
 *                             same thing extraction meant by "located").
 *   quote_orphaned            drift, source page alive, but the quote no longer
 *                             resolves — or the atom carries no quote at all.
 *   source_gone               drift and no live non-atom page resolves at the
 *                             frozen source_slug (exact, or via the single
 *                             verified legacy-prefix alias) in the same source.
 *   slug_unbound              no source_slug (transcript-minted source_path-only
 *                             or pre-binding-era) — not page-checkable.
 *
 * Every status is scoped to the atom's own `source_id`; the legacy alias only
 * rewrites the slug and never crosses a source boundary.
 */
import type { BrainEngine } from '../engine.ts';
import { normForGrounding } from './synthesize-verify.ts';
import { sourceSlugCandidates } from '../atom-slug-alias.ts';

export type AtomProvenanceStatus =
  | 'fresh'
  | 'quote_present_in_live_page'
  | 'quote_orphaned'
  | 'source_gone'
  | 'slug_unbound';

export interface AtomProvenanceRecord {
  /** The atom's own source_id — resolution never crosses it. */
  sourceId: string;
  sourceSlug: string | null;
  sourceHash: string | null;
  sourceQuote: string | null;
}

export interface AtomProvenanceVerdict {
  status: AtomProvenanceStatus;
  /** True only when the stored quote folds into the resolved live source body. */
  quotePresent: boolean;
  /** The live slug the source resolved to (exact or de-prefixed alias), else null. */
  resolvedSlug: string | null;
}

export interface AtomProvenanceInput {
  sourceSlug: string | null;
  sourceHash: string | null;
  sourceQuote: string | null;
  /** Live content_hash prefixes (16 chars) for pages in the SAME source. */
  liveHashPrefixes: ReadonlySet<string>;
  /**
   * Compiled truth of the live non-atom source page in the SAME source,
   * resolved by exact slug or the single verified legacy-prefix alias; `null`
   * when no such page exists.
   */
  liveSourceBody: string | null;
  resolvedSlug?: string | null;
}

/** A `source_slug` that is absent or only whitespace is slug-unbound, exactly
 *  like the `NULLIF(...,'')` predicate the doctor uses. */
function normalizeSlug(slug: string | null): string | null {
  return slug != null && slug.trim() !== '' ? slug : null;
}

/**
 * Pure, side-effect-free classification. The quote test uses the ONE folding
 * core (`normForGrounding`) so a "present" verdict means the same thing
 * extraction meant when it located the quote.
 */
export function classifyAtomProvenance(input: AtomProvenanceInput): AtomProvenanceVerdict {
  const slug = normalizeSlug(input.sourceSlug);
  if (slug == null) {
    return { status: 'slug_unbound', quotePresent: false, resolvedSlug: null };
  }
  if (input.sourceHash != null && input.liveHashPrefixes.has(input.sourceHash)) {
    return { status: 'fresh', quotePresent: false, resolvedSlug: input.resolvedSlug ?? null };
  }
  if (input.liveSourceBody == null) {
    return { status: 'source_gone', quotePresent: false, resolvedSlug: null };
  }
  const quote = input.sourceQuote ?? '';
  const present =
    quote.trim().length > 0 &&
    normForGrounding(input.liveSourceBody).includes(normForGrounding(quote));
  return {
    status: present ? 'quote_present_in_live_page' : 'quote_orphaned',
    quotePresent: present,
    resolvedSlug: input.resolvedSlug ?? null,
  };
}

export interface ClassifyAtomProvenanceOptions {
  /**
   * The caller already knows every record is drifted (hash does not resolve) —
   * skip the live-hash probe entirely. Used by the doctor, which derives the
   * drifted set from its own aggregate before asking only about quotes.
   */
  assumeDrifted?: boolean;
}

/**
 * Batched, read-only classification. Two small SELECTs: the live-hash prefixes
 * for the involved sources, and the live non-atom bodies for the candidate
 * slugs. Best-effort callers (search) should wrap this and never let it break
 * retrieval.
 */
export async function classifyAtomProvenanceRecords(
  engine: BrainEngine,
  records: readonly AtomProvenanceRecord[],
  opts: ClassifyAtomProvenanceOptions = {},
): Promise<AtomProvenanceVerdict[]> {
  if (records.length === 0) return [];
  const sourceIds = [...new Set(records.map((r) => r.sourceId))];

  const hashesBySource = new Map<string, Set<string>>();
  if (!opts.assumeDrifted) {
    const hashRows = await engine.executeRaw<{ sid: string; sh: string }>(
      `SELECT DISTINCT source_id AS sid, substring(content_hash from 1 for 16) AS sh
         FROM pages
        WHERE deleted_at IS NULL AND content_hash IS NOT NULL
          AND source_id = ANY($1::text[])`,
      [sourceIds],
    );
    for (const row of hashRows) {
      let set = hashesBySource.get(row.sid);
      if (!set) { set = new Set(); hashesBySource.set(row.sid, set); }
      set.add(row.sh);
    }
  }

  // Candidate (source_id, slug) pairs still needing a live body.
  const needSlugsBySource = new Map<string, Set<string>>();
  const candidatesByRecord: string[][] = records.map((r) => {
    const slug = normalizeSlug(r.sourceSlug);
    if (slug == null) return [];
    if (!opts.assumeDrifted) {
      const set = hashesBySource.get(r.sourceId);
      if (r.sourceHash != null && set?.has(r.sourceHash)) return []; // fresh
    }
    const candidates = sourceSlugCandidates(slug);
    let need = needSlugsBySource.get(r.sourceId);
    if (!need) { need = new Set(); needSlugsBySource.set(r.sourceId, need); }
    for (const c of candidates) need.add(c);
    return candidates;
  });

  const bodyByKey = new Map<string, string>();
  for (const [sid, slugs] of needSlugsBySource) {
    const rows = await engine.executeRaw<{ slug: string; body: string | null }>(
      `SELECT slug, compiled_truth AS body
         FROM pages
        WHERE deleted_at IS NULL AND type <> 'atom'
          AND source_id = $1 AND slug = ANY($2::text[])`,
      [sid, [...slugs]],
    );
    for (const row of rows) bodyByKey.set(`${sid}\u0000${row.slug}`, row.body ?? '');
  }

  return records.map((record, i) => {
    let resolvedSlug: string | null = null;
    let body: string | null = null;
    for (const candidate of candidatesByRecord[i]) {
      const got = bodyByKey.get(`${record.sourceId}\u0000${candidate}`);
      if (got != null) { resolvedSlug = candidate; body = got; break; }
    }
    return classifyAtomProvenance({
      sourceSlug: record.sourceSlug,
      sourceHash: record.sourceHash,
      sourceQuote: record.sourceQuote,
      liveHashPrefixes: hashesBySource.get(record.sourceId) ?? new Set<string>(),
      liveSourceBody: body,
      resolvedSlug,
    });
  });
}
