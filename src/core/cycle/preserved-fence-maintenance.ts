/** Deterministic upkeep of existing derived facts documents, never atom mining.
 * A saved publication is a disposable projection, not an immutable original.
 * Refresh it from complete current originals through the existing versioned
 * writer before the STRICT completion transition. Concurrent edits still refuse;
 * no source hash, fact row, page body, or atom is rewritten to claim freshness.
 */
import type { BrainEngine } from '../engine.ts';
import { PRESERVED_FENCE_SOURCE, publishPreservedFencePublication } from '../facts/preserved-fence-store.ts';
import { completeSourceCycle } from './preserved-fence-completion.ts';

export async function refreshPreservedFencePublications(engine: BrainEngine, sourceId: string): Promise<{ inspected: number; refreshed: number }> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM raw_data rd JOIN pages p ON p.id = rd.page_id
     WHERE p.source_id = $1 AND rd.source = $2 ORDER BY p.slug`, [sourceId, PRESERVED_FENCE_SOURCE]);
  let refreshed = 0;
  for (const { slug } of rows) {
    // Explicit supersede is safe only here: plan from current originals, archive
    // the prior document, validate again under the existing writer transaction.
    const receipt = await publishPreservedFencePublication(engine, sourceId, slug, { allowSupersede: true });
    if (!receipt.published) throw new Error(`preserved_publication_refresh_failed: ${sourceId}/${slug}`);
    if (receipt.wrote) refreshed++;
  }
  return { inspected: rows.length, refreshed };
}

export async function maintainAndCompleteSourceCycle(engine: BrainEngine, sourceId: string, completedAt: string): Promise<void> {
  await refreshPreservedFencePublications(engine, sourceId);
  // Keep completion's original concurrency and all-or-nothing stamp guards.
  await completeSourceCycle(engine, sourceId, completedAt);
}
