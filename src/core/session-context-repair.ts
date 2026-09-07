/**
 * #4166 — session_context_state schema-drift self-heal (missing-table class).
 *
 * Migration v126 (`session_context_state`) creates the per-session ambient-
 * recall cursor table; migration v132 adds the `checkpoint_manifest` column
 * and migration v127 adds the surface columns. `runMigrations` stamps the
 * version ledger AFTER each migration's SQL+handler succeed, and skips every
 * migration whose version is already <= the recorded counter — so a brain
 * whose LEGACY migration taillength diverged from the merged-numbering tail
 * can be stamped AHEAD of v126 with v126's DDL never having run.
 *
 * Concrete incident (local-merge dryrun, 2026-09-06): the pre-upgrade release
 * numbered `extract_rollup_7d_controlled_partial_count` / `reclassify_...`
 * as v126/v127 and shipped NO session_context_state table. The upgrade to the
 * merged numbering shipped v126 = session_context_state (increasing the tail
 * to v147). The victim brain sat at config.version = 127, so `runMigrations`
 * skipped v126/v127 and applied 128→147; the first post-126 migration to
 * touch the table, v132 (`ALTER TABLE session_context_state ADD COLUMN
 * checkpoint_manifest`), died with `relation "session_context_state" does not
 * exist` and blocked the whole upgrade. This is the SAME drift class #2038
 * documents for the renumbered v102 index: the version counter cannot see it
 * (the affected brain is stamped AHEAD of the missing migration), so the heal
 * is keyed off the table's actual presence and runs on every migrate pass.
 *
 * Idempotent: a no-op when the table already exists. Recreates the FULL
 * current canonical shape (v126 base columns + the v132 checkpoint_manifest
 * column + the v126 updated_at index) so a brain stamped at or past v132 ends
 * with a shape consistent with what v126+v132 would have produced — the two
 * migrations are idempotent (IF NOT EXISTS), so re-running them later is a
 * no-op. Keep the DDL in sync with src/schema.sql, src/core/pglite-schema.ts,
 * and the v126/v132 migrations in src/core/migrate.ts.
 */

import type { BrainEngine } from './engine.ts';

/**
 * The version under which session_context_state was introduced in the CURRENT
 * (merged) numbering. A brain at >= this version is stamped past v126's DDL
 * slot, so a missing table is a drift to heal; a brain below it is a normal
 * pre-v126 brain whose migration chain will create the table.
 */
const SESSION_CONTEXT_VERSION = 126;

// One statement per executeRaw call — PGLite prepares single statements and
// rejects multi-command SQL. Kept in sync with v126/v132 in migrate.ts.
const CREATE_SESSION_CONTEXT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_context_state (
    source_id         TEXT NOT NULL,
    client_id         TEXT NOT NULL DEFAULT 'local',
    session_id        TEXT NOT NULL,
    standing_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
    surfaced_slugs    JSONB NOT NULL DEFAULT '[]'::jsonb,
    checkpoint_manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_wake_at      TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, client_id, session_id)
  );
`;

const CREATE_SESSION_CONTEXT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS session_context_state_updated_idx
    ON session_context_state (updated_at);
`;

export interface SessionContextStatus {
  /** The session_context_state table exists. */
  tablePresent: boolean;
  /** The table is missing AND the ledger is stamped at/after the v126 slot. */
  needsRepair: boolean;
}

export interface SessionContextRepairResult {
  repaired: boolean;
  reason: 'already_present' | 'below_v126' | 'recreated';
}

/** Detect the drift: table absent while the ledger is stamped >= v126. */
export async function checkSessionContextStateTable(
  engine: BrainEngine,
): Promise<SessionContextStatus> {
  const rows = await engine.executeRaw<{ reg: string | null }>(
    `SELECT to_regclass('session_context_state')::text AS reg`,
  );
  const tablePresent = !!rows[0]?.reg;
  if (tablePresent) {
    return { tablePresent, needsRepair: false };
  }
  const v = parseInt((await engine.getConfig('version')) || '1', 10);
  // The version counter skips migrations <= current, so a non-existent table
  // on a ledger at/after v126 means v126's DDL was skipped (renumber drift).
  return { tablePresent, needsRepair: v >= SESSION_CONTEXT_VERSION };
}

/** Heal the drift: recreate the missing table to the full canonical shape. */
export async function repairSessionContextStateTable(
  engine: BrainEngine,
): Promise<SessionContextRepairResult> {
  const status = await checkSessionContextStateTable(engine);
  if (status.tablePresent) {
    return { repaired: false, reason: 'already_present' };
  }
  if (!status.needsRepair) {
    return { repaired: false, reason: 'below_v126' };
  }
  await engine.executeRaw(CREATE_SESSION_CONTEXT_TABLE_SQL);
  await engine.executeRaw(CREATE_SESSION_CONTEXT_INDEX_SQL);
  return { repaired: true, reason: 'recreated' };
}
