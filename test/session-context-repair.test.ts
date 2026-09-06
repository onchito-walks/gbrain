/**
 * #4166 — missing session_context_state self-heal.
 *
 * A brain upgraded from a release whose migration taillength numbered
 * LOCAL migrations as v126/v127 (e.g. extract_rollup_* / reclassify_*) and
 * shipped no session_context_state table ends up stamped at/after v126 with
 * the table never created. The version counter skips v126/v127 on the merged
 * numbering, and v132 (`ALTER TABLE session_context_state ...`) dies with
 * `relation "session_context_state" does not exist`. The heal is keyed off
 * the table's actual presence (like the #2038 index repair) and recreates the
 * FULL canonical shape (v126 columns + v132 checkpoint_manifest + updated_at
 * index) on every migrate pass.
 *
 * Pinned contracts:
 * 1. checkSessionContextStateTable flags drift only when the table is absent
 *    AND the ledger is stamped >= 126 (below 126 = normal pre-v126 brain).
 * 2. repairSessionContextStateTable recreates the full canonical shape —
 *    columns, PK, defaults, and the updated_at index.
 * 3. runMigrations on a drifted brain (version stamped past the missing
 *    migration) heals first, then completes the pending chain — the exact
 *    production shape behind the 0.42.72.1 → 0.48.2.0 upgrade blocker.
 * 4. A fully-stamped (nothing pending) drifted brain still heals on the
 *    no-pending pass (runMigrations early-returns AFTER the repair block).
 * 5. Idempotent: second repair is a no-op.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import {
  checkSessionContextStateTable,
  repairSessionContextStateTable,
} from '../src/core/session-context-repair.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

/** Simulate the drift: drop the table entirely (index dies with it). */
async function dropSessionContextTable(): Promise<void> {
  await engine.executeRaw(`DROP TABLE IF EXISTS session_context_state`);
}

async function tableExists(): Promise<boolean> {
  const rows = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('session_context_state')::text AS reg`,
  );
  return !!rows[0]?.reg;
}

/** Capture columns (ordered by name — additive columns reorder legitimately). */
async function captureColumns(): Promise<string[]> {
  const rows = await engine.executeRaw<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'session_context_state'
      ORDER BY column_name`,
  );
  return rows.map(r => r.column_name);
}

describe('session_context_state drift detection', () => {
  test('absent table + ledger at 127 (the incident state) → needsRepair', async () => {
    await dropSessionContextTable();
    await engine.setConfig('version', '127');
    const status = await checkSessionContextStateTable(engine);
    expect(status.tablePresent).toBe(false);
    expect(status.needsRepair).toBe(true);
  });

  test('absent table + ledger below v126 → NOT a drift (normal pre-v126 brain)', async () => {
    await dropSessionContextTable();
    await engine.setConfig('version', '124');
    const status = await checkSessionContextStateTable(engine);
    expect(status.tablePresent).toBe(false);
    expect(status.needsRepair).toBe(false);
    await repairSessionContextStateTable(engine); // must NOT pre-create
    expect(await tableExists()).toBe(false);
  });

  test('present table → never a drift', async () => {
    // Restore via the migration chain (v126..) from the below-v126 state.
    await engine.setConfig('version', '125');
    await runMigrations(engine);
    expect(await tableExists()).toBe(true);
    const status = await checkSessionContextStateTable(engine);
    expect(status.tablePresent).toBe(true);
    expect(status.needsRepair).toBe(false);
  });
});

describe('repair recreates the full canonical shape', () => {
  test('recreates v126 base + v132 checkpoint_manifest column + index', async () => {
    await dropSessionContextTable();
    await engine.setConfig('version', '127');

    const res = await repairSessionContextStateTable(engine);
    expect(res.repaired).toBe(true);
    expect(res.reason).toBe('recreated');
    expect(await tableExists()).toBe(true);

    expect(await captureColumns()).toEqual([
      'checkpoint_manifest', // v132 — a brain stamped >= 132 must end shape-consistent
      'client_id',
      'last_wake_at',
      'session_id',
      'source_id',
      'standing_entities',
      'surfaced_slugs',
      'updated_at',
    ]);
    const pks = await engine.executeRaw<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_name = tc.table_name
        WHERE tc.table_name = 'session_context_state'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position`,
    );
    expect(pks.map(r => r.column_name)).toEqual(['source_id', 'client_id', 'session_id']);
    const idx = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'session_context_state'
          AND indexname = 'session_context_state_updated_idx'`,
    );
    expect(idx.length).toBe(1);
  });

  test('idempotent — second repair is a no-op', async () => {
    const second = await repairSessionContextStateTable(engine);
    expect(second.repaired).toBe(false);
    expect(second.reason).toBe('already_present');
  });
});

describe('runMigrations heals the drifted brain end-to-end', () => {
  test('incident shape: version 127 + missing table → heal then apply to LATEST', async () => {
    await dropSessionContextTable();
    await engine.setConfig('version', '127');

    // Before the heal this exact state failed upstream with
    // `relation "session_context_state" does not exist` inside v132.
    const res = await runMigrations(engine);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await tableExists()).toBe(true);

    // The table carries the full post-v132 shape (v132's ALTER ran as no-op
    // on the recreated table; the checkpoint_manifest column is present).
    const cols = await captureColumns();
    expect(cols).toContain('checkpoint_manifest');
    expect(cols).toContain('surfaced_slugs');
    expect(res.applied).toBeGreaterThanOrEqual(1);
  }, 60000);

  test('fully-stamped drifted brain (nothing pending) still heals', async () => {
    await dropSessionContextTable();
    await engine.setConfig('version', String(LATEST_VERSION));

    // No pending work, but the repair block runs BEFORE the no-pending early
    // return — a brain stamped to the top with a missing table self-heals on
    // the next migrate pass (the exact live-brain shape post-blocker).
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
    expect(await tableExists()).toBe(true);
  }, 60000);

  test('healthy brain: no-op, 0 applied, table untouched', async () => {
    await engine.executeRaw(`DELETE FROM session_context_state`);
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
    expect(await tableExists()).toBe(true);
  }, 60000);
});