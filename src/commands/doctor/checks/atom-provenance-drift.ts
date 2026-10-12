/**
 * atom_provenance_drift check support — the read-time, READ-ONLY side of the
 * check (Stage 3B B09/B10, task t_e8aff02d).
 *
 * Peeled out of `commands/doctor/checks/extraction-sync.ts` so the ratcheted
 * module only grows by the wiring: the aggregate SQL (alias-aware source
 * resolution plus the drift population) and the bounded read-time quote probe
 * live here.
 *
 * WHY THE QUOTE PROBE EXISTS
 * --------------------------
 * A drifted atom is still returned by search, still carries a `source_quote`,
 * and still reads as sourced. The check must say what is actually TRUE of each
 * class rather than implying the evidence is gone:
 *
 *   fresh                      source_hash still resolves to a live page.
 *   quote_present_in_live_page drift, source page alive, and the stored quote
 *                              still folds into the live page (grounding fold).
 *   quote_orphaned             drift, source page alive, quote no longer
 *                              resolves (or the atom carries no quote).
 *   source_gone                drift and no live non-atom page resolves at the
 *                              frozen slug — exact, or via the single-prefix
 *                              legacy alias, within the atom's own source_id.
 *   slug_unbound               no source_slug at all — not page-checkable.
 *
 * The alias is prefix-only and scoped to the atom's own `source_id`. The probe
 * is bounded (only drifted, source-alive atoms that carry a quote) and it NEVER
 * rewrites `source_hash`, frontmatter, or `page_versions`. A surviving quote is
 * evidence that the PASSAGE persisted — not that the atom is sound, that its
 * source binding is restored, or that its claim is proven.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { classifyAtomProvenanceRecords, type AtomProvenanceRecord } from '../../../core/cycle/provenance-status.ts';
import { LEGACY_SOURCE_SLUG_PREFIXES } from '../../../core/atom-slug-alias.ts';
import { escapeLikePattern } from '../../../core/search/sql-ranking.ts';

/** Prefix-only legacy alias arms, built from the ONE allow-list
 *  (core/atom-slug-alias.ts) the covered-atom retrieval predicate also uses, so
 *  page resolution means the same thing in search and here. Interpolated from a
 *  code constant (never env/config) and LIKE-escaped, so the alias surface can
 *  never be widened from outside. */
export function legacyAliasArms(): string {
  return LEGACY_SOURCE_SLUG_PREFIXES.map(
    (prefix) =>
      `(atom.ss LIKE '${escapeLikePattern(prefix)}%' ESCAPE '\\'` +
      ` AND sa.slug = substring(atom.ss from ${prefix.length + 1}))`,
  ).join(' OR ');
}

export interface AtomProvenanceDriftRow {
  total: string | number; slug_unbound: string | number; drifted: string | number;
  source_changed: string | number; source_gone: string | number;
  oldest_ext: string | null; quote_candidates: unknown;
}

/**
 * The aggregate. `extracted_at` stays TEXT end to end: an unguarded
 * `::timestamptz` cast let ONE malformed frontmatter value abort the whole
 * aggregate and permanently degrade the check to a spurious "check failed".
 * The alias arm is a COALESCE-by-join (never an OR) so an atom whose exact slug
 * AND de-prefixed slug both exist cannot fan out.
 */
export function atomProvenanceDriftQuery(): string {
  return `WITH atom AS (
         SELECT a.source_id,
                -- managed atoms keep their provisional prefix for good (#5770)
                CASE WHEN a.frontmatter->>'managed_extraction' = 'true'
                     THEN regexp_replace(a.frontmatter->>'source_hash', '^pending:', '')
                     ELSE a.frontmatter->>'source_hash' END AS sh,
                -- NULL = slug-unbound: transcript-minted (source_path only) or
                -- pre-binding-era. \`ss IS NULL\` is THE predicate for that
                -- population everywhere below (#4799 / #4806).
                NULLIF(a.frontmatter->>'source_slug', '') AS ss,
                -- the verbatim passage the atom was distilled from; used by the
                -- read-time quote-status probe below, never rewritten here.
                NULLIF(a.frontmatter->>'source_quote', '') AS q,
                CASE WHEN a.frontmatter->>'extracted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                     THEN a.frontmatter->>'extracted_at' END AS ext
           FROM pages a
          WHERE a.type = 'atom'
            AND a.deleted_at IS NULL
            AND a.frontmatter->>'source_hash' IS NOT NULL
            -- in-flight marker written before an unmanaged extraction commits
            AND (a.frontmatter->>'source_hash' NOT LIKE 'pending:%' OR a.frontmatter->>'managed_extraction' = 'true')
       -- Lookup sets are built ONCE and joined (#4937). A correlated EXISTS in
       -- the SELECT list is not rewritten to a semi-join — Postgres re-runs it
       -- per atom over substring(content_hash), which no index serves, so the
       -- check went O(atoms x same-source pages) and blew health-check budgets.
       -- DISTINCT is load-bearing: duplicate live content_hash values are a
       -- real state and would otherwise fan one atom out into several rows.
       ), live_hashes AS MATERIALIZED (
         SELECT DISTINCT source_id, substring(content_hash from 1 for 16) AS sh
           FROM pages WHERE deleted_at IS NULL AND content_hash IS NOT NULL
       ), live_slugs AS MATERIALIZED (
         SELECT DISTINCT source_id, slug FROM pages
          WHERE deleted_at IS NULL AND type <> 'atom'
       ), drift AS (
         SELECT atom.*,
                -- a slug-unbound atom is never drift: its hash is over a file,
                -- not a page, so the page probe is meaningless (#4806)
                (atom.ss IS NOT NULL AND h.sh IS NULL) AS drifted,
                -- Exact slug, or the single de-prefixed arm per verified legacy
                -- rename — SAME source_id, and non-atom only (a source is a
                -- content page, never another atom). COALESCE-by-join, not an
                -- OR that could fan an atom out when both slugs exist.
                (s.slug IS NOT NULL OR sa.slug IS NOT NULL) AS src_alive
           FROM atom
           LEFT JOIN live_hashes h ON h.source_id = atom.source_id AND h.sh = atom.sh
           LEFT JOIN live_slugs  s ON s.source_id = atom.source_id AND s.slug = atom.ss
           LEFT JOIN live_slugs sa ON s.slug IS NULL AND atom.ss IS NOT NULL
                                  AND (${legacyAliasArms()})
                                  AND sa.source_id = atom.source_id
       )
       SELECT count(*) FILTER (WHERE ss IS NOT NULL) AS total,
              count(*) FILTER (WHERE ss IS NULL) AS slug_unbound,
              count(*) FILTER (WHERE drifted) AS drifted,
              count(*) FILTER (WHERE drifted AND src_alive) AS source_changed,
              -- drifted implies a slug binding, so "gone" is always a binding
              -- that failed to resolve — never a slug-unbound atom (#4799)
              count(*) FILTER (WHERE drifted AND NOT src_alive) AS source_gone,
              -- lexicographic min of ISO-shaped strings ≈ chronological min
              -- (oldest); informational only, never verdict-bearing
              min(ext) FILTER (WHERE drifted) AS oldest_ext,
              -- drifted, source-alive atoms that carry a quote: candidates for
              -- the READ-ONLY read-time quote probe (their frozen fields are
              -- passed back verbatim; nothing is written).
              COALESCE((SELECT json_agg(json_build_object(
                          'sourceId', source_id, 'sourceSlug', ss,
                          'sourceHash', sh, 'sourceQuote', q))
                          FROM drift WHERE drifted AND src_alive AND q IS NOT NULL), '[]'::json)
                AS quote_candidates
         FROM drift`;
}

export interface AtomQuoteProbeResult {
  /** -1 is the "probe failed" sentinel; >= 0 is a real count. */
  quotePresent: number;
  quoteProbe: 'folded' | 'none' | 'failed';
  quoteOrphaned: number | undefined;
}

/**
 * READ-ONLY read-time quote probe. Classifies each drifted-and-alive atom's
 * stored quote against its live source page using the shared grounding fold and
 * the single-prefix alias. It WRITES NOTHING: no source_hash rebind, no
 * frontmatter edit, no page_versions write. A "present" verdict means the
 * quoted passage persisted — it is not a claim that the atom is sound or that
 * its binding is restored. Degrades quietly (`quote_probe: 'failed'`) rather
 * than failing the whole check.
 */
export async function runAtomQuoteProbe(
  engine: BrainEngine,
  raw: unknown,
  sourceChanged: number,
): Promise<AtomQuoteProbeResult> {
  let quoteCandidates: AtomProvenanceRecord[] = [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      quoteCandidates = parsed.map((c) => {
        const rec = c as Record<string, unknown>;
        return {
          sourceId: String(rec.sourceId ?? ''),
          sourceSlug: typeof rec.sourceSlug === 'string' ? rec.sourceSlug : null,
          sourceHash: typeof rec.sourceHash === 'string' ? rec.sourceHash : null,
          sourceQuote: typeof rec.sourceQuote === 'string' ? rec.sourceQuote : null,
        };
      });
    }
  } catch { quoteCandidates = []; }

  if (sourceChanged <= 0 || quoteCandidates.length === 0) {
    return { quotePresent: 0, quoteProbe: 'none', quoteOrphaned: undefined };
  }
  try {
    const verdicts = await classifyAtomProvenanceRecords(engine, quoteCandidates, { assumeDrifted: true });
    const quotePresent = verdicts.filter((v) => v.status === 'quote_present_in_live_page').length;
    return { quotePresent, quoteProbe: 'folded', quoteOrphaned: Math.max(0, sourceChanged - quotePresent) };
  } catch {
    return { quotePresent: -1, quoteProbe: 'failed', quoteOrphaned: undefined };
  }
}
