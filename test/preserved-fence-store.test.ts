/**
 * Preserved fence store controls — the durable adapter that publishes the
 * derived facts-fence document through the existing owner/journal path while
 * leaving every original fact row, page row and canonical file byte-identical.
 *
 * Real engine (PGLite schema + migrations), real temp filesystem, real originals
 * including a NULL-position row and an existing position whose fence slot is
 * already taken (the 5-to-derived-9 shape the retained rehearsal observed).
 * Nothing here is a migration acceptance claim: phase B/C wiring, the
 * pendingLegacyRows / planFenceReconcile binding and import/rebuild recovery are
 * still required and are NOT covered by these controls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseFactsFence, replaceOrInsertFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { sha256, stableJson } from '../src/core/persistence/digest.ts';
import { planPreservedFencePublication } from '../src/core/facts/preserved-fence-publication.ts';
import {
  PRESERVED_FENCE_SOURCE, assertPublicationIsCurrent, derivedFenceOf, discoverOriginalColumns,
  planPagePreservedFencePublication, preparePreservedFencePublication, preservedCandidateIds,
  preservedDerivedPosition, preservedOriginalFactIds, publishPreservedFencePublication,
  readPreservedFencePublication, readPreservedFenceOriginals, verifyPreservedFencePublication,
} from '../src/core/facts/preserved-fence-store.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

const SLUG = 'people/alice-example';
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
  root = mkdtempSync(join(BASE, 'preserved-store-'));
  await engine.executeRaw('DELETE FROM raw_data');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [root]);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fenceRow = (rowNum: number, claim: string, source = 'mcp:put_page'): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
  validFrom: '2026-01-01', source, active: true,
});

/** Original page body: the fence already carries positions 5..8 and nothing else. */
const ORIGINAL_BODY = replaceOrInsertFactsFence('# Alice Example\n\nOriginal prose stays literal.\n',
  renderFactsTable([fenceRow(5, 'Fence row five unrelated to the legacy row'), fenceRow(6, 'Fence row six'),
    fenceRow(7, 'Fence row seven'), fenceRow(8, 'Fence row eight')]));

async function seedPage(): Promise<void> {
  await engine.putPage(SLUG, {
    type: 'person', title: 'Alice Example', compiled_truth: ORIGINAL_BODY, frontmatter: {},
    source_path: `${SLUG}.md`,
  }, { sourceId: 'default' });
  const path = join(root, `${SLUG}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, ORIGINAL_BODY);
}

/** One original fact row; `rowNum: null` is the legacy unfenced shape. */
async function seedFact(opts: { rowNum: number | null; claim: string; source?: string; sourceSession?: string }): Promise<string> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, source_markdown_slug, row_num, fact, kind, visibility, notability,
        valid_from, source, source_session, confidence)
     VALUES ('default', $1, $2, $3, $4, 'fact', 'private', 'medium', '2026-01-01', $5, $6, 1)
     RETURNING id`,
    [SLUG, opts.rowNum === null ? null : SLUG, opts.rowNum, opts.claim, opts.source ?? OS, opts.sourceSession ?? null],
  );
  return String(row!.id);
}

/** Full-row digests of the whole original population: nothing projected away. */
async function originalDigests(): Promise<unknown> {
  const columns = await discoverOriginalColumns(engine);
  const facts = await engine.executeRaw('SELECT * FROM facts ORDER BY id');
  const pages = await engine.executeRaw('SELECT * FROM pages ORDER BY id');
  return { columns, facts, pages };
}

async function fileBody(): Promise<string> { return readFileSync(join(root, `${SLUG}.md`), 'utf-8'); }

async function storedRowCount(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n FROM raw_data WHERE source = $1`, [PRESERVED_FENCE_SOURCE]);
  return Number(row!.n);
}

/** The retained-rehearsal shape: the numbered row plans before the NULL row. */
async function seedRealShape(): Promise<{ legacyNull: string; numbered: string }> {
  const numbered = await seedFact({ rowNum: 5, claim: 'Legacy numbered claim', sourceSession: 'session-5' });
  const legacyNull = await seedFact({ rowNum: null, claim: 'Legacy unfenced claim', sourceSession: 'session-null' });
  return { legacyNull, numbered };
}

test('the publication path writes only the derived document: every original row and the canonical file stay byte-identical', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  const before = await originalDigests();
  const bodyBefore = await fileBody();

  const receipt = await publishPreservedFencePublication(engine, 'default', SLUG);
  expect(receipt.published).toBe(true);
  expect(receipt.path).toBe('unmanaged');
  expect(receipt.bindings).toBe(2);

  expect(stableJson(await originalDigests())).toBe(stableJson(before));
  expect(await fileBody()).toBe(bodyBefore);

  const stored = await readPreservedFencePublication(engine, 'default', SLUG);
  expect(stored?.schema).toBe('gbrain.preserved-fence-publication.v1');
  // Originals are pinned literally: the numbered row keeps 5, the legacy row keeps NULL.
  const numberedBinding = stored!.bindings.find(b => b.original_fact_id === numbered)!;
  const nullBinding = stored!.bindings.find(b => b.original_fact_id === legacyNull)!;
  expect(numberedBinding.original_row_num).toBe(5);
  expect(numberedBinding.derived_row_num).toBe(9);
  expect(nullBinding.original_row_num).toBeNull();
  expect(nullBinding.derived_row_num).toBe(10);
  // The collision is resolved in the derived document; the original fence rows stay.
  const derived = derivedFenceOf(stored!);
  expect(derived.map(row => row.rowNum).sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10]);
  expect(derived.find(row => row.rowNum === 5)!.claim).toBe('Fence row five unrelated to the legacy row');
  expect(parseFactsFence(await fileBody()).facts.map(row => row.rowNum).sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  expect(stored!.original_body_sha256).toBe(sha256(bodyBefore));
  expect(await storedRowCount()).toBe(1);
});

test('verification replans from the current complete originals and re-publication is idempotent', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  const first = await publishPreservedFencePublication(engine, 'default', SLUG);
  const stored = await readPreservedFencePublication(engine, 'default', SLUG);
  expect(await verifyPreservedFencePublication(engine, 'default', SLUG)).toEqual({ ok: true, bindings: 2 });

  const before = await originalDigests();
  const second = await publishPreservedFencePublication(engine, 'default', SLUG);
  expect(second.derivedBodySha256).toBe(first.derivedBodySha256);
  expect(await readPreservedFencePublication(engine, 'default', SLUG)).toEqual(stored!);
  expect(stableJson(await originalDigests())).toBe(stableJson(before));
  expect(await storedRowCount()).toBe(1);
  expect(legacyNull).toBeTruthy(); expect(numbered).toBeTruthy();
});

test('the canonical candidate set is derived from the engine and mirrors the backfill selection', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  // A conversation-miner row that already holds a position is never adopted.
  const cli = await seedFact({ rowNum: 6, claim: 'Chat-log row', source: 'cli:extract-conversation-facts' });
  expect((await preservedCandidateIds(engine, 'default', SLUG)).sort()).toEqual([numbered, legacyNull].sort());
  expect(await preservedCandidateIds(engine, 'default', SLUG)).not.toContain(cli);
  // A row that holds no position is a candidate even in the conversation domain.
  const cliNull = await seedFact({ rowNum: null, claim: 'Chat-log row with no position', source: 'cli:extract-conversation-facts' });
  expect((await preservedCandidateIds(engine, 'default', SLUG)).sort()).toEqual([numbered, legacyNull, cliNull].sort());
});

test('complete column discovery is engine-side and a narrowed manifest cannot hide provenance drift', async () => {
  await seedPage();
  await seedRealShape();
  const columns = await discoverOriginalColumns(engine);
  expect(columns.facts).toContain('source_session');
  expect(columns.facts).toContain('attributed_to');
  expect(columns.page).toContain('compiled_truth');

  const narrow = { source: columns.source, page: columns.page, facts: columns.facts.filter(c => c !== 'source_session') };
  // A narrowed discovery cannot even produce a complete record from the engine.
  await expect(readPreservedFenceOriginals(engine, 'default', SLUG, { columns: narrow }))
    .rejects.toThrow(/incomplete_original_record/);
  // And a record whose rows still carry the omitted column is refused by the planner.
  const originals = await readPreservedFenceOriginals(engine, 'default', SLUG);
  expect(() => planPreservedFencePublication({ ...originals.input, columns: narrow })).toThrow(/incomplete_original_record/);
  await expect(publishPreservedFencePublication(engine, 'default', SLUG, { columns: narrow }))
    .rejects.toThrow(/incomplete_original_record|incomplete_column_manifest/);
  expect(await storedRowCount()).toBe(0);
});

test('an original fact provenance or claim change refuses verification and leaves the stored document as it was', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  await publishPreservedFencePublication(engine, 'default', SLUG);
  const stored = await readPreservedFencePublication(engine, 'default', SLUG);

  await engine.executeRaw(`UPDATE facts SET source_session = 'drifted' WHERE id = $1`, [Number(legacyNull)]);
  const drifted = await verifyPreservedFencePublication(engine, 'default', SLUG);
  expect(drifted.ok).toBe(false);
  expect(drifted.reason).toMatch(/original_or_derived_drift/);
  await expect(assertPublicationIsCurrent(engine, 'default', SLUG, stored!)).rejects.toThrow(/original_or_derived_drift/);
  // Re-publication refuses to replace the drifted document unless asked to, and
  // the stored document is left exactly as it was.
  await expect(publishPreservedFencePublication(engine, 'default', SLUG)).rejects.toThrow(/stored_publication_drifted/);
  expect(await readPreservedFencePublication(engine, 'default', SLUG)).toEqual(stored!);
  // An explicit supersede is the only way to replace it, and it says so.
  const superseding = await publishPreservedFencePublication(engine, 'default', SLUG, { allowSupersede: true });
  expect(superseding.supersededStoredPublication).toBe(true);
  expect(await readPreservedFencePublication(engine, 'default', SLUG)).not.toEqual(stored!);
  expect(numbered).toBeTruthy();

  await engine.executeRaw(`UPDATE facts SET source_session = 'session-null' WHERE id = $1`, [Number(legacyNull)]);
  // Restoring the original value makes the CURRENT document current again only
  // through a fresh plan, never by treating drift as equal.
  await expect(verifyPreservedFencePublication(engine, 'default', SLUG)).resolves.toMatchObject({ ok: false });
  await publishPreservedFencePublication(engine, 'default', SLUG, { allowSupersede: true });
  expect((await verifyPreservedFencePublication(engine, 'default', SLUG)).ok).toBe(true);
});

test('a claim or position rewrite of an original row refuses instead of publishing a new mapping', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  await publishPreservedFencePublication(engine, 'default', SLUG);

  await engine.executeRaw(`UPDATE facts SET fact = 'rewritten claim' WHERE id = $1`, [Number(legacyNull)]);
  expect((await verifyPreservedFencePublication(engine, 'default', SLUG)).ok).toBe(false);
  await engine.executeRaw(`UPDATE facts SET fact = 'Legacy unfenced claim' WHERE id = $1`, [Number(legacyNull)]);
  // A restamp of the numbered original (the change the strict ruling forbids) also refuses.
  await engine.executeRaw(`UPDATE facts SET row_num = 9 WHERE id = $1`, [Number(numbered)]);
  const restamped = await verifyPreservedFencePublication(engine, 'default', SLUG);
  expect(restamped.ok).toBe(false);
  expect(restamped.reason).toMatch(/original_or_derived_drift/);
});

test('an added or removed original row refuses: the whole population is pinned, not just candidate ids', async () => {
  await seedPage();
  const { legacyNull } = await seedRealShape();
  await publishPreservedFencePublication(engine, 'default', SLUG);

  const added = await seedFact({ rowNum: null, claim: 'A row added after publication' });
  expect((await verifyPreservedFencePublication(engine, 'default', SLUG)).ok).toBe(false);

  await engine.executeRaw('DELETE FROM facts WHERE id = $1', [Number(added)]);
  expect((await verifyPreservedFencePublication(engine, 'default', SLUG)).ok).toBe(true);
  await engine.executeRaw('DELETE FROM facts WHERE id = $1', [Number(legacyNull)]);
  expect((await verifyPreservedFencePublication(engine, 'default', SLUG)).ok).toBe(false);
});

test('an original page content edit invalidates the stored document', async () => {
  await seedPage();
  await seedRealShape();
  await publishPreservedFencePublication(engine, 'default', SLUG);
  const [pageRow] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug = $1', [SLUG]);

  await engine.executeRaw(`UPDATE pages SET compiled_truth = $2 WHERE slug = $1`, [SLUG, `${pageRow!.compiled_truth}\nhand edit\n`]);
  const drifted = await verifyPreservedFencePublication(engine, 'default', SLUG);
  expect(drifted.ok).toBe(false);
  expect(drifted.reason).toMatch(/original_or_derived_drift/);
  await expect(publishPreservedFencePublication(engine, 'default', SLUG)).rejects.toThrow(/stored_publication_drifted/);
});

test('an absent or altered literal file refuses publication against the pinned body', async () => {
  await seedPage();
  await seedRealShape();
  await publishPreservedFencePublication(engine, 'default', SLUG);
  const body = await fileBody();

  // The literal file is part of the pinned originals: an absent file refuses.
  rmSync(join(root, `${SLUG}.md`));
  await expect(publishPreservedFencePublication(engine, 'default', SLUG)).rejects.toThrow(/original_file_missing/);
  writeFileSync(join(root, `${SLUG}.md`), body);
  expect((await verifyPreservedFencePublication(engine, 'default', SLUG)).ok).toBe(true);
});

test('changed file bytes refuse even though the database page row is unchanged', async () => {
  await seedPage();
  await seedRealShape();
  await publishPreservedFencePublication(engine, 'default', SLUG);
  // Same fence rows, different prose: the literal body is pinned, not just its fence.
  const altered = (await fileBody()).replace('stays literal', 'was edited by hand');
  writeFileSync(join(root, `${SLUG}.md`), altered);
  expect((await verifyPreservedFencePublication(engine, 'default', SLUG)).ok).toBe(false);
});

test('a page without a stored publication reports no_publication and binds nothing', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  expect(await readPreservedFencePublication(engine, 'default', SLUG)).toBeNull();
  expect(await verifyPreservedFencePublication(engine, 'default', SLUG)).toEqual({ ok: false, reason: 'no_publication', bindings: 0 });
  expect(await preservedDerivedPosition(engine, 'default', SLUG, numbered)).toBeNull();
  expect(await preservedOriginalFactIds(engine, 'default', SLUG)).toBeNull();
  expect(legacyNull).toBeTruthy();
});

test('published bindings are addressable per original id and cover exactly the pinned population', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  await publishPreservedFencePublication(engine, 'default', SLUG);
  expect(await preservedDerivedPosition(engine, 'default', SLUG, numbered)).toBe(9);
  expect(await preservedDerivedPosition(engine, 'default', SLUG, legacyNull)).toBe(10);
  expect(await preservedOriginalFactIds(engine, 'default', SLUG)).toEqual(new Set([numbered, legacyNull]));
  expect(await preservedDerivedPosition(engine, 'default', SLUG, '999999')).toBeNull();
});

test('a page with no derivable candidate refuses rather than storing an empty document', async () => {
  await seedPage();
  // The only row is a conversation-miner row that already holds a position: never adopted.
  await seedFact({ rowNum: 6, claim: 'Chat-log row', source: 'cli:extract-conversation-facts' });
  expect(await preservedCandidateIds(engine, 'default', SLUG)).toEqual([]);
  await expect(publishPreservedFencePublication(engine, 'default', SLUG)).rejects.toThrow(/no_candidates/);
  expect(await storedRowCount()).toBe(0);
});

test('the managed preparer refuses a submission that is not the plan of the current originals and writes nothing', async () => {
  await seedPage();
  const { legacyNull, numbered } = await seedRealShape();
  const publication = await planPagePreservedFencePublication(engine, 'default', SLUG);

  const request = (intent: Record<string, unknown>): WriteRequest => ({
    id: '00000000-0000-4000-a000-000000000001', request_id: '00000000-0000-4000-a000-000000000001',
    source_id: 'default', slug: SLUG, source_incarnation: 'incarnation-1', intent,
    state: 'claimed', principal_kind: 'application', principal_id: 'test', operation: 'submit_job',
    authority: { remote: false },
  } as unknown as WriteRequest);

  // Wrong source incarnation -> refuses before any read.
  await expect(preparePreservedFencePublication(engine, request({ publication, source_incarnation: 'other' })))
    .rejects.toThrow(/source changed/);
  // No document -> refuses.
  await expect(preparePreservedFencePublication(engine, request({ source_incarnation: 'incarnation-1' })))
    .rejects.toThrow(/carried no derived document/);
  const prepared = await preparePreservedFencePublication(engine, request({ publication, source_incarnation: 'incarnation-1', expected_revision: null }));
  // A stale document against current originals -> refuses under the page key, nothing written.
  await engine.executeRaw(`UPDATE facts SET source_session = 'drifted' WHERE id = $1`, [Number(legacyNull)]);
  await expect(prepared.validate!(engine)).rejects.toThrow(/changed before the derived document was published/);
  expect(await storedRowCount()).toBe(0);
  // With a stored document on the page, a later drift refuses a non-superseding submission outright.
  await engine.executeRaw(`UPDATE facts SET source_session = 'session-null' WHERE id = $1`, [Number(legacyNull)]);
  await publishPreservedFencePublication(engine, 'default', SLUG);
  await engine.executeRaw(`UPDATE facts SET source_session = 'drifted' WHERE id = $1`, [Number(legacyNull)]);
  await expect(preparePreservedFencePublication(engine, request({ publication, source_incarnation: 'incarnation-1', expected_revision: null })))
    .rejects.toThrow(/drifted derived document already exists/);
  expect(await storedRowCount()).toBe(1);
  expect(numbered).toBeTruthy();
});
