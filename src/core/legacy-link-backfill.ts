import type { BrainEngine } from './engine.ts';
import { derivedLinkRows, DerivedLinkEndpointChangedError, DerivedLinkSettingsChangedError, type DerivedLinkBatchItem } from './derived-links.ts';
import { assertPageRevision } from './page-state/types.ts';
import { pageSnapshotKey } from './page-snapshot-batch.ts';
import { LINK_EXTRACTION_GENERATION_KEY } from './line-grammar.ts';
import { executeRawJsonb } from './sql-query.ts';
import { primeRelationSemantics } from './link-semantics-pack.ts';

/**
 * Historical migrations are additive backfills, not reconciliation. Preserve
 * every existing link verbatim (including unknown origins and deleted-endpoint
 * evidence). Only newly extracted rows receive the origin proved by the current
 * page. Native uniqueness deduplicates attributed siblings without coalescing
 * historical row IDs or changing their producer/context. Ordinary replacement
 * still refuses unknown frontmatter provenance.
 *
 * No projection watermark is stamped: this does not certify reconciliation.
 * Fail the whole batch on stale pages/endpoints/settings; never report a skipped
 * migration page as complete. The migration ledger can safely retry a committed
 * batch because addLinksBatch uses ON CONFLICT DO NOTHING.
 */
export async function backfillDerivedLinksBatch(engine: Pick<BrainEngine, 'transaction'>,
  items: readonly DerivedLinkBatchItem[]): Promise<Array<{ created: number; removed: number }>> {
  if (!items.length) return [];
  const prepared = items.map(item => ({ ...item, ...derivedLinkRows(item.origin, item.links, item.opts ?? {}) }));
  return engine.transaction(async tx => {
    await primeRelationSemantics(tx);
    await tx.lockPageKeys(prepared.flatMap(({ origin, rows }) => [
      { sourceId: origin.sourceId, slug: origin.slug },
      ...rows.flatMap(row => [{ sourceId: row.from_source_id!, slug: row.from_slug },
        { sourceId: row.to_source_id!, slug: row.to_slug }]),
    ]));
    const generation = (await tx.executeRaw<{ value: string }>(
      'SELECT value FROM config WHERE key=$1 FOR SHARE', [LINK_EXTRACTION_GENERATION_KEY]))[0]?.value ?? null;
    if (prepared.some(item => item.opts?.lineGrammar && item.opts.lineGrammar.generation !== generation)) {
      throw new DerivedLinkSettingsChangedError();
    }
    const { snapshots } = await tx.readPageSnapshotsBatch(prepared.map(({ origin }) => ({ slug: origin.slug, sourceId: origin.sourceId })),
      { maxBytes: Number.MAX_SAFE_INTEGER });
    const results: Array<{ created: number; removed: number }> = [];
    for (const { origin, rows, opts } of prepared) {
      const snapshot = snapshots.get(pageSnapshotKey(origin.sourceId, origin.slug)) ?? null;
      assertPageRevision(snapshot, { expectedRevision: origin.expectedRevision });
      if (!snapshot || snapshot.sourceIncarnation !== origin.sourceIncarnation || snapshot.page.deleted_at) {
        throw new DerivedLinkEndpointChangedError('Migration link origin changed or was deleted');
      }
      const endpoints = rows.flatMap(row => [{ slug: row.from_slug, sourceId: row.from_source_id! },
        { slug: row.to_slug, sourceId: row.to_source_id! }]);
      const missing = await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
        AS v(slug text, "sourceId" text) LEFT JOIN pages p ON p.slug=v.slug AND p.source_id=v."sourceId" AND p.deleted_at IS NULL
        WHERE p.id IS NULL LIMIT 1`, [], [{ rows: endpoints }]);
      const changed = opts?.expectedEndpoints?.length ? await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
        AS v(slug text, "sourceId" text, revision text) LEFT JOIN pages p ON p.slug=v.slug AND p.source_id=v."sourceId" AND p.deleted_at IS NULL
        WHERE p.id IS NULL OR p.knowledge_revision::text <> v.revision LIMIT 1`, [], [{ rows: opts.expectedEndpoints }]) : [];
      if (missing.length || changed.length) throw new DerivedLinkEndpointChangedError('Migration link endpoint changed or was deleted');
      const reversed = rows.filter(row => row.link_type === 'attended' && row.to_slug === origin.slug
        && row.to_source_id === origin.sourceId && (row.from_slug !== origin.slug || row.from_source_id !== origin.sourceId));
      if (reversed.length) {
        if (snapshot.page.type !== 'meeting' || reversed.some(row => row.link_source !== 'frontmatter'
          && !opts?.expectedEndpoints?.some(endpoint => endpoint.slug === row.from_slug && endpoint.sourceId === row.from_source_id))) {
          throw new TypeError('Canonical attendance requires a meeting origin and revision-bound person endpoints');
        }
        const invalid = await executeRawJsonb(tx, `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows')
          AS v(from_slug text, from_source_id text) JOIN pages p ON p.slug=v.from_slug AND p.source_id=v.from_source_id
          WHERE p.type <> 'person' LIMIT 1`, [], [{ rows: reversed }]);
        if (invalid.length) throw new TypeError('Canonical attendance requires person endpoints');
      }
      results.push({ created: rows.length ? await tx.addLinksBatch(rows, { auditSite: 'addLinksBatch' }) : 0, removed: 0 });
    }
    return results;
  });
}
