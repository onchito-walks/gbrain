// v0.42 — Rollup-writer unit tests (v126 EXTRACT-HEALTH extension).
//
// Pins:
//   - controlled_partial_delta increments controlled_partial_count (the new
//     v126 column) independently of halt_count — a --max-runtime-minutes
//     CONTROLLED partial completion is capacity/progress, not a halt.
//   - halt_delta still increments halt_count (true unexpected halts continue
//     to drive doctor's halt_rate).
//   - Both counters persist across UPSERTs (PK kind+source_id+day) and are
//     readable back so the doctor check and `gbrain extract status` see them.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { upsertExtractRollup } from '../../src/core/extract/rollup-writer.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function row(kind = 'facts.conversation', source = 'default', day = 'CURRENT_DATE') {
  const rows = await engine.executeRaw<{
    halt_count: number;
    controlled_partial_count: number;
    round_completed_count: number;
  }>(
    `SELECT halt_count, controlled_partial_count, round_completed_count
       FROM extract_rollup_7d
      WHERE kind = $1 AND source_id = $2 AND day = ${day}`,
    [kind, source],
  );
  return rows;
}

describe('upsertExtractRollup — controlled partials vs halts', () => {
  test('controlled_partial_delta lands in controlled_partial_count, not halt_count', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d', []);
    const r = await upsertExtractRollup(engine, {
      kind: 'facts.conversation',
      source_id: 'default',
      controlled_partial_delta: 1,
      halt_delta: 0,
      round_completed_delta: 0,
      cost_delta: 0.1,
    });
    expect(r.ok).toBe(true);
    const rows = await row();
    expect(rows).toHaveLength(1);
    expect(rows[0].halt_count).toBe(0);
    expect(rows[0].controlled_partial_count).toBe(1);
    expect(rows[0].round_completed_count).toBe(0);
  });

  test('true halt_delta still increments halt_count (unchanged accounting)', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d', []);
    await upsertExtractRollup(engine, {
      kind: 'facts.conversation',
      source_id: 'default',
      halt_delta: 1,
    });
    const rows = await row();
    expect(rows[0].halt_count).toBe(1);
    expect(rows[0].controlled_partial_count).toBe(0);
  });

  test('controlled + halo both counters aggregate across UPSERTs on same PK', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d', []);
    // Two controlled partials + one true halt + one completed round.
    await upsertExtractRollup(engine, { kind: 'k', source_id: 's', controlled_partial_delta: 1 });
    await upsertExtractRollup(engine, { kind: 'k', source_id: 's', controlled_partial_delta: 1 });
    await upsertExtractRollup(engine, { kind: 'k', source_id: 's', halt_delta: 1 });
    await upsertExtractRollup(engine, { kind: 'k', source_id: 's', round_completed_delta: 1 });
    const rows = await row('k', 's');
    expect(rows[0].controlled_partial_count).toBe(2);
    expect(rows[0].halt_count).toBe(1);
    expect(rows[0].round_completed_count).toBe(1);
  });

  test('defaults to zero when no deltas supplied', async () => {
    await engine.executeRaw('DELETE FROM extract_rollup_7d', []);
    await upsertExtractRollup(engine, { kind: 'k2', source_id: 's' });
    const rows = await row('k2', 's');
    expect(rows[0].halt_count).toBe(0);
    expect(rows[0].controlled_partial_count).toBe(0);
    expect(rows[0].round_completed_count).toBe(0);
  });
});