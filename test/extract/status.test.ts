// v0.42 Wave D1 — extract status CLI unit tests.
//
// Pins:
//   - Sort order: halt_rate desc, cost desc — most-troubled first
//   - Non-verbose: top 5; verbose: all
//   - Empty rollup → "No extract events" message
//   - JSON envelope schema_version: 1
//   - halt_rate denominator = halts + completed + expected-limit caps, the
//     same formula doctor's extract_health reports (so CLI and doctor agree)

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  buildStatusReport,
  formatStatusTable,
  runExtractStatus,
  type ExtractStatusRow,
} from '../../src/commands/extract-status.ts';

const SAMPLE_ROWS = [
  {
    kind: 'facts.conversation',
    source_id: 'default',
    cost_7d_usd: 1.50,
    eval_pass_count: 5,
    eval_fail_count: 0,
    halt_count: 0,
    round_completed_count: 10,
    last_updated_at: '2026-05-27T14:00:00Z',
  },
  {
    kind: 'atoms',
    source_id: 'default',
    cost_7d_usd: 0.30,
    eval_pass_count: 3,
    eval_fail_count: 0,
    halt_count: 5,
    round_completed_count: 5,
    last_updated_at: '2026-05-27T13:00:00Z',
  },
  {
    kind: 'concepts',
    source_id: 'default',
    cost_7d_usd: 0.10,
    eval_pass_count: 1,
    eval_fail_count: 0,
    halt_count: 1,
    round_completed_count: 9,
    last_updated_at: '2026-05-27T12:00:00Z',
  },
];

describe('buildStatusReport — pure aggregation', () => {
  test('schema_version stamped', () => {
    const report = buildStatusReport([], {});
    expect(report.schema_version).toBe(1);
  });

  test('halt_rate computed correctly from halt + completed counts', () => {
    const report = buildStatusReport(SAMPLE_ROWS, {});
    const atoms = report.rows.find(r => r.kind === 'atoms')!;
    // 5 halts + 5 completed = 50% halt rate
    expect(atoms.halt_rate).toBe(0.5);
    const fc = report.rows.find(r => r.kind === 'facts.conversation')!;
    // 0 halts + 10 completed = 0% halt rate
    expect(fc.halt_rate).toBe(0);
  });

  test('sorts by halt_rate desc, then cost desc', () => {
    const report = buildStatusReport(SAMPLE_ROWS, {});
    // atoms (50% halt) should come first; then concepts (10%); then facts.conv (0%)
    expect(report.rows.map(r => r.kind)).toEqual(['atoms', 'concepts', 'facts.conversation']);
  });

  test('zero-completed + zero-halt rows have halt_rate 0 (not NaN)', () => {
    const report = buildStatusReport(
      [{
        kind: 'empty', source_id: 'default',
        cost_7d_usd: 0, eval_pass_count: 0, eval_fail_count: 0,
        halt_count: 0, round_completed_count: 0,
        last_updated_at: null,
      }],
      {},
    );
    expect(report.rows[0].halt_rate).toBe(0);
  });

  test('expected-limit caps join the denominator (6 halts / (6 + 3 + 33))', () => {
    const report = buildStatusReport(
      [{
        kind: 'atoms', source_id: 'default',
        cost_7d_usd: 0, eval_pass_count: 0, eval_fail_count: 0,
        halt_count: 6, round_completed_count: 3, expected_limit_count: 33,
        last_updated_at: null,
      }],
      {},
    );
    expect(report.rows[0].expected_limit_count).toBe(33);
    expect(report.rows[0].halt_rate).toBeCloseTo(6 / 42, 10);
  });

  test('expected-limit-only row (no halts, no completions) stays 0, not NaN', () => {
    const report = buildStatusReport(
      [{
        kind: 'atoms', source_id: 'default',
        cost_7d_usd: 0, eval_pass_count: 0, eval_fail_count: 0,
        halt_count: 0, round_completed_count: 0, expected_limit_count: 12,
        last_updated_at: null,
      }],
      {},
    );
    expect(report.rows[0].expected_limit_count).toBe(12);
    expect(report.rows[0].halt_rate).toBe(0);
  });

  test('all-zero counts keep denominator at zero (halt_rate 0)', () => {
    const report = buildStatusReport(
      [{
        kind: 'atoms', source_id: 'default',
        cost_7d_usd: 0, eval_pass_count: 0, eval_fail_count: 0,
        halt_count: 0, round_completed_count: 0, expected_limit_count: 0,
        last_updated_at: null,
      }],
      {},
    );
    expect(report.rows[0].halt_rate).toBe(0);
  });

  test('absent expected_limit_count (pre-v141 row) reads as 0', () => {
    const report = buildStatusReport(SAMPLE_ROWS, {});
    const atoms = report.rows.find(r => r.kind === 'atoms')!;
    expect(atoms.expected_limit_count).toBe(0);
    // 5 halts + 5 completed, unchanged when the column is absent
    expect(atoms.halt_rate).toBe(0.5);
  });

  test('coerces string-typed counts (postgres returns SUM() as string)', () => {
    const report = buildStatusReport(
      [{
        kind: 'atoms', source_id: 'default',
        cost_7d_usd: '0.50' as unknown as number,
        eval_pass_count: '3' as unknown as number,
        eval_fail_count: '0' as unknown as number,
        halt_count: '2' as unknown as number,
        round_completed_count: '8' as unknown as number,
        last_updated_at: null,
      }],
      {},
    );
    expect(report.rows[0].cost_7d_usd).toBe(0.5);
    expect(report.rows[0].halt_count).toBe(2);
    expect(report.rows[0].halt_rate).toBe(0.2);
  });

  test('last_updated_at coerces to ISO string (engine returns Date)', () => {
    const dateObj = new Date('2026-05-27T10:00:00.000Z');
    const report = buildStatusReport(
      [{
        kind: 'atoms', source_id: 'default',
        cost_7d_usd: 0, eval_pass_count: 0, eval_fail_count: 0,
        halt_count: 0, round_completed_count: 1,
        last_updated_at: dateObj,
      }],
      {},
    );
    expect(report.rows[0].last_updated_at).toBe('2026-05-27T10:00:00.000Z');
  });

  test('null last_updated_at stays null', () => {
    const report = buildStatusReport(
      [{
        kind: 'a', source_id: 'b',
        cost_7d_usd: 0, eval_pass_count: 0, eval_fail_count: 0,
        halt_count: 0, round_completed_count: 0,
        last_updated_at: null,
      }],
      {},
    );
    expect(report.rows[0].last_updated_at).toBeNull();
  });

  test('filters propagated', () => {
    const report = buildStatusReport(SAMPLE_ROWS, {
      source_id: 'media-corpus',
      kind: 'atoms',
    });
    expect(report.filters.source_id).toBe('media-corpus');
    expect(report.filters.kind).toBe('atoms');
  });
});

describe('formatStatusTable — human output', () => {
  test('empty rows returns informative message', () => {
    const report = buildStatusReport([], {});
    expect(formatStatusTable(report, false)).toContain('No extract events');
  });

  test('empty with filters mentions the filters', () => {
    const report = buildStatusReport([], { source_id: 'media', kind: 'atoms' });
    const out = formatStatusTable(report, false);
    expect(out).toContain('source=media');
    expect(out).toContain('kind=atoms');
  });

  test('header row contains expected columns', () => {
    const report = buildStatusReport(SAMPLE_ROWS, {});
    const out = formatStatusTable(report, true);
    expect(out).toContain('KIND');
    expect(out).toContain('SOURCE');
    expect(out).toContain('COST_7D_USD');
    expect(out).toContain('HALT_RATE');
    expect(out).toContain('CAP_STOPS');
  });

  test('non-verbose truncates to top 5 with "more rows" hint', () => {
    const manyRows: ExtractStatusRow[] = Array.from({ length: 8 }, (_, i) => ({
      kind: `kind${i}`,
      source_id: 'default',
      cost_7d_usd: 0,
      eval_pass_count: 0,
      eval_fail_count: 0,
      halt_count: 0,
      round_completed_count: 1,
      expected_limit_count: 0,
      halt_rate: 0,
      last_updated_at: null,
    }));
    const report = {
      schema_version: 1 as const,
      rows: manyRows,
      filters: {},
    };
    const out = formatStatusTable(report, false);
    expect(out).toContain('kind0');
    expect(out).toContain('kind4');
    expect(out).not.toContain('kind5'); // truncated
    expect(out).toContain('+3 more rows');
  });

  test('verbose shows all rows', () => {
    const manyRows: ExtractStatusRow[] = Array.from({ length: 8 }, (_, i) => ({
      kind: `kind${i}`,
      source_id: 'default',
      cost_7d_usd: 0,
      eval_pass_count: 0,
      eval_fail_count: 0,
      halt_count: 0,
      round_completed_count: 1,
      expected_limit_count: 0,
      halt_rate: 0,
      last_updated_at: null,
    }));
    const report = {
      schema_version: 1 as const,
      rows: manyRows,
      filters: {},
    };
    const out = formatStatusTable(report, true);
    expect(out).toContain('kind7');
    expect(out).not.toContain('more rows');
  });
});

// The bug this pins: the CLI's SQL never selected expected_limit_count, so a
// brain that stopped runs at budget/deadline caps (successful partial progress)
// read e.g. 66.7% here while doctor read 14.3% from identical rows.
describe('runExtractStatus — SQL parity with doctor', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('DELETE FROM extract_rollup_7d');
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d
         (kind, source_id, day, cost_usd, eval_pass_count, eval_fail_count,
          halt_count, round_completed_count, expected_limit_count, rollup_write_failures, updated_at)
       VALUES ('atoms', 'default', CURRENT_DATE, 0.25, 0, 0, 6, 3, 33, 0, NOW())`,
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  async function statusJson(args: string[]): Promise<Record<string, any>> {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      await runExtractStatus(engine, args);
    } finally {
      console.log = original;
    }
    return JSON.parse(logs.join('\n'));
  }

  test('--json reports the cap count and the doctor halt rate', async () => {
    const report = await statusJson(['--json']);
    expect(report.schema_version).toBe(1);
    expect(report.rows[0].expected_limit_count).toBe(33);
    expect(report.rows[0].halt_count).toBe(6);
    expect(report.rows[0].halt_rate).toBeCloseTo(6 / (6 + 3 + 33), 10);
  });

  test('pre-v141 brain (no expected_limit_count column) still reports, caps as 0', async () => {
    await engine.executeRaw('ALTER TABLE extract_rollup_7d DROP COLUMN expected_limit_count');
    const report = await statusJson(['--json']);
    expect(report.rows[0].expected_limit_count).toBe(0);
    expect(report.rows[0].halt_rate).toBeCloseTo(6 / (6 + 3), 10);
  });
});
