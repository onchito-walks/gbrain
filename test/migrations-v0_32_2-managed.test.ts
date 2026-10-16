/**
 * v0.32.2 fence backfill on a managed brain.
 *
 * Protects: on a managed brain the backfill publishes each entity page's
 * facts fence through the coordinator and adopts the legacy fact rows in
 * place (managed_maintenance_adopt_fact_fence), for file-backed and
 * database-only pages alike, and verify reads a page holding a duplicate
 * active fence row as in sync whether the publication or extract_facts
 * indexed it last (#5814).
 * Fails when: the phase writes fence files into the managed worktree or
 * runs a raw `UPDATE facts` (the managed writer guard refuses it and the
 * orchestrator chain wedges), when adoption inserts duplicate rows instead
 * of keeping the legacy ids and vectors, or when it expires a
 * conversation-extractor row on the same page, or when verify counts every
 * fence row against the index although extract_facts indexes a duplicate once.
 * Seams: none; `managedBrain` and the migration's exported `__testing` phases.
 *
 * #6278 (2.1, 2.6): a page whose timeline repeats the facts fence marker is
 * skipped before submission with the fence reason (no request is admitted,
 * so no preparation refusal and no consumed request id) while the other
 * page still adopts; a legacy row the codec cannot render is reported with
 * the stable `FACTS_FENCE_FAILED: <slug> (fence_unrenderable: …)` token in
 * the phase detail while the page's other rows adopt. Fails when: the
 * adoption is admitted and fails at preparation (`invalid_params`, the
 * reporter's two repeated_marker refusals), or the unrenderable row refuses
 * the whole page.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { __testing } from '../src/commands/migrations/v0_32_2.ts';
import type { OrchestratorOpts } from '../src/commands/migrations/types.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../src/core/facts-fence.ts';
import { derivedFenceOf, readPreservedFencePublication } from '../src/core/facts/preserved-fence-store.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { maintenancePreflight, submitFactFenceAdoption } from '../src/core/persistence/prepared-maintenance.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_DB_ONLY_SLUG, LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const OPTS: OrchestratorOpts = { yes: true, dryRun: false, noAutopilotInstall: true };

async function factRows(engine: BrainEngine, ids: number[]) {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT id, row_num, source_markdown_slug, fact, expired_at, embedding::text AS embedding, embedded_at::text AS embedded_at,
            source_session, confidence, notability, context, (extract(epoch FROM valid_from))::bigint AS valid_from_epoch FROM facts WHERE id = ANY($1::integer[]) ORDER BY id`, [ids]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: legacy facts are published as each page's derived document, with every original untouched`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const adopted = [...seed.legacyFactIds, ...seed.dbOnlyFactIds];
      const before = await factRows(engine, [...adopted, seed.extractorFactId]);
      const [{ n: factCount }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');
      const fileBefore = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const dbOnlyBefore = (await engine.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!;
      const takesBefore = await engine.executeRaw('SELECT row_num, resolved_quality, resolved_by FROM takes ORDER BY row_num');

      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'complete' });
      expect(phase.detail).toContain('scanned=3 fenced=3 pages=2');
      expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'complete', detail: 'pages_checked=2' });

      // Strict preservation: every original row (identity, position, provenance
      // and vector), the canonical file and both page bodies are exactly as they
      // were before the backfill.
      expect(await factRows(engine, [...adopted, seed.extractorFactId])).toEqual(before);
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts'))[0].n).toBe(factCount);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(fileBefore);
      // The page's own content, frontmatter and provenance are untouched; only
      // the derivative text-projection revision the publication refreshes moves.
      const danaAfter = (await engine.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!;
      expect(danaAfter.page.compiled_truth).toBe(dbOnlyBefore.page.compiled_truth);
      expect(danaAfter.page.frontmatter).toEqual(dbOnlyBefore.page.frontmatter);
      expect(danaAfter.page.source_path).toBe(dbOnlyBefore.page.source_path);

      // The adopted positions live in each page's own derived document: position
      // 1 is the extractor row's, so the two legacy rows take the next free ones.
      const alice = (await readPreservedFencePublication(engine, 'default', LEGACY_FILE_SLUG))!;
      expect(alice.bindings.map(b => [b.original_fact_id, b.original_row_num, b.derived_row_num]))
        .toEqual([[String(seed.legacyFactIds[0]), null, 2], [String(seed.legacyFactIds[1]), null, 3]]);
      expect(derivedFenceOf(alice).map(f => [f.rowNum, f.claim]))
        .toEqual([[2, 'Alice example founded Acme example'], [3, 'Alice example moved to Lisbon']]);
      const dana = (await readPreservedFencePublication(engine, 'default', LEGACY_DB_ONLY_SLUG))!;
      expect(dana.bindings.map(b => [b.original_fact_id, b.original_row_num, b.derived_row_num]))
        .toEqual([[String(seed.dbOnlyFactIds[0]), null, 1]]);
      expect(existsSync(join(root, `${LEGACY_DB_ONLY_SLUG}.md`))).toBe(false);

      // The takes index is untouched too: the publication writes no page content,
      // so the takes projection is not re-run as a side effect of adopting.
      expect(await engine.executeRaw('SELECT row_num, resolved_quality, resolved_by FROM takes ORDER BY row_num')).toEqual(takesBefore);

      const rerun = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(rerun).toMatchObject({ status: 'complete' });
      // adoptStamped scans the three non-cli rows even when they are already
      // published; a current document is a true no-op — nothing is rewritten.
      expect(rerun.detail).toBe('scanned=3 fenced=0 pages=0 skipped_no_entity=0 skipped_no_local_path=0 skipped_no_page=0');
      expect(await factRows(engine, [...adopted, seed.extractorFactId])).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(fileBefore);
      expect((await engine.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!.page.compiled_truth)
        .toBe(dbOnlyBefore.page.compiled_truth);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      // A take graded only in the database, as a pre-activation grader left it.
      const [{ id }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [LEGACY_FILE_SLUG]);
      await engine.addTakesBatch([{ page_id: id, row_num: 1, claim: 'Acme example raised a seed round', kind: 'fact', holder: 'world',
        weight: 1, since_date: '2026-01', source: 'press note', active: true, superseded_by: null }]);
      await engine.resolveTake(id, 1, { quality: 'correct', source: 'grader note', resolvedBy: 'people/alice-example' });
    } });
  }, 120_000);

  test(`${backend}: a page whose timeline repeats the facts fence marker keeps the defect and still publishes its document (#6278 2.6)`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const before = await factRows(engine, seed.legacyFactIds);
      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      // The publication writes no page content, so the timeline defect neither
      // blocks it nor is written over: it stays exactly where the user left it,
      // and the doctor's fence census still owns repairing it.
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'complete' });
      expect(phase.detail).toContain('scanned=3 fenced=3 pages=2');
      expect(await factRows(engine, seed.legacyFactIds)).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
      const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      expect(snapshot.page.timeline).toContain('## Facts');
      const derived = derivedFenceOf((await readPreservedFencePublication(engine, 'default', LEGACY_FILE_SLUG))!);
      expect(derived.map(row => row.claim)).toContain('Alice example founded Acme example');
      expect(derived.map(row => row.claim)).toContain('Alice example moved to Lisbon');
      // The database-only page published its row in the same pass.
      const [dana] = await factRows(engine, seed.dbOnlyFactIds);
      expect(dana).toMatchObject({ row_num: null, source_markdown_slug: null, expired_at: null });
      expect(derivedFenceOf((await readPreservedFencePublication(engine, 'default', LEGACY_DB_ONLY_SLUG))!)).toHaveLength(1);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      const fence = (n: number, claim: string) => renderFactsTable([{ rowNum: n, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true, source: 'notes' }]);
      const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      await engine.putPage(LEGACY_FILE_SLUG, { ...snapshot.page, compiled_truth: snapshot.page.compiled_truth,
        timeline: `## Facts\n\n${fence(1, 'Alice example keeps bees')}\n\n## Facts\n\n${fence(2, 'Alice example keeps bees too')}\n` });
      const updated = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      writeFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), serializePageToMarkdown(updated.page, updated.tags));
    } });
  }, 120_000);

  test(`${backend}: a legacy row the fence codec cannot render refuses its whole page, and the stable token names it (#6278 2.1)`, async () => {
    let seed!: LegacySeed;
    let struckId!: number;
    await managedBrain(async ({ engine, root }) => {
      const [struckBefore] = await factRows(engine, [struckId]);
      const before = await factRows(engine, [...seed.legacyFactIds, struckId]);
      const fileBefore = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase.status).toBe('failed');
      expect(phase.detail).toContain('scanned=4 fenced=1 pages=1 ');
      // A document is published all-or-refuse: the page carrying the row the codec
      // cannot render stores nothing, and its rows stay exactly as they are.
      expect(phase.detail).toContain(`FACTS_FENCE_FAILED: ${LEGACY_FILE_SLUG} (fence_unrenderable: 1 row(s), struck)`);
      expect(phase.detail).not.toContain('left Acme');
      expect(await readPreservedFencePublication(engine, 'default', LEGACY_FILE_SLUG)).toBeNull();
      expect(await factRows(engine, [...seed.legacyFactIds, struckId])).toEqual(before);
      expect(await factRows(engine, [struckId])).toEqual([struckBefore]);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(fileBefore);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      const [row] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
         VALUES ('default', $1, '~~Alice example left Acme example~~', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8) RETURNING id`, [LEGACY_FILE_SLUG]);
      struckId = Number(row.id);
    } });
  }, 120_000);

  test(`${backend}: an uncoordinated local file edit is neither blessed nor written over`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const path = join(root, `${LEGACY_FILE_SLUG}.md`);
      const file = readFileSync(path, 'utf8');
      const edited = `${file}\nAn uncoordinated local edit.\n`;
      writeFileSync(path, edited);
      const before = await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds]);

      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      // A managed brain's system of record is the database, so the publication is
      // planned from it: the edit neither blocks the backfill nor gets blessed by
      // it, and the file itself is never written.
      expect(phase).toMatchObject({ status: 'complete' });
      expect(readFileSync(path, 'utf8')).toBe(edited);
      expect(await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds])).toEqual(before);
      expect((await readPreservedFencePublication(engine, 'default', LEGACY_FILE_SLUG))!.bindings).toHaveLength(2);
      expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'complete', detail: 'pages_checked=2' });
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: the adoption intent refuses a taken position and a duplicate assignment, changing nothing`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const before = await factRows(engine, [...seed.legacyFactIds, seed.extractorFactId]);
      const content = replaceOrInsertFactsFence(serializePageToMarkdown(snapshot.page, snapshot.tags), renderFactsTable([
        { rowNum: 1, claim: 'Alice example founded Acme example', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'high', active: true }]));
      const attempt = (assignments: Array<{ id: number; row_num: number }>) => submitFactFenceAdoption(engine, authority, LEGACY_FILE_SLUG,
        { content, expectedRevision: snapshot.revision, assignments, file: true });
      await expect(attempt([{ id: seed.legacyFactIds[0], row_num: 1 }])).rejects.toMatchObject({ code: 'revision_conflict' });
      // #6278: a fence row that does not read back as its legacy fact is a planning defect (class server), not caller input.
      await expect(attempt([{ id: seed.legacyFactIds[1], row_num: 1 }])).rejects.toMatchObject({ code: 'fence_unrenderable' });
      await expect(attempt([{ id: seed.legacyFactIds[0], row_num: 1 }, { id: seed.legacyFactIds[1], row_num: 1 }]))
        .rejects.toMatchObject({ code: 'invalid_params' });
      expect(await factRows(engine, [...seed.legacyFactIds, seed.extractorFactId])).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: exhausted request IDs refuse the adoption up front with the capacity command`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const before = await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds]);
      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'failed' });
      expect(phase.detail).toStartWith('queue_capacity: Write capacity exhausted: principal permanent request IDs (0 used of 0).');
      expect(phase.detail).toContain('gbrain config set persistence.limits.principal_lifetime_ids ');
      expect(await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds])).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE operation='submit_job'")).toEqual([]);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '0');
    } });
  }, 120_000);

  test(`${backend}: an archived source's legacy facts are skipped and never block the active source`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine }) => {
      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'complete' });
      expect(phase.detail).toContain('fenced=3 pages=2');
      expect(phase.detail).toContain('skipped_archived=1');
      // The archived source's legacy fact is skipped outright: no document, no
      // stamp, nothing that could block the active source.
      const doc = (await readPreservedFencePublication(engine, 'default', LEGACY_FILE_SLUG))!;
      expect(doc.bindings.map(b => [b.original_row_num, b.derived_row_num])).toEqual([[null, 2], [null, 3]]);
      expect(await readPreservedFencePublication(engine, 'archived-example', 'people/erin-example')).toBeNull();
      expect((await factRows(engine, seed.legacyFactIds)).map(r => r.row_num)).toEqual([null, null]);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      await engine.executeRaw("INSERT INTO sources (id, name, archived) VALUES ('archived-example', 'Archived example', true)");
      await engine.putPage('people/erin-example', { type: 'person', title: 'Erin Example', compiled_truth: '# Erin Example' }, { sourceId: 'archived-example' });
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
        VALUES ('archived-example', 'people/erin-example', 'Erin example left Acme example', 'fact', 'world', 'medium', now(), 'mcp:put_page', 0.8)`);
    } });
  }, 120_000);

  test(`${backend}: a duplicate active fence row reads in sync whichever writer indexed the page last (#5814)`, async () => {
    await managedBrain(async ({ ctx, engine }) => {
      const slug = 'people/dana-example';
      const row = (rowNum: number, claim: string) => ({ rowNum, claim, kind: 'fact' as const, confidence: 1, visibility: 'private' as const,
        notability: 'medium' as const, validFrom: '2026-01-01', source: 'manual', active: true });
      const body = replaceOrInsertFactsFence('# Dana Example\n', renderFactsTable([row(1, 'Lives in Paris'), row(2, 'Lives in Paris'), row(3, 'Works at Acme example')]));
      const receipt = await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
        content: `---\ntype: person\ntitle: Dana Example\n---\n\n${body}` } }) as { state: string };
      expect(receipt.state).toBe('committed');
      const indexed = async () => (await engine.executeRaw<{ row_num: number }>(
        'SELECT row_num FROM facts WHERE source_markdown_slug = $1 AND row_num IS NOT NULL ORDER BY row_num', [slug])).map(r => Number(r.row_num));

      // The publication projects every fence row; extract_facts indexes the duplicate once.
      expect(await indexed()).toEqual([1, 2, 3]);
      expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'complete', detail: 'pages_checked=1' });
      await runExtractFacts(engine, { sourceId: 'default' });
      expect(await indexed()).toEqual([1, 3]);
      expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'complete', detail: 'pages_checked=1' });
    }, { databaseUrl });
  }, 120_000);
}
