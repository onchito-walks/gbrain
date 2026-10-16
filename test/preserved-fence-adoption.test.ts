/**
 * Strict-preservation adoption controls: the v0.32.2 phase B (and every
 * extract_facts cycle) must put a page's adoptable legacy rows into the page's
 * DERIVED representation without touching a single original byte — no stamped
 * position, no rewritten claim, no rewritten page body, no new fact row, and
 * no expiry. Real PGLite engine, real temp canonical file, real originals
 * including a NULL position, a position the fence already occupies (the
 * 5-to-derived-9 collision) and a position the markdown lost.
 *
 * This is NOT a migration acceptance claim: phase C's independent verification
 * of derived coordinates, import/rebuild recovery and the protected build are
 * still required and are not covered here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseFactsFence, replaceOrInsertFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { sha256, stableJson } from '../src/core/persistence/digest.ts';
import { planUnfencedFacts, fenceUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import {
  PRESERVED_FENCE_SOURCE, derivedFenceOf, discoverOriginalColumns, planPagePreservedFencePublication,
  preservedFencePublicationState, readPreservedFencePublication,
} from '../src/core/facts/preserved-fence-store.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

const SLUG = 'people/alice-example';
/** A second real page: a legacy row may carry a position bound to another page's fence. */
const BOB = 'people/bob-example';
const BASE = process.env.GBRAIN_TEST_PRESERVED_STORE_BASE ?? '/tmp';
const OS = 'os:operator';

let engine: PGLiteEngine;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  root = mkdtempSync(join(BASE, 'preserved-adoption-'));
  await engine.executeRaw('DELETE FROM raw_data');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [root]);
  _resetWriteThroughCacheForTest();
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fenceRow = (rowNum: number, claim: string): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
  validFrom: '2026-01-01', source: OS, active: true,
});

/** The originals: the fence already carries positions 5..8 and nothing else. */
const FENCE_ROWS = [fenceRow(5, 'Fence row five'), fenceRow(6, 'Fence row six'),
  fenceRow(7, 'Fence row seven'), fenceRow(8, 'Fence row eight')];
const ORIGINAL_BODY = replaceOrInsertFactsFence('# Alice Example\n\nOriginal prose stays literal.\n', renderFactsTable(FENCE_ROWS));

async function seedPage(): Promise<void> {
  await engine.putPage(SLUG, {
    type: 'person', title: 'Alice Example', compiled_truth: ORIGINAL_BODY, frontmatter: {},
    source_path: `${SLUG}.md`,
  }, { sourceId: 'default' });
  const path = join(root, `${SLUG}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, ORIGINAL_BODY);
  // The second page carries the fence the colliding legacy row's position lives on.
  const bobBody = replaceOrInsertFactsFence('# Bob Example\n', renderFactsTable([fenceRow(5, 'Legacy numbered claim')]));
  await engine.putPage(BOB, {
    type: 'person', title: 'Bob Example', compiled_truth: bobBody, frontmatter: {}, source_path: `${BOB}.md`,
  }, { sourceId: 'default' });
  writeFileSync(join(root, `${BOB}.md`), bobBody);
}

/** One original fact row; `sourceSlug` defaults to the page for fence-owned shapes. */
async function seedFact(opts: { entitySlug?: string; rowNum: number | null; claim: string; sourceSlug?: string | null; sourceSession?: string }): Promise<string> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, notability,
        valid_from, source, source_session, confidence)
     VALUES ('default', $1, $2, $3, $4, 'fact', 'private', 'medium', '2026-01-01', $5, $6, 1)
     RETURNING id`,
    [opts.entitySlug ?? SLUG, opts.sourceSlug === undefined ? SLUG : opts.sourceSlug, opts.rowNum, opts.claim,
      OS, opts.sourceSession ?? null],
  );
  return String(row!.id);
}

/** Full-row capture of the whole original population: nothing projected away. */
async function originalDigests(): Promise<unknown> {
  const columns = await discoverOriginalColumns(engine);
  const facts = await engine.executeRaw('SELECT * FROM facts ORDER BY id');
  const pages = await engine.executeRaw('SELECT * FROM pages ORDER BY id');
  return { columns, facts, pages };
}

async function factRow(id: string): Promise<{ fact: string; row_num: number | null; expired_at: unknown; source_markdown_slug: string | null; source_session: string | null }> {
  const [row] = await engine.executeRaw<{ fact: string; row_num: number | null; expired_at: unknown; source_markdown_slug: string | null; source_session: string | null }>(
    'SELECT fact, row_num, expired_at, source_markdown_slug, source_session FROM facts WHERE id = $1', [Number(id)]);
  return row!;
}

async function fileBody(): Promise<string> { return readFileSync(join(root, `${SLUG}.md`), 'utf-8'); }

async function storedRowCount(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n FROM raw_data WHERE source = $1`, [PRESERVED_FENCE_SOURCE]);
  return Number(row!.n);
}

/**
 * The retained-rehearsal shape: fence rows 5..8 are indexed; a NULL row and a
 * row whose position the fence occupies are the legacy shapes; a row at 12 is a
 * position the markdown lost.
 */
async function seedRealShape(): Promise<{ fence: string[]; legacyNull: string; collision: string; lost: string }> {
  const fence: string[] = [];
  for (const row of [5, 6, 7, 8]) fence.push(await seedFact({ rowNum: row, claim: `Fence row ${['five', 'six', 'seven', 'eight'][row - 5]}` }));
  const lost = await seedFact({ rowNum: 12, claim: 'Legacy lost row twelve', sourceSession: 'session-lost' });
  const legacyNull = await seedFact({ rowNum: null, claim: 'Legacy unfenced claim', sourceSlug: null, sourceSession: 'session-null' });
  // The fence's own position 5 belongs to another page, and this row's own
  // position 5 is the one the markdown no longer carries on its entity page.
  const collision = await seedFact({ rowNum: 5, claim: 'Legacy numbered claim', sourceSlug: BOB, sourceSession: 'session-collision' });
  return { fence, legacyNull, collision, lost };
}

async function adopt(): Promise<Awaited<ReturnType<typeof fenceUnfencedFacts>>> {
  const plan = await planUnfencedFacts(engine, { sourceId: 'default', adoptStamped: true });
  return fenceUnfencedFacts(engine, plan);
}

test('an adopting run publishes the derived document and leaves every original byte-identical', async () => {
  await seedPage();
  const { fence, legacyNull, collision, lost } = await seedRealShape();
  const before = await originalDigests();
  const bodyBefore = await fileBody();

  const outcome = await adopt();
  expect(outcome.pages_touched).toBe(1);
  // The rows this run had to place: the NULL row, the colliding row and the row
  // whose position the markdown lost (the fence's own rows stay paired).
  expect(outcome.fenced).toBe(3);

  // Originals: full rows (every discovered column), the canonical file, the page body.
  expect(stableJson(await originalDigests())).toBe(stableJson(before));
  expect(await fileBody()).toBe(bodyBefore);
  const [pageRow] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug = $1', [SLUG]);
  expect(pageRow!.compiled_truth).toBe(ORIGINAL_BODY);

  // Derived: the canonical plan of the current originals, stored once.
  const stored = await readPreservedFencePublication(engine, 'default', SLUG);
  const expected = await planPagePreservedFencePublication(engine, 'default', SLUG);
  expect(stored).toEqual(expected);
  expect(await storedRowCount()).toBe(1);

  const bindings = new Map(stored!.bindings.map(b => [b.original_fact_id, b]));
  // Every original row of the page is pinned: the four fence rows, the NULL
  // row, the collision and the lost position.
  expect(bindings.size).toBe(7);
  // The NULL original stays NULL and the fence-occupied position stays 5 — only the derived position moves.
  expect(bindings.get(legacyNull)!.original_row_num).toBeNull();
  expect(bindings.get(legacyNull)!.derived_row_num).toBeGreaterThanOrEqual(13);
  expect(bindings.get(collision)!.original_row_num).toBe(5);
  expect(bindings.get(collision)!.derived_row_num).not.toBe(5);
  for (const id of fence) {
    const binding = bindings.get(id)!;
    expect(binding.original_row_num).not.toBeNull();
    expect(binding.derived_row_num).toBe(binding.original_row_num!);
  }
  expect(bindings.get(lost)!.derived_row_num).toBe(12);
  // The derived document carries the original fence rows unchanged plus one row per binding.
  expect(derivedFenceOf(stored!).find(row => row.rowNum === 5)!.claim).toBe('Fence row five');
  expect(parseFactsFence(await fileBody()).facts.map(row => row.rowNum).sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  expect(stored!.original_body_sha256).toBe(sha256(bodyBefore));
});

test('a second adopting run is a no-op: same document, same originals, no new rows', async () => {
  await seedPage();
  const { legacyNull, collision } = await seedRealShape();
  await adopt();
  const document = await readPreservedFencePublication(engine, 'default', SLUG);
  const before = await originalDigests();
  const [count] = await engine.executeRaw<{ n: string }>('SELECT COUNT(*) AS n FROM facts');

  await adopt();

  expect(await readPreservedFencePublication(engine, 'default', SLUG)).toEqual(document!);
  expect(stableJson(await originalDigests())).toBe(stableJson(before));
  const [again] = await engine.executeRaw<{ n: string }>('SELECT COUNT(*) AS n FROM facts');
  expect(again!.n).toBe(count!.n);
  expect(await storedRowCount()).toBe(1);
  expect(await factRow(legacyNull)).toMatchObject({ fact: 'Legacy unfenced claim', row_num: null, expired_at: null });
  expect(await factRow(collision)).toMatchObject({ fact: 'Legacy numbered claim', row_num: 5, expired_at: null });
});

test('the cycle reconcile leaves bound originals alone: no expiry, no detach, no insert, guard off', async () => {
  await seedPage();
  const { fence, legacyNull, collision, lost } = await seedRealShape();
  await adopt();

  const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });

  expect(result.legacyRowsPending).toBe(0);
  expect(result.guardTriggered).toBe(false);
  expect(result.factsDeleted).toBe(0);
  // The bound rows are exactly as they were: identity, position, text, provenance.
  expect(await factRow(legacyNull)).toMatchObject({ fact: 'Legacy unfenced claim', row_num: null, expired_at: null, source_session: 'session-null' });
  expect(await factRow(collision)).toMatchObject({ fact: 'Legacy numbered claim', row_num: 5, expired_at: null, source_session: 'session-collision' });
  expect(await factRow(lost)).toMatchObject({ fact: 'Legacy lost row twelve', row_num: 12, expired_at: null, source_session: 'session-lost' });
  for (const id of fence) expect((await factRow(id)).expired_at).toBeNull();
  // The derived document is unchanged and still current.
  expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
});

test('a drifted derived document is replanned from the current originals; no original is expired or rewritten', async () => {
  await seedPage();
  const { lost } = await seedRealShape();
  await adopt();
  const first = await readPreservedFencePublication(engine, 'default', SLUG);

  // A provenance change on a bound original invalidates the stored document.
  await engine.executeRaw(`UPDATE facts SET source_session = 'drifted' WHERE id = $1`, [Number(lost)]);
  const state = await preservedFencePublicationState(engine, 'default', SLUG);
  expect(state.state).toBe('drifted');
  if (state.state === 'drifted') expect(state.reason).toMatch(/original_or_derived_drift/);

  const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });

  // The projection is maintained, not frozen: it is replanned from the current
  // originals. No original row is expired, detached, renumbered or rewritten.
  expect(await readPreservedFencePublication(engine, 'default', SLUG)).not.toEqual(first!);
  expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
  expect(await factRow(lost)).toMatchObject({ fact: 'Legacy lost row twelve', row_num: 12, expired_at: null, source_session: 'drifted' });
  expect(result.factsDeleted).toBe(0);
  expect(result.legacyRowsPending).toBe(0);
});

test('a drifted document that cannot be replanned leaves the page its index instead of expiring bound rows', async () => {
  await seedPage();
  const { lost } = await seedRealShape();
  await adopt();
  // The stored document is stale AND the page now carries a row the codec cannot
  // render, so replanning the document refuses for the whole page.
  await engine.executeRaw(`UPDATE facts SET source_session = 'drifted' WHERE id = $1`, [Number(lost)]);
  const broken = await seedFact({ rowNum: null, claim: 'unrenderable <br> claim', sourceSlug: null });

  const result = await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG] });

  expect(await factRow(lost)).toMatchObject({ fact: 'Legacy lost row twelve', row_num: 12, expired_at: null, source_session: 'drifted' });
  expect(await factRow(broken)).toMatchObject({ fact: 'unrenderable <br> claim', row_num: null, expired_at: null });
  expect(result.factsDeleted).toBe(0);
  expect(result.guardTriggered).toBe(true);
});

test('the migration may replan a drifted document from current originals without touching an original', async () => {
  await seedPage();
  const { lost } = await seedRealShape();
  await adopt();
  await engine.executeRaw(`UPDATE facts SET source_session = 'moved-on' WHERE id = $1`, [Number(lost)]);

  const plan = await planUnfencedFacts(engine, { sourceId: 'default', adoptStamped: true });
  const before = await originalDigests();
  const outcome = await fenceUnfencedFacts(engine, plan, { allowSupersede: true });

  expect(outcome.pages_touched).toBe(1);
  expect(stableJson(await originalDigests())).toBe(stableJson(before));
  expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
});

test('an unrenderable candidate refuses the page: nothing is published and nothing is expired', async () => {
  await seedPage();
  await seedFact({ rowNum: 3, claim: 'Fence row three' });
  const unrenderable = await seedFact({ rowNum: null, claim: 'legacy  <br>  claim', sourceSlug: null, sourceSession: 'session-br' });
  const before = await originalDigests();

  const outcome = await adopt();

  expect(outcome.failed_pages.some(page => page.startsWith(`${SLUG} (`))).toBe(true);
  expect(await storedRowCount()).toBe(0);
  expect(stableJson(await originalDigests())).toBe(stableJson(before));
  expect(await factRow(unrenderable)).toMatchObject({ fact: 'legacy  <br>  claim', row_num: null, expired_at: null });
});

test('a page with no derived document reports none instead of an empty one', async () => {
  await seedPage();
  await seedRealShape();
  expect(await preservedFencePublicationState(engine, 'default', SLUG)).toEqual({ state: 'none' });
  expect(await readPreservedFencePublication(engine, 'default', SLUG)).toBeNull();
});

test('the migration orchestrator publishes the derived document and verifies both coordinate systems', async () => {
  const migration = await import('../src/commands/migrations/v0_32_2.ts');
  migration.__setTestEngineOverride(engine);
  const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
  try {
    await seedPage();
    await seedRealShape();
    const before = await originalDigests();
    const bodyBefore = await fileBody();

    // Phase B: the backfill's own entry point, not the shared pass directly.
    const phaseB = await migration.__testing.phaseBFenceFacts(engine, OPTS);
    expect(phaseB.status).toBe('complete');
    expect(stableJson(await originalDigests())).toBe(stableJson(before));
    expect(await fileBody()).toBe(bodyBefore);
    expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');

    // Phase C: original coordinates AND the derived document, both verified.
    const phaseC = await migration.__testing.phaseCVerify(engine, OPTS);
    expect(phaseC.status).toBe('complete');
    expect(phaseC.detail).toContain('pages_checked=2');

    // A document that no longer matches its originals fails the phase by name.
    await engine.executeRaw(`UPDATE facts SET source_session = 'drifted' WHERE id = $1`,
      [Number((await seedFact({ rowNum: null, claim: 'A later legacy row', sourceSlug: null })))]);
    const driftedC = await migration.__testing.phaseCVerify(engine, OPTS);
    expect(driftedC.status).toBe('failed');
    expect(driftedC.detail).toContain(SLUG);
  } finally {
    migration.__setTestEngineOverride(null);
  }
});
