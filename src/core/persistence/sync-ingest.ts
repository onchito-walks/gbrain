import type { BrainEngine } from '../engine.ts';
import type { WriteRequest } from './model.ts';
import type { SyncIntent } from './sync-prepare.ts';

/** The cursor fields the checkpoint already reads while it holds the row locked. */
export interface ManagedSyncIngestCursor {
  done?: boolean;
  sourceId: string;
  incarnation: string;
  runId: string;
  root: string;
  from: string | null;
  target: string;
  counts: { added: number; modified: number; deleted: number; renamed?: number; chunks: number };
}

/**
 * Records the ingest receipt of a finished managed import, in the transaction that
 * marks its checkpoint done, so the receipt and `done` commit or roll back together.
 *
 * The changed slugs come from the run's own committed page receipts, deduplicated by
 * entry index: that is the set the cursor counted, not the discovery manifest (which
 * also lists holds, waivers and no-op entries). Nothing is written when the run
 * changed no page, and nothing is written when the receipts no longer prove an exact
 * set (a run whose receipts outlived the retention window) — an approximate receipt
 * would be worse than none. A refused receipt never fails the sync: the checkpoint
 * has already validated its own receipt completeness.
 */
export async function logManagedSyncIngest(tx: BrainEngine, row: WriteRequest, intent: SyncIntent, cursor: ManagedSyncIngestCursor): Promise<void> {
  if (cursor.done) return;
  if (cursor.sourceId !== row.source_id || cursor.incarnation !== row.source_incarnation || cursor.runId !== intent.runId) return;
  const counts = cursor.counts;
  const changed = counts.added + counts.modified + counts.deleted + (counts.renamed ?? 0);
  if (!changed) return;
  const published = await tx.executeRaw<{ slug: string }>(`SELECT DISTINCT ON (intent->>'index') slug FROM persistence_requests
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND state='committed'
    AND intent->>'runId'=$3 AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete')
    AND outcome->>'noop' IS DISTINCT FROM 'true'
    ORDER BY intent->>'index', sequence DESC`, [row.source_id, row.source_incarnation, cursor.runId]);
  if (published.length !== changed) return;
  await tx.logIngest({ source_id: row.source_id, source_type: 'git_sync',
    source_ref: `${cursor.root} @ ${cursor.from ?? '(initial)'}..${cursor.target}`,
    pages_updated: [...new Set(published.map(receipt => receipt.slug))].sort(),
    summary: `Sync: +${counts.added} ~${counts.modified} -${counts.deleted} R${counts.renamed ?? 0}, ${counts.chunks} chunks`,
  });
}
