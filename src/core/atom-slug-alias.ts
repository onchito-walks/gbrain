/**
 * Verified legacy source-slug renames — the single allow-list of OLD root
 * prefixes that a frozen `source_slug` may still carry after a whole-vault
 * reorganisation.
 *
 * The historical `hermes-moncho/` → root rename moved thousands of pages from
 * `hermes-moncho/<path>` to `<path>`. Atoms extracted before the rename kept a
 * FROZEN `frontmatter.source_slug` pointing at the old, now-absent slug while
 * the live source page sits at the de-prefixed slug. Any read that keys page
 * identity on an exact `slug = source_slug` match therefore misjudges those
 * atoms as source-gone.
 *
 * Deliberately a small, code-reviewed allow-list rather than config/env, so the
 * resolution surface can never be widened from the outside; and PREFIX-ONLY (no
 * basename or similarity matching), because a rename that moved a whole subtree
 * keeps the relative path intact, so `<prefix><X>` maps unambiguously to `<X>`
 * and can never be confused with an unrelated, similarly named page in another
 * subtree or source. Callers MUST still isolate by `source_id` — the alias only
 * rewrites the slug; it never crosses a source boundary.
 *
 * This is the ONE definition; `core/search/sql-ranking.ts` (the covered-atom
 * retrieval policy) re-exports it so the classification and the retrieval
 * predicate can never drift apart.
 */
export const LEGACY_SOURCE_SLUG_PREFIXES: readonly string[] = ['hermes-moncho/'];

/**
 * De-prefixed alias for a frozen source slug, or `null` when the slug carries
 * no verified legacy prefix. Prefix-only: at most the leading allow-listed
 * segment is stripped, never a basename or fuzzy match.
 */
export function aliasSourceSlug(slug: string): string | null {
  for (const prefix of LEGACY_SOURCE_SLUG_PREFIXES) {
    if (slug.startsWith(prefix) && slug.length > prefix.length) {
      return slug.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Candidate live slugs for a frozen `source_slug`: the exact slug first, then
 * one de-prefixed alias arm per matching verified rename. Mirrors the arms
 * `buildCoveredAtomExclusionClause` builds, so page resolution means the same
 * thing in retrieval and in provenance classification.
 */
export function sourceSlugCandidates(slug: string): string[] {
  const out = [slug];
  for (const prefix of LEGACY_SOURCE_SLUG_PREFIXES) {
    if (slug.startsWith(prefix) && slug.length > prefix.length) {
      out.push(slug.slice(prefix.length));
    }
  }
  return out;
}
