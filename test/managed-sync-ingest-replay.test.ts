import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import type { SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { logManagedSyncIngest, type ManagedSyncIngestCursor } from '../src/core/persistence/sync-ingest.ts';

const cursor: ManagedSyncIngestCursor = { sourceId: 'notes', incarnation: 'incarnation', runId: 'run', root: '/example/notes', from: 'before', target: 'after',
  counts: { added: 1, modified: 0, deleted: 0, chunks: 1 } };
const row = { source_id: 'notes', source_incarnation: 'incarnation' } as WriteRequest;
const intent = { runId: 'run' } as SyncIntent;

test('a finished checkpoint replays no receipt and an unchanged run writes none', async () => {
  let writes = 0;
  const tx = { executeRaw: async () => [{ slug: 'one' }], logIngest: async () => { writes++; } } as unknown as BrainEngine;
  await logManagedSyncIngest(tx, row, intent, { ...cursor, done: true });
  await logManagedSyncIngest(tx, row, intent, { ...cursor, counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } });
  expect(writes).toBe(0);
});

test('a receipt never carries a foreign source, source incarnation or run', async () => {
  let writes = 0;
  const tx = { executeRaw: async () => [{ slug: 'one' }], logIngest: async () => { writes++; } } as unknown as BrainEngine;
  for (const other of [{ sourceId: 'other' }, { incarnation: 'other' }, { runId: 'other' }]) await logManagedSyncIngest(tx, row, intent, { ...cursor, ...other });
  expect(writes).toBe(0);
});

test('receipts that no longer prove the exact changed set write nothing instead of an approximation', async () => {
  let writes = 0;
  // Two pages changed, one surviving committed receipt: the set cannot be proven.
  const tx = { executeRaw: async () => [{ slug: 'one' }], logIngest: async () => { writes++; } } as unknown as BrainEngine;
  await logManagedSyncIngest(tx, row, intent, { ...cursor, counts: { added: 2, modified: 0, deleted: 0, chunks: 2 } });
  expect(writes).toBe(0);
});

test('the exact committed set is written once, scoped to the source and covers renames', async () => {
  const written: Array<Record<string, unknown>> = [];
  const tx = { executeRaw: async () => [{ slug: 'b' }, { slug: 'renamed' }],
    logIngest: async (entry: Record<string, unknown>) => { written.push(entry); } } as unknown as BrainEngine;
  await logManagedSyncIngest(tx, row, intent, { ...cursor, counts: { added: 0, modified: 0, deleted: 1, renamed: 1, chunks: 2 } });
  expect(written).toEqual([{ source_id: 'notes', source_type: 'git_sync', source_ref: '/example/notes @ before..after',
    pages_updated: ['b', 'renamed'], summary: 'Sync: +0 ~0 -1 R1, 2 chunks' }]);
});
