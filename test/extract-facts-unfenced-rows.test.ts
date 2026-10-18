/**
 * #5299: the extract_facts cycle phase fences unfenced fact rows itself.
 *
 * Protects the STRICT-PRESERVATION contract (#6278, plan 2.1/2.2, Decision 57):
 * after ONE cycle every adoptable `row_num IS NULL` fact on a live entity page
 * has a position in that page's DERIVED document, while the original row keeps
 * its id, its position (still NULL), its exact claim text, its provenance and
 * its active state — and the canonical file / page body is not written at all.
 * The derived document is validated against the page's CURRENT originals before
 * it counts as a representation, and rows the codec cannot render refuse their
 * whole page (all-or-refuse), which is reported by location only.
 * Fails when: a cycle stamps a row number onto an original, writes the fence
 * back into the page body/file, rewrites `facts.fact` with the codec's parsed
 * text, inserts a second row for an adopted claim, expires or detaches an
 * adopted row, treats a drifted or a fabricated derived row as current, or lets
 * a non-superseding publication quietly replace a drifted document.
 *
 * CONTRACT MIGRATION (superseded → strict), hunk by hunk. This body still
 * asserted the SUPERSEDED fence-stamping contract, which the candidate
 * (commit 037308e10 migrated its 25 siblings, this body was missed) replaced:
 *   (1) "rows adopt with normalized text under their ids" → adopted positions
 *       and codec-normalized text now exist ONLY in the derived document; the
 *       original keeps its raw text and its NULL position. The fence-file and
 *       `facts.fact` assertions moved to `readPreservedFencePublication` /
 *       `derivedFenceOf` assertions.
 *   (2) "one cycle fences row_num-NULL facts onto the page file" → the file is
 *       asserted byte-identical; the derived document carries the positions.
 *   (3) "a rejected row of a page still lets the page adopt the others" → the
 *       planner is all-or-refuse per page (`unadoptable_candidates`), so a page
 *       holding an unrenderable candidate publishes NOTHING and its adoptable
 *       rows stay unfenced and pending; the refusal is named in the stable
 *       `FACTS_FENCE_FAILED` token.
 *   (4) "the withdrawal trigger fires on the adopted write-back" → there is no
 *       write-back any more, so the withdrawn row keeps its exact original text
 *       and stays active; the withdrawal ledger is enforced by its own layer.
 *   (5) every "the DB row carries those row numbers" assertion is replaced by a
 *       full-original-population comparison (every discovered column, byte for
 *       byte) plus explicit id/position/text/provenance assertions.
 * New negative controls required by the same ruling, added here:
 *   (6) a fence row in the stored document that no binding backs is STILL
 *       reported as drift, and a non-superseding publication refuses it.
 *   (7) an adopted row is exempt only while the page's derived document is the
 *       plan of its CURRENT originals: a provenance change makes the row pending
 *       again and the page keeps its index.
 * Seams: real PGLite (and Postgres through the e2e registration), `runCycle`
 * with `phases: ['extract_facts']`, the shared `managedBrain` and legacy managed
 * fixtures.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCycle } from '../src/core/cycle.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { stableJson } from '../src/core/persistence/digest.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import {
  PRESERVED_FENCE_SOURCE, derivedFenceOf, discoverOriginalColumns, preservedFencePublicationState,
  readPreservedFencePublication,
} from '../src/core/facts/preserved-fence-store.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_DB_ONLY_SLUG, LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/alice-example';

/** Every original column of every row: the strict contract is literal equality, not a field spot-check. */
async function originalDigests(engine: BrainEngine) {
  const columns = await discoverOriginalColumns(engine);
  const facts = await engine.executeRaw('SELECT * FROM facts ORDER BY id');
  const pages = await engine.executeRaw('SELECT * FROM pages ORDER BY id');
  return { columns, facts, pages };
}

/** Complete rows of the original facts this fixture seeds, by id. */
async function factRows(engine: BrainEngine, ids: number[]) {
  return engine.executeRaw('SELECT * FROM facts WHERE id = ANY($1::integer[]) ORDER BY id', [ids]);
}

/**
 * One page's original content as the publication contract sees it: the two
 * derivative index columns the run's own text projection and chunker refresh
 * (`MAINTENANCE_REFRESHED_PAGE_COLUMNS`) are held constant, everything else —
 * body, frontmatter, title, timeline, revision, hash — is compared literally.
 */
async function pageOriginals(engine: BrainEngine, slug: string) {
  const [page] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM pages WHERE source_id = 'default' AND slug = $1`, [slug]);
  const row: Record<string, unknown> = { ...page };
  row.chunker_version = null;
  row.text_projection_revision = null;
  return row;
}

/**
 * The guard's own predicate, re-derived independently: the active `row_num IS
 * NULL` rows of live entity pages in a source with a checkout (#2484/#2646/
 * #2764/#3526/#6264), MINUS the rows a CURRENT derived document binds — a row a
 * current document represents is exempt (strict preservation keeps its NULL
 * position), and a drifted document binds nothing.
 */
async function pendingCount(engine: BrainEngine, sourceId = 'default'): Promise<number> {
  const rows = await engine.executeRaw<{ id: string | number; entity_slug: string }>(
    `SELECT f.id, f.entity_slug FROM facts f
      WHERE f.source_id = $1 AND f.row_num IS NULL AND f.dimension IS NULL
        AND f.entity_slug IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = f.source_id AND s.local_path IS NOT NULL)
      ORDER BY f.entity_slug, f.id`, [sourceId]);
  const bound = new Map<string, Set<string>>();
  let count = 0;
  for (const row of rows) {
    if (!bound.has(row.entity_slug)) {
      const state = await preservedFencePublicationState(engine, sourceId, row.entity_slug);
      bound.set(row.entity_slug, state.state === 'current' ? state.boundFactIds : new Set<string>());
    }
    if (!bound.get(row.entity_slug)!.has(String(row.id))) count += 1;
  }
  return count;
}

/** The stored derived documents of one brain (one row per page that has one). */
async function storedPublicationCount(engine: BrainEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ n: string }>(`SELECT COUNT(*) AS n FROM raw_data WHERE source = $1`, [PRESERVED_FENCE_SOURCE]);
  return Number(row!.n);
}

async function factState(engine: BrainEngine) {
  return engine.executeRaw<{ id: number; entity_slug: string | null; fact: string; row_num: number | null; source_markdown_slug: string | null; expired: boolean }>(
    `SELECT id, entity_slug, fact, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired FROM facts ORDER BY id`);
}

/** The same literal projection with `id` read through the driver's bigint/number shape. */
async function factStateProjection(engine: BrainEngine) {
  return (await factState(engine)).map(row => ({ ...row, id: Number(row.id) }));
}

async function extractFactsPhase(engine: BrainEngine, root: string) {
  const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
  return report.phases.find(p => p.phase === 'extract_facts')!;
}

const FENCE_ROW_1 = `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice example joined Acme example | fact | 1.0 | world | high | 2024-01-01 |  | linkedin |  |
<!--- gbrain:facts:end -->
`;

/** An unmanaged brain whose default source checkout holds one entity page with one indexed fence row, plus unfenced rows. */
async function unmanagedBrain(databaseUrl: string | undefined, run: (brain: { engine: BrainEngine; root: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-unfenced-home-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const page = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: `# Alice Example\n\nProse.\n\n${FENCE_ROW_1}` });
        await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, page.id]);
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
        const path = join(root, `${SLUG}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
        // The fence row already indexed, as an earlier reconcile left it.
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
           VALUES ('default', $1, 'Alice example joined Acme example', 'fact', 'world', 'high', '2024-01-01', 'linkedin', 1.0, 1, $1)`, [SLUG]);
        // Rows the inline writer's DB-only fallback produced (row_num NULL).
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
           VALUES ('default', $1, 'Alice example moved to Lisbon', 'fact', 'private', 'medium', '2026-02-05T13:45:12Z', 'mcp:remember', 0.9),
                  ('default', $1, 'Alice example prefers async updates', 'preference', 'private', 'medium', '2026-03-01', 'mcp:remember', 0.8),
                  ('default', 'people-jane-doe', 'Unfenceable: no backing page', 'fact', 'private', 'medium', now(), 'mcp:remember', 1.0),
                  ('default', NULL, 'Unfenceable: no entity', 'fact', 'private', 'medium', now(), 'mcp:remember', 1.0)`, [SLUG]);
        await run({ engine, root });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Legacy rows in every shape the fence codec changes (#6278), on `slug`; returns ids keyed by shape. */
async function seedCodecShapes(engine: BrainEngine, slug: string, source = 'mcp:remember'): Promise<Record<string, number>> {
  const shapes: Record<string, string> = {
    trailing: 'Alice example likes tea ',
    crlf: 'Alice example works\r\nremotely',
    nbsp: '\u00a0Alice example runs marathons',
    whitespace_only: '   ',
    struck: '~~Alice example left Acme example~~',
    br: 'Alice example<br>uses tabs',
    duplicate: 'Alice example likes tea',
  };
  const ids: Record<string, number> = {};
  for (const [shape, fact] of Object.entries(shapes)) {
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, context)
       VALUES ('default', $1, $2, 'fact', 'world', 'medium', '2026-03-01', $3, 0.8, 'from a call') RETURNING id`, [slug, fact, source]);
    ids[shape] = Number(row.id);
  }
  return ids;
}

const UNADOPTABLE_TOKEN = (slug: string) => `FACTS_FENCE_FAILED: ${slug} (fence_unrenderable: 3 row(s), empty, line_break_markup, struck; duplicate_claim: 1 row(s))`;

async function rowsById(engine: BrainEngine, ids: number[]) {
  return engine.executeRaw<{ id: number; fact: string; row_num: number | null; source_markdown_slug: string | null; expired: boolean; embedding: string | null; source_session: string | null }>(
    `SELECT id, fact, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired, embedding::text AS embedding, source_session
       FROM facts WHERE id = ANY($1::integer[]) ORDER BY id`, [ids]);
}

/** The second page the codec-shape fixtures reconcile alongside: one stale fence-owned row. */
async function seedOtherPage(engine: BrainEngine, root: string, other: string): Promise<number> {
  const page = await engine.putPage(other, { type: 'company', title: 'Acme Example', compiled_truth: `# Acme Example\n\n${FENCE_ROW_1.replace('Alice example joined Acme example', 'Acme example ships widgets')}` });
  await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${other}.md`, page.id]);
  const snapshot = (await engine.readPageSnapshot(other, { sourceId: 'default' }))!;
  mkdirSync(dirname(join(root, `${other}.md`)), { recursive: true });
  writeFileSync(join(root, `${other}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
  const [stale] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
     VALUES ('default', $1, 'Acme example used to ship gadgets', 'fact', 'world', 'high', '2024-01-01', 'linkedin', 1.0, 9, $1) RETURNING id`, [other]);
  return Number(stale.id);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: unmanaged: codec shapes: a page holding an unrenderable candidate publishes nothing, keeps every original and its file, and the other page still reconciles`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      const ids = await seedCodecShapes(engine, SLUG);
      const OTHER = 'companies/acme-example';
      const staleId = await seedOtherPage(engine, root, OTHER);
      const seeds = Object.values(ids);
      const rowsBefore = await rowsById(engine, seeds);
      const before = { rows: await factRows(engine, seeds), page: await pageOriginals(engine, SLUG), state: await factStateProjection(engine) };
      const fileBefore = readFileSync(join(root, `${SLUG}.md`), 'utf8');

      const first = await extractFactsPhase(engine, root);
      expect(first.status).toBe('warn');
      // All-or-refuse: this page placed no derived position at all, and every
      // candidate row of it is still pending. The other page reconciled.
      expect(first.details).toMatchObject({ legacyRowsPending: 9, unfencedRowsFenced: 0, factsInserted: 1, factsDeleted: 1 });
      expect(first.summary).toMatch(new RegExp('^1 fact\\(s\\) reconciled across 1 page\\(s\\); skipped 1 page\\(s\\) holding 9 unfenced fact row\\(s\\) that could not be fenced: ' + SLUG + ' '));
      const warnings = (first.details as { warnings: string[] }).warnings;
      expect(warnings).toContain(UNADOPTABLE_TOKEN(SLUG));
      // Location only: no rejected claim text reaches the warnings.
      expect(warnings.join('\n')).not.toContain('left Acme example');
      expect(warnings.join('\n')).not.toContain('uses tabs');

      // No derived document: the refusal is all-or-refuse, not a partial publication.
      expect(await preservedFencePublicationState(engine, 'default', SLUG)).toEqual({ state: 'none' });
      expect(await readPreservedFencePublication(engine, 'default', SLUG)).toBeNull();
      expect(await storedPublicationCount(engine)).toBe(0);
      expect(await pendingCount(engine)).toBe(9);

      // Strict: the canonical file, the page body and every original row (every
      // discovered column, byte for byte) are exactly as they were — including
      // each adopted-shape candidate and each rejected one.
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(fileBefore);
      expect(await pageOriginals(engine, SLUG)).toEqual(before.page);
      expect(await factRows(engine, seeds)).toEqual(before.rows);
      expect(await rowsById(engine, seeds)).toEqual(rowsBefore);
      for (const row of await rowsById(engine, seeds)) {
        expect(row.row_num).toBeNull();
        expect(row.expired).toBe(false);
      }

      // The other page reconciled in the same run: its stale row expired, its fence row indexed.
      const [staleRow] = await engine.executeRaw<{ expired: boolean; row_num: number | null }>('SELECT expired_at IS NOT NULL AS expired, row_num FROM facts WHERE id = $1', [staleId]);
      expect(staleRow).toMatchObject({ expired: true, row_num: null });
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE source_markdown_slug = $1 AND row_num = 1 AND expired_at IS NULL', [OTHER])).toHaveLength(1);

      const fileAfter = readFileSync(join(root, `${SLUG}.md`), 'utf8');
      const second = await extractFactsPhase(engine, root);
      expect(second.status).toBe('warn');
      expect(second.details).toMatchObject({ legacyRowsPending: 9, unfencedRowsFenced: 0 });
      expect((second.details as { warnings: string[] }).warnings).toContain(UNADOPTABLE_TOKEN(SLUG));
      expect(await factRows(engine, seeds)).toEqual(before.rows);
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(fileAfter);
    });
  }, 120_000);

  test(`${backend}: managed: codec shapes: the same all-or-refuse refusal through the coordinator, the withdrawn row keeps its exact text, and a page without unadoptable rows still publishes`, async () => {
    let seed!: LegacySeed;
    let ids!: Record<string, number>;
    let withdrawnId!: number;
    const OTHER = 'people/bob-example';
    await managedBrain(async ({ engine: managed, root: managedRoot }) => {
      const seeds = [...seed.legacyFactIds, ...Object.values(ids), withdrawnId, ...seed.dbOnlyFactIds];
      const before = { rows: await factRows(managed, seeds), page: await pageOriginals(managed, LEGACY_FILE_SLUG) };
      const fileBefore = readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const withdrawnBefore = await rowsById(managed, [withdrawnId]);

      const first = await extractFactsPhase(managed, managedRoot);
      expect(first.status).toBe('warn');
      // 10 rows pending: the file page's own legacy rows (2), its codec shapes (7)
      // and the withdrawn candidate (1); the db-only page published its single row.
      expect(first.details).toMatchObject({ legacyRowsPending: 10, unfencedRowsFenced: 1 });
      expect((first.details as { warnings: string[] }).warnings).toContain(UNADOPTABLE_TOKEN(LEGACY_FILE_SLUG));

      // The file page refused as a whole: no document, nothing stamped, the file untouched.
      expect(await preservedFencePublicationState(managed, 'default', LEGACY_FILE_SLUG)).toEqual({ state: 'none' });
      expect(readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(fileBefore);
      expect(await pageOriginals(managed, LEGACY_FILE_SLUG)).toEqual(before.page);
      expect(await factRows(managed, seeds)).toEqual(before.rows);
      const seeded = await rowsById(managed, seed.legacyFactIds);
      expect(seeded.every(row => row.row_num === null && !row.expired && row.embedding !== null)).toBe(true);
      // (4) The withdrawal no longer fires on an adopted write-back (there is no
      // write-back): the withdrawn candidate is exactly as it was.
      expect(await rowsById(managed, [withdrawnId])).toEqual(withdrawnBefore);
      expect((await rowsById(managed, [withdrawnId]))[0]!.fact).toBe('  Alice example drinks tea  ');

      // The page without an unadoptable candidate published through the coordinator:
      // one derived position for its row, its original untouched, and the document
      // is the plan of its current originals.
      const dbOnly = await readPreservedFencePublication(managed, 'default', LEGACY_DB_ONLY_SLUG);
      expect(dbOnly!.bindings).toHaveLength(1);
      expect(dbOnly!.bindings[0]!.original_row_num).toBeNull();
      expect(dbOnly!.bindings[0]!.derived_row_num).toBe(1);
      expect((await preservedFencePublicationState(managed, 'default', LEGACY_DB_ONLY_SLUG)).state).toBe('current');
      const [dbOnlyRow] = await managed.executeRaw<{ fact: string; row_num: number | null; expired_at: unknown }>(
        'SELECT fact, row_num, expired_at FROM facts WHERE id = $1', [Number(dbOnly!.bindings[0]!.original_fact_id)]);
      expect(dbOnlyRow).toMatchObject({ fact: 'Dana example advises Widget co', row_num: null, expired_at: null });

      // Another page of the source reconciled in the same run.
      expect(await managed.executeRaw('SELECT 1 FROM facts WHERE source_markdown_slug = $1 AND row_num = 1 AND expired_at IS NULL', [OTHER])).toHaveLength(1);
      expect(await pageOriginals(managed, LEGACY_FILE_SLUG)).toEqual(before.page);
      expect(await factRows(managed, seeds)).toEqual(before.rows);
    }, { databaseUrl, setup: async ({ engine: managed, root: managedRoot }) => {
      seed = await seedLegacyManagedContent(managed, managedRoot);
      ids = await seedCodecShapes(managed, LEGACY_FILE_SLUG);
      const [withdrawn] = await managed.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
         VALUES ('default', $1, '  Alice example drinks tea  ', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8) RETURNING id`, [LEGACY_FILE_SLUG]);
      withdrawnId = Number(withdrawn.id);
      await managed.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash, withdrawn_at)
        VALUES ('default', 'world', '*', gbrain_fact_fingerprint('Alice example drinks tea'), '2026-04-01T00:00:00Z')`);
      await seedOtherPage(managed, managedRoot, OTHER);
      void ids;
    } });
  }, 180_000);

  test(`${backend}: unmanaged: one cycle publishes the derived document, leaves the file and every original byte-identical, and a second cycle is a no-op`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      const before = await originalDigests(engine);
      const stateBefore = await factStateProjection(engine);
      const fileBefore = readFileSync(join(root, `${SLUG}.md`), 'utf8');
      expect(await pendingCount(engine)).toBe(2);

      const first = await extractFactsPhase(engine, root);
      expect(first.status).toBe('ok');
      expect(first.details).toMatchObject({ unfencedRowsFenced: 2, pagesFailed: 0, legacyRowsPending: 0 });
      // A row a CURRENT document binds is represented, so it is no longer pending.
      expect(await pendingCount(engine)).toBe(0);

      // Strict: the canonical file and the page body are NOT the fence any more.
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(fileBefore);
      const [pageRow] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE slug = $1', [SLUG]);
      expect(parseFactsFence(pageRow!.compiled_truth).facts.map(f => f.rowNum)).toEqual([1]);

      // The derived document is the plan of the current originals and carries the positions.
      const publication = (await readPreservedFencePublication(engine, 'default', SLUG))!;
      expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
      expect(await storedPublicationCount(engine)).toBe(1);
      expect(derivedFenceOf(publication).map(row => [row.rowNum, row.claim])).toEqual([
        [1, 'Alice example joined Acme example'],
        [2, 'Alice example moved to Lisbon'],
        [3, 'Alice example prefers async updates'],
      ]);
      // Every original id is pinned with its literal position: the fence row keeps 1,
      // the two NULL originals stay NULL and only their derived positions move.
      const bindings = new Map(publication.bindings.map(binding => [binding.original_fact_id, binding]));
      expect(bindings.size).toBe(3);
      expect([...bindings.values()].map(b => [b.original_row_num, b.derived_row_num])).toEqual([[1, 1], [null, 2], [null, 3]]);

      // Strict: ids, positions (including NULL), text, provenance and expiry are literal.
      expect(stableJson(await originalDigests(engine))).toBe(stableJson(before));
      // `id` is compared by value: Postgres returns bigint for a bigserial
      // (Bun prints 1n), PGLite a number, and the projection under test is the
      // literal text/position/provenance of every row, not its driver type.
      expect(await factStateProjection(engine)).toEqual(stateBefore);

      const second = await extractFactsPhase(engine, root);
      expect(second.status).toBe('ok');
      expect(second.details).toMatchObject({ unfencedRowsFenced: 0, factsInserted: 0, factsDeleted: 0, legacyRowsPending: 0 });
      // Extraction itself is a no-op; the completion step re-derives the
      // document from the CURRENT complete originals. Only the source binding
      // may move, so every other field of the stored document must be the
      // extract_facts plan unchanged — and only ONE row may exist.
      const completed = (await readPreservedFencePublication(engine, 'default', SLUG))!;
      expect({ ...completed, original_source_sha256: publication.original_source_sha256 }).toEqual(publication);
      expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
      expect(await storedPublicationCount(engine)).toBe(1);
      expect(stableJson(await originalDigests(engine))).toBe(stableJson(before));
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(fileBefore);
    });
  }, 120_000);

  test(`${backend}: unmanaged: a page whose canonical file is missing keeps its rows unfenced and is named in the warning`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      rmSync(join(root, `${SLUG}.md`));
      const before = await factStateProjection(engine);
      const result = await extractFactsPhase(engine, root);
      expect(result.status).toBe('warn');
      expect(result.summary).toBe(`0 fact(s) reconciled across 0 page(s); skipped 1 page(s) holding 2 unfenced fact row(s) that could not be fenced: ${SLUG} (2 warning(s))`);
      const warnings = (result.details as { warnings: string[] }).warnings;
      expect(warnings.some(w => w.startsWith(`FACTS_FENCE_FAILED: ${SLUG} (canonical file `) && w.includes('does not exist on this host'))).toBe(true);
      expect(warnings.some(w => w.includes('v0.31') || w.includes('force-retry'))).toBe(false);
      expect(await factStateProjection(engine)).toEqual(before);
      expect(await preservedFencePublicationState(engine, 'default', SLUG)).toEqual({ state: 'none' });
    });
  }, 120_000);

  test(`${backend}: managed: one cycle publishes through the coordinator without touching an original, and a second cycle is a no-op`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine: managed, root: managedRoot }) => {
      const seeds = [...seed.legacyFactIds, ...seed.dbOnlyFactIds];
      const before = { rows: await factRows(managed, seeds), page: await pageOriginals(managed, LEGACY_FILE_SLUG) };
      const fileBefore = readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      expect(await pendingCount(managed)).toBe(3);
      const first = await extractFactsPhase(managed, managedRoot);
      expect(first.status).toBe('ok');
      expect(first.details).toMatchObject({ unfencedRowsFenced: 3, pagesFailed: 0, legacyRowsPending: 0 });
      expect(await pendingCount(managed)).toBe(0);

      // The file page's two legacy rows adopted in place — positions derived
      // above the row its fence already carries, originals untouched.
      const publication = (await readPreservedFencePublication(managed, 'default', LEGACY_FILE_SLUG))!;
      expect(publication.bindings.map(b => [b.original_fact_id, b.original_row_num, b.derived_row_num]))
        .toEqual([[String(seed.legacyFactIds[0]), null, 2], [String(seed.legacyFactIds[1]), null, 3]]);
      expect((await preservedFencePublicationState(managed, 'default', LEGACY_FILE_SLUG)).state).toBe('current');
      const rows = await managed.executeRaw<{ id: number; row_num: number | null; expired: boolean; embedding: string | null }>(
        `SELECT id, row_num, expired_at IS NOT NULL AS expired, embedding::text AS embedding
           FROM facts WHERE id = ANY($1::integer[]) ORDER BY id`, [[...seed.legacyFactIds, ...seed.dbOnlyFactIds]]);
      expect(rows.map(r => [Number(r.id), r.row_num, r.expired])).toEqual([
        [seed.legacyFactIds[0], null, false],
        [seed.legacyFactIds[1], null, false],
        [seed.dbOnlyFactIds[0], null, false],
      ]);
      // The seeded legacy rows kept their vectors: nothing was rewritten.
      expect(rows.every(r => r.embedding !== null)).toBe(true);

      // The canonical file, the page content and every original fact row are literal.
      expect(readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(fileBefore);
      expect(await pageOriginals(managed, LEGACY_FILE_SLUG)).toEqual(before.page);
      expect(await factRows(managed, seeds)).toEqual(before.rows);
      // The db-only page gained no fence in its body either.
      const dbOnly = (await managed.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!;
      expect(parseFactsFence(dbOnly.page.compiled_truth).facts).toHaveLength(0);

      const [{ n: requests }] = await managed.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests');
      const second = await extractFactsPhase(managed, managedRoot);
      expect(second.status).toBe('ok');
      expect(second.details).toMatchObject({ unfencedRowsFenced: 0, factsInserted: 0, factsDeleted: 0, legacyRowsPending: 0 });
      expect(await pageOriginals(managed, LEGACY_FILE_SLUG)).toEqual(before.page);
      expect(await factRows(managed, seeds)).toEqual(before.rows);
      expect(readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(fileBefore);
      // No new extraction request; ONE journaled source completion transition.
      expect((await managed.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0].n).toBe(requests + 1);
    }, { databaseUrl, setup: async ({ engine: managed, root: managedRoot }) => { seed = await seedLegacyManagedContent(managed, managedRoot); } });
  }, 180_000);

  test(`${backend}: unmanaged: a derived row that no binding backs is still reported as drift and never silently replaced`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      await extractFactsPhase(engine, root);
      const publication = (await readPreservedFencePublication(engine, 'default', SLUG))!;
      const before = await originalDigests(engine);
      const fileBefore = readFileSync(join(root, `${SLUG}.md`), 'utf8');

      // A fence row in the stored document with no original bound to it.
      const tampered = publication.derived_body.replace('<!--- gbrain:facts:end -->',
        '| 99 | A derived row with no bound fact | fact | 1.0 | world | high | 2024-01-01 |  | linkedin |  |\n<!--- gbrain:facts:end -->');
      await engine.executeRaw(
        `UPDATE raw_data SET data = $1::text::jsonb WHERE source = $2 AND page_id = (SELECT id FROM pages WHERE source_id = 'default' AND slug = $3)`,
        [JSON.stringify({ ...publication, derived_body: tampered }), PRESERVED_FENCE_SOURCE, SLUG]);

      // (6) It is drift, not authority: never read as the page's current document.
      const state = await preservedFencePublicationState(engine, 'default', SLUG);
      expect(state.state).toBe('drifted');
      if (state.state === 'drifted') expect(state.reason).toMatch(/original_or_derived_drift/);
      expect(await pendingCount(engine)).toBe(2);

      // A publication that does not ask to supersede refuses it by name and writes nothing.
      const refusal = await fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId: 'default', adoptStamped: true }), { allowSupersede: false });
      expect(refusal.fenced).toBe(0);
      expect(refusal.failed_pages.some(page => page.startsWith(`${SLUG} (`) && page.includes('stored_publication_drifted'))).toBe(true);
      expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('drifted');
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(fileBefore);
      expect(stableJson(await originalDigests(engine))).toBe(stableJson(before));

      // The cycle replans the truthful document from the current originals: the
      // fabricated row is gone and no original was touched.
      const healed = await extractFactsPhase(engine, root);
      expect(healed.details).toMatchObject({ unfencedRowsFenced: 2, legacyRowsPending: 0 });
      const replanned = (await readPreservedFencePublication(engine, 'default', SLUG))!;
      expect(replanned.derived_body).not.toContain('no bound fact');
      expect(derivedFenceOf(replanned).map(row => row.rowNum)).toEqual([1, 2, 3]);
      expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
      expect(stableJson(await originalDigests(engine))).toBe(stableJson(before));
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(fileBefore);
    });
  }, 120_000);

  test(`${backend}: unmanaged: an adopted row is exempt only while the page's derived document is the plan of its current originals`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      await extractFactsPhase(engine, root);
      const publication = (await readPreservedFencePublication(engine, 'default', SLUG))!;
      const boundNull = Number(publication.bindings.find(binding => binding.original_row_num === null)!.original_fact_id);
      expect(await pendingCount(engine)).toBe(0);

      // A provenance change on a bound original invalidates the document.
      await engine.executeRaw(`UPDATE facts SET source_session = 'drifted-by-hand' WHERE id = $1`, [boundNull]);
      const state = await preservedFencePublicationState(engine, 'default', SLUG);
      expect(state.state).toBe('drifted');
      if (state.state === 'drifted') expect(state.reason).toMatch(/original_or_derived_drift/);

      // (7) The rows are pending again — the exemption is bound to the CURRENT
      // validated document — and the page keeps its index. A write-free read of
      // the phase shows the guard firing with no deletion.
      expect(await pendingCount(engine)).toBe(2);
      const guarded = await runExtractFacts(engine, { sourceId: 'default', slugs: [SLUG], dryRun: true, brainDir: root });
      expect(guarded.guardTriggered).toBe(true);
      expect(guarded.legacyRowsPending).toBe(2);
      expect(guarded.factsDeleted).toBe(0);

      // The cycle replans the projection from the current originals, and the
      // drifted original is still exactly what the writer made it: text, NULL
      // position and drifted provenance — never restored, rewritten or expired.
      const healed = await extractFactsPhase(engine, root);
      expect(healed.details).toMatchObject({ unfencedRowsFenced: 2, legacyRowsPending: 0, factsDeleted: 0 });
      expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
      const [row] = await engine.executeRaw<{ fact: string; row_num: number | null; source_session: string | null; expired_at: unknown }>(
        'SELECT fact, row_num, source_session, expired_at FROM facts WHERE id = $1', [boundNull]);
      expect(row).toMatchObject({ fact: 'Alice example moved to Lisbon', row_num: null, source_session: 'drifted-by-hand', expired_at: null });
      expect(await pendingCount(engine)).toBe(0);
    });
  }, 120_000);
}
