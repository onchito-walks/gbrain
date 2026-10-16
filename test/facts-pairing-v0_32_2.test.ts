/**
 * v0.32.2 facts/fence PAIRING regressions.
 *
 * The run99 rehearsal failed its last phase with `19 pages drifted` because the
 * disposable DB was restored from an older snapshot while the fence source
 * still resolved to the live vault: the file held fence rows the DB snapshot
 * did not index. Reads and writes must both go through the source's CONFIGURED
 * path, so the rehearsal is fixed by pairing a fresh DB copy with a fresh copy
 * of the repository — never by weakening the verify gate, and never by
 * deleting facts to force green.
 *
 * These regressions pin, on a real PGLite schema and a real temp filesystem:
 *   - phase B writes only inside the configured source path (the "live" second
 *     tree stays byte-identical);
 *   - a paired copy verifies complete;
 *   - an UNPAIRED copy fails loudly with the exact page + row numbers;
 *   - verify is read-only: a failure leaves every fact row byte-identical;
 *   - re-running after a partial fence write neither duplicates nor loses rows.
 *
 * Engine injected via __setTestEngineOverride (no configured brain needed).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import { parseFactsFence, replaceOrInsertFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { PRESERVED_FENCE_SOURCE, derivedFenceOf, readPreservedFencePublication } from '../src/core/facts/preserved-fence-store.ts';

const SLUG = 'people/alice-example';
const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
// An explicit base outside any managed canonical worktree: when the ambient
// TMPDIR lives inside one (e.g. a Hermes profile scratch dir), gbrain's
// owner-marker guard refuses the fence write by design.
const BASE = process.env.GBRAIN_TEST_FACTS_PAIRING_BASE ?? '/tmp';

let engine: PGLiteEngine;
let live: string;
let copy: string;

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
  live = mkdtempSync(join(BASE, 'facts-pairing-live-'));
  copy = mkdtempSync(join(BASE, 'facts-pairing-copy-'));
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [live]);
});

afterEach(() => {
  rmSync(live, { recursive: true, force: true });
  rmSync(copy, { recursive: true, force: true });
});

const fenceRow = (rowNum: number, claim: string): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
  validFrom: '2026-01-01', source: 'mcp:put_page', active: true,
});

function writePage(root: string, rows: ParsedFact[]): string {
  const body = rows.length
    ? replaceOrInsertFactsFence('# Alice Example\n', renderFactsTable(rows))
    : '# Alice Example\n';
  const path = join(root, `${SLUG}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

async function indexPage(): Promise<void> {
  await engine.putPage(SLUG, {
    type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example\n',
    frontmatter: {}, source_path: `${SLUG}.md`,
  }, { sourceId: 'default' });
}

async function seedFact(rowNum: number | null, claim: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                        row_num, source_markdown_slug)
     VALUES ('default', $1, $2, 'fact', 'private', 'medium', now(), 'mcp:put_page', 1.0, $3, $4)`,
    [SLUG, claim, rowNum, rowNum === null ? null : SLUG],
  );
}

// Write-metadata columns (last_written_at, …) are re-stamped by design when a
// row is re-fenced; content, identity and fence position are what must survive.
const allFacts = () => engine.executeRaw<Record<string, unknown>>(
  `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, valid_from,
          source, confidence, row_num, source_markdown_slug, expired_at
     FROM facts ORDER BY id`);

describe('a paired copy fences and verifies without touching the other tree', () => {
  test('phase B writes no tree at all; both the live and the paired copy stay byte-identical', async () => {
    const livePath = writePage(live, []);
    const copyPath = writePage(copy, []);
    const liveBefore = readFileSync(livePath);
    const copyBefore = readFileSync(copyPath);
    await indexPage();
    await seedFact(null, 'Founded Acme example');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [copy]);

    const fenced = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(fenced.status).toBe('complete');
    expect(fenced.detail).toContain('fenced=1');

    // Strict preservation: the adoption is published as the page's derived
    // document, so NEITHER tree is written — the paired copy included.
    expect(readFileSync(copyPath)).toEqual(copyBefore);
    expect(readFileSync(livePath)).toEqual(liveBefore);
    const document = await readPreservedFencePublication(engine, 'default', SLUG);
    expect(document).not.toBeNull();
    expect(derivedFenceOf(document!).map(row => row.claim)).toEqual(['Founded Acme example']);
    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');
  });

  test('an unpaired copy fails verify with the exact page and row numbers, and deletes nothing', async () => {
    // The DB snapshot indexes only row 1; the live tree already fences rows 1-3
    // (rows 1-2 are the duplicate-claim pair extract_facts indexes once).
    await indexPage();
    await seedFact(1, 'First claim');
    const before = await allFacts();
    writePage(live, [fenceRow(1, 'First claim'), fenceRow(2, 'First claim'), fenceRow(3, 'Third claim')]);
    const livePath = join(live, `${SLUG}.md`);
    const liveBytes = readFileSync(livePath);

    const drifted = await __testing.phaseCVerify(engine, OPTS);
    expect(drifted.status).toBe('failed');
    expect(drifted.detail).toBe(`1 pages drifted: ${SLUG} (fence=3, db=1; not indexed: 3)`);
    // The failure is reported, not repaired: no fact row is dropped and the
    // canonical file is not rewritten to match the older snapshot.
    expect(await allFacts()).toEqual(before);
    expect(readFileSync(livePath)).toEqual(liveBytes);

    // Pairing a fresh copy of the repository with the DB snapshot is the fix.
    const pairedPath = writePage(copy, [fenceRow(1, 'First claim')]);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [copy]);
    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');
    expect(readFileSync(pairedPath, 'utf-8')).toContain('First claim');
  });

  test('verify is read-only and idempotent under failure', async () => {
    await indexPage();
    await seedFact(1, 'First claim');
    await seedFact(5, 'Fifth claim');           // not in the fence below: drift, both directions
    writePage(live, [fenceRow(1, 'First claim'), fenceRow(2, 'Second claim')]);
    const before = await allFacts();
    const bytes = readFileSync(join(live, `${SLUG}.md`));

    const first = await __testing.phaseCVerify(engine, OPTS);
    const second = await __testing.phaseCVerify(engine, OPTS);
    expect(first.status).toBe('failed');
    expect(second).toEqual(first);
    expect(first.detail).toContain('not indexed: 2');
    expect(first.detail).toContain('not in fence: 5');
    expect(await allFacts()).toEqual(before);
    expect(readFileSync(join(live, `${SLUG}.md`))).toEqual(bytes);
  });

  test('a partial publication recovers on re-run without duplicating or losing facts', async () => {
    writePage(copy, []);
    await indexPage();
    await seedFact(null, 'First claim');
    await seedFact(null, 'Second claim');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [copy]);
    const first = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(first.status, first.detail).toBe('complete');
    const afterFirst = await allFacts();
    const document = await readPreservedFencePublication(engine, 'default', SLUG);
    expect(document!.bindings).toHaveLength(2);

    // Simulate the interrupted state the run99 rehearsal stopped in: the
    // publication never landed.
    await engine.executeRaw(`DELETE FROM raw_data WHERE source = $1`, [PRESERVED_FENCE_SOURCE]);
    expect(await readPreservedFencePublication(engine, 'default', SLUG)).toBeNull();

    const rerun = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(rerun.status, rerun.detail).toBe('complete');
    // The projection is recomputed from the same originals, so it reads back
    // identical, and no fact row was duplicated, stamped or lost.
    expect(await readPreservedFencePublication(engine, 'default', SLUG)).toEqual(document!);
    expect(await allFacts()).toEqual(afterFirst);
    expect(derivedFenceOf(document!).map(f => f.claim)).toEqual(['First claim', 'Second claim']);
    expect(existsSync(join(live, `${SLUG}.md`))).toBe(false);
  });
});
