/**
 * v0.32.2 facts/fence DRIFT regressions (the `verify: 19 pages drifted` class).
 *
 * The run99/run100 rehearsal reproduced a real, non-isolation defect: on a
 * long-lived brain whose runtime already stamps fences, phase C compared
 * unlike sets and every page whose fence legitimately carries conversation
 * facts was reported as drifted, while rows whose fence position the markdown
 * had lost were never re-published.
 *
 * These regressions pin, on a real PGLite schema and a real temp filesystem:
 *   - FIX A: conversation-miner (`cli:`) rows are excluded on BOTH sides, so a
 *     page whose file and database agree verifies complete — and a genuinely
 *     unindexed fence row still fails by name and number (the gate is not
 *     weakened);
 *   - FIX B: the backfill re-publishes a row whose fence position the markdown
 *     lost, under that same position, keeping its id, position and text (and
 *     creating the missing `## Facts` section when the page has none);
 *   - a position the fence already occupies moves the row to the next free
 *     number instead of dropping it, and the occupied position stays visible
 *     as drift rather than being silently blessed;
 *   - the `extract_facts` reconcile keeps its own walk: it does NOT select a
 *     fence-owned row the page no longer lists (that split is what keeps the
 *     runtime's retire semantics intact).
 *
 * Engine injected via __setTestEngineOverride (no configured brain needed).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import { planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { parseFactsFence, replaceOrInsertFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';

const SLUG = 'people/alice-example';
const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const BASE = process.env.GBRAIN_TEST_FACTS_PAIRING_BASE ?? '/tmp';
const CLI = 'cli:extract-conversation-facts';

let engine: PGLiteEngine;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
});

beforeEach(async () => {
  root = mkdtempSync(join(BASE, 'facts-drift-'));
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [root]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fenceRow = (rowNum: number, claim: string, source = 'mcp:put_page'): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
  validFrom: '2026-01-01', source, active: true,
});

async function indexPage(body = '# Alice Example\n'): Promise<void> {
  await engine.putPage(SLUG, {
    type: 'person', title: 'Alice Example', compiled_truth: body, frontmatter: {}, source_path: `${SLUG}.md`,
  }, { sourceId: 'default' });
}

/** Write the page's canonical file: a fence section, or none when `rows` is null. */
function writePageFile(rows: ParsedFact[] | null): string {
  const body = rows === null ? '# Alice Example\n' : replaceOrInsertFactsFence('# Alice Example\n', renderFactsTable(rows));
  const path = join(root, `${SLUG}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

async function seedFact(opts: { rowNum: number | null; claim: string; source: string; kind?: string }): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                        row_num, source_markdown_slug)
     VALUES ('default', $1, $2, $3, 'private', 'medium', now(), $4, 1.0, $5, $6) RETURNING id`,
    [SLUG, opts.claim, opts.kind ?? 'fact', opts.source, opts.rowNum, opts.rowNum === null ? null : SLUG],
  );
  return Number(row.id);
}

/** Everything the preservation contract protects; write-metadata columns are re-stamped by design. */
const factsSnapshot = () => engine.executeRaw<Record<string, unknown>>(
  `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, source, confidence,
          row_num, source_markdown_slug, expired_at
     FROM facts ORDER BY id`);

const fenceOf = (path: string) => parseFactsFence(readFileSync(path, 'utf-8')).facts.map(f => [f.rowNum, f.claim]);

describe('FIX A — the conversation-miner domain is excluded on both sides of verify', () => {
  test('a page whose fence and database agree verifies complete, and real drift still fails by name and number', async () => {
    const path = writePageFile([
      fenceRow(1, 'Alice example joined Acme example', CLI),
      fenceRow(2, 'Alice example prefers async updates'),
    ]);
    await indexPage();
    await seedFact({ rowNum: 1, claim: 'Alice example joined Acme example', source: CLI });
    await seedFact({ rowNum: 2, claim: 'Alice example prefers async updates', source: 'mcp:put_page' });
    // A cli: row with no fence row — the shape the exclusion exists for.
    await seedFact({ rowNum: 7, claim: 'Alice example ships on Fridays', source: CLI, kind: 'event' });

    const ok = await __testing.phaseCVerify(engine, OPTS);
    expect(ok.status, ok.detail).toBe('complete');

    // The gate still bites: a fence row with no database owner fails by name.
    writePageFile([
      fenceRow(1, 'Alice example joined Acme example', CLI),
      fenceRow(2, 'Alice example prefers async updates'),
      fenceRow(3, 'Alice example met Bob example'),
    ]);
    const drifted = await __testing.phaseCVerify(engine, OPTS);
    expect(drifted.status).toBe('failed');
    expect(drifted.detail).toContain(SLUG);
    expect(drifted.detail).toContain('not indexed: 3');
    expect(readFileSync(path, 'utf-8')).toContain('Alice example met Bob example');
  });
});

describe('FIX B — the backfill re-publishes rows whose fence position the markdown lost', () => {
  test('adopts in place: same id, same position, nothing expired, and a re-run is a no-op', async () => {
    const path = writePageFile([fenceRow(1, 'First claim')]);
    await indexPage();
    const first = await seedFact({ rowNum: 1, claim: 'First claim', source: 'mcp:put_page' });
    const lost = await seedFact({ rowNum: 5, claim: 'Fifth claim', source: 'mcp:put_page' });
    const before = await factsSnapshot();

    const fenced = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(fenced.status, fenced.detail).toBe('complete');
    expect(fenced.detail).toContain('adopted_in_place=1');
    expect(fenceOf(path)).toEqual([[1, 'First claim'], [5, 'Fifth claim']]);

    const after = await factsSnapshot();
    expect(after).toHaveLength(before.length);
    const byId = new Map(after.map(r => [Number(r.id), r]));
    expect(byId.get(lost)).toMatchObject({ fact: 'Fifth claim', row_num: 5, source_markdown_slug: SLUG, expired_at: null, source: 'mcp:put_page' });
    expect(byId.get(first)).toMatchObject({ row_num: 1, expired_at: null });

    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');

    // Idempotent: the second pass finds the row already published.
    const bytes = readFileSync(path, 'utf-8');
    const rerun = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(rerun.status, rerun.detail).toBe('complete');
    expect(rerun.detail).toContain('fenced=0');
    expect(readFileSync(path, 'utf-8')).toEqual(bytes);
    expect(await factsSnapshot()).toEqual(after);
  });

  test('creates the missing fence section for a stamped row on a page that has none', async () => {
    const path = writePageFile(null);
    await indexPage();
    const id = await seedFact({ rowNum: 3, claim: 'Third claim', source: 'sync:import' });

    expect(path && existsSync(path)).toBe(true);
    const fenced = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(fenced.status, fenced.detail).toBe('complete');
    expect(fenced.detail).toContain('adopted_in_place=1');
    expect(fenceOf(path)).toEqual([[3, 'Third claim']]);
    const rows = await factsSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, row_num: 3, expired_at: null });
    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');
  });

  test('a position the fence already occupies moves the row, never drops it, and stays visible as drift', async () => {
    const path = writePageFile([fenceRow(5, 'A different claim')]);
    await indexPage();
    const id = await seedFact({ rowNum: 5, claim: 'Fifth claim', source: 'mcp:put_page' });

    const fenced = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(fenced.status, fenced.detail).toBe('complete');
    expect(fenced.detail).toContain('renumbered=1');
    // Both claims are in the fence; the row survived under the next free number.
    expect(fenceOf(path)).toEqual([[5, 'A different claim'], [6, 'Fifth claim']]);
    const rows = await factsSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, fact: 'Fifth claim', row_num: 6, expired_at: null });
    // The unowned position is still reported: a hard case is never blessed.
    const drifted = await __testing.phaseCVerify(engine, OPTS);
    expect(drifted.status).toBe('failed');
    expect(drifted.detail).toContain('not indexed: 5');
  });

  test('the extract_facts reconcile keeps its own walk over stale fence rows', async () => {
    writePageFile([fenceRow(1, 'First claim')]);
    await indexPage();
    await seedFact({ rowNum: 1, claim: 'First claim', source: 'mcp:put_page' });
    await seedFact({ rowNum: 5, claim: 'Fifth claim', source: 'mcp:put_page' });

    // Runtime semantics unchanged: the cycle does not re-publish it.
    const runtime = await planUnfencedFacts(engine, { sourceId: 'default' });
    expect(runtime.groups.size).toBe(0);
    // The migration's backfill opts in.
    const backfill = await planUnfencedFacts(engine, { sourceId: 'default', adoptStamped: true });
    expect(backfill.groups.size).toBe(1);
    expect([...backfill.groups.values()][0].map(r => Number(r.row_num))).toEqual([1, 5]);
  });
});
