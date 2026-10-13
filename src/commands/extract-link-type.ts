/**
 * Directory-based link-type inference for the fs-source path.
 *
 * FS-source operates without a BrainEngine. We have paths, not pages. This
 * helper looks at source + target directories and returns a type aligned
 * with the canonical `inferLinkType` in link-extraction.ts (calibrated
 * verb-based inference for db-source).
 *
 * v0.13: aligned type names with link-extraction.ts (was: 'mention' →
 * 'mentions', 'attendee' → 'attended'). Diverged historically; the v0_13_0
 * migration normalizes any legacy rows on existing brains.
 */
export function inferTypeByDir(fromDir: string, toDir: string, frontmatter?: Record<string, unknown>): string {
  const from = fromDir.split('/')[0];
  const to = toDir.split('/')[0];
  if (from === 'people' && to === 'companies') {
    if (Array.isArray(frontmatter?.founded)) return 'founded';
    // #3466: bare people/ -> companies/ adjacency is not evidence of
    // employment, so it gets the neutral 'mentions' verb instead of
    // 'works_at'. Real works_at edges still come from the two paths that
    // read actual evidence: the company:/companies: frontmatter fields
    // (FRONTMATTER_LINK_MAP) and employment phrasing in prose
    // (inferLinkType in link-extraction.ts).
    return 'mentions';
  }
  if (from === 'people' && to === 'deals') return 'involved_in';
  if (from === 'deals' && to === 'companies') return 'deal_for';
  return 'mentions';
}
