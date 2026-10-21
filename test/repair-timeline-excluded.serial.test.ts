/**
 * `gbrain repair timeline` for a legacy database-only page whose path is under
 * `sync.exclude` (the database-only materialization lane,
 * `managed_maintenance_timeline_materialize`).
 *
 * 1. Protects: an existing excluded page that records no canonical file gets
 *    its stored timeline row written back into the page through one
 *    owner-checked maintenance request, with its body, type, tags, facts row
 *    ids and emotional_weight unchanged and no file written, replaced or
 *    deleted anywhere in the excluded root.
 * 2. Fails when: the repair still routes such a page through put_page (B02
 *    refuses it), a request can be forged for a page that does not exist, a
 *    remote writer can reach the lane, an intent can carry replacement content,
 *    or a stale revision / concurrent write publishes anyway.
 * 3. No production seam: the cases drive the real repair handler and the real
 *    maintenance preparer against PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { timelineRepair } from '../src/core/repair/timeline.ts';
import { prepareMaintenanceMutation } from '../src/core/persistence/prepared-maintenance.ts';
import { prepareTimelineMaterialize, publishExcludedTimelineMaterialization, planTimelineMaterialization, TIMELINE_MATERIALIZE_INTENT } from '../src/core/repair/timeline-materialize.ts';
import { digest } from '../src/core/persistence/digest.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-repair-timeline-excluded-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

const ctxFor = (sourceId: string) => ({ engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
  dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as never;
const config = () => ({ engine: engine.kind, embedding_disabled: true }) as never;
const BODY = 'A legacy receipt body that sync never indexed because its root is excluded from the brain\'s scope.';

function tree(root: string): Array<{ path: string; bytes: string }> {
  const walk = (dir: string): Array<{ path: string; bytes: string }> => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) return walk(child);
      return [{ path: relative(root, child), bytes: readFileSync(child).toString('base64') }];
    });
  return statSync(root).isDirectory() ? walk(root) : [];
}

/**
 * A managed brain whose source owns `root`, holding one legacy page under
 * `private/` that records no canonical file and one stored timeline row with no
 * bullet in its body. `sync.exclude` covers `private/`.
 */
async function excludedBrain(): Promise<{ sourceId: string; root: string; slug: string; pageId: number; home: string }> {
  const dir = mkdtempSync(join(dataDir, 'case-'));
  const root = join(dir, 'brain');
  mkdirSync(join(root, 'private'), { recursive: true });
  const sourceId = `excluded-${randomUUID().slice(0, 8)}`;
  const slug = 'private/legacy-receipt';
  const home = join(dir, 'home');
  await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
    // Fixture rows are written directly, exactly like the pre-managed brain that produced this page.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await engine.putPage(slug, { type: 'note', title: 'Legacy receipt', compiled_truth: BODY, timeline: '', frontmatter: {} }, { sourceId });
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
      `INSERT INTO timeline_entries(page_id,date,source,summary,detail) SELECT id,'2026-03-04','legacy','Legacy receipt milestone','' FROM pages WHERE source_id=$1 AND slug=$2`,
      [sourceId, slug]), TEST_WRITE_ATTRIBUTION));
    await claimWorktree(engine, sourceId, root);
    await engine.setConfig('sync.exclude', 'private/');
    await engine.setConfig('sync.write_through', 'true');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  });
  const [{ id }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return { sourceId, root, slug, pageId: Number(id), home };
}

/** A synthetic admitted request for the preparer-level cases (no journal row needed). */
function row(slug: string, pageId: number | null, intent: Record<string, unknown>, sourceId: string, remote = false): WriteRequest {
  return { operation: 'submit_job', source_id: sourceId, source_incarnation: 'fixture', slug, page_id: pageId,
    request_id: randomUUID(), id: 1, intent, authority: { version: 1, remote, sourceId, sourceIncarnation: 'fixture',
      principal: { kind: 'local_cli', id: 'fixture' }, scopes: [], operations: null, slugPrefixes: null } } as never;
}

test('an existing excluded database-only page materializes its stored row with no file written or removed', async () => {
  const { sourceId, root, slug, pageId, home } = await excludedBrain();
  await withEnv({ GBRAIN_HOME: home }, async () => {
    // An unrelated file in the excluded root proves the lane neither rewrites nor removes file content.
    const decoy = join(root, 'private', 'unrelated.md');
    writeFileSync(decoy, '# unrelated\n');
    const before = await engine.readPageSnapshot(slug, { sourceId });
    expect(before!.page.source_path ?? null).toBeNull();
    const diskBefore = tree(root);

    const scope = await resolveRepairScope(engine);
    const preview = await runRepair(ctxFor(sourceId), timelineRepair, scope, { apply: false });
    expect(preview.affected).toBe(1);
    const applied = await runRepair(ctxFor(sourceId), timelineRepair, scope, { apply: true });
    expect(applied).toMatchObject({ applied: 1, complete: true });

    const after = await engine.readPageSnapshot(slug, { sourceId });
    expect(after!.page.compiled_truth).toBe(before!.page.compiled_truth);
    expect(after!.page.type).toBe('note');
    expect(after!.tags).toEqual(before!.tags);
    expect(after!.page.timeline).toContain('Legacy receipt milestone');
    expect(after!.revision).not.toBe(before!.revision);

    // The stored row is kept, and no second row was invented.
    const rows = await engine.executeRaw<{ id: number; summary: string }>('SELECT id,summary FROM timeline_entries WHERE page_id=$1 ORDER BY id', [pageId]);
    expect(rows.map(r => r.summary)).toEqual(['Legacy receipt milestone']);
    const [{ emotional_weight: weight }] = await engine.executeRaw<{ emotional_weight: number }>('SELECT emotional_weight FROM pages WHERE id=$1', [pageId]);
    expect(Number(weight)).toBe(0);

    // One committed request of the new kind, and no put_page request at all.
    const kinds = await engine.executeRaw<{ kind: string; state: string }>(`SELECT intent->>'kind' AS kind,state FROM persistence_requests WHERE source_id=$1 ORDER BY id`, [sourceId]);
    expect(kinds).toEqual([{ kind: TIMELINE_MATERIALIZE_INTENT, state: 'committed' }]);

    // The excluded root's files are byte-identical: no page file appeared, nothing was deleted.
    expect(tree(root)).toEqual(diskBefore);
  });
}, 180_000);

test('the lane refuses a page that does not exist, a remote writer, a replacement payload and a stale revision', async () => {
  const { sourceId, slug, pageId, home } = await excludedBrain();
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    const plan = await planTimelineMaterialization(engine, slug, sourceId, snapshot!);
    const base = { kind: TIMELINE_MATERIALIZE_INTENT, expected_revision: snapshot!.revision, preimage_digest: plan.preimage_digest };

    // A page that does not exist yet is refused by the lane (existing rows only).
    const missing = await prepareTimelineMaterialize(engine, row('private/new-page', null,
      { kind: TIMELINE_MATERIALIZE_INTENT, expected_revision: null, preimage_digest: digest('') }, sourceId), config())
      .then(() => null, (error: any) => error);
    expect(missing?.code).toBe('page_not_found');

    // A remote write cannot reach the lane, even with the dispatch entry.
    const remote = await prepareMaintenanceMutation(engine, row(slug, pageId, base, sourceId, true), config())
      .then(() => null, (error: any) => error);
    expect(`${remote?.code} ${remote?.message}`).toMatch(/local writer|remote/i);
    const unspecified = row(slug, pageId, base, sourceId);
    delete (unspecified.authority as { remote?: boolean }).remote;
    const untrusted = await prepareTimelineMaterialize(engine, unspecified, config()).then(() => null, (e: any) => e);
    expect(`${untrusted?.code} ${untrusted?.message}`).toMatch(/local writer|remote/i);

    // No intent field can carry replacement content, tags or type.
    for (const forged of [{ content: `---\ntype: note\ntitle: X\n---\nreplaced body\n` }, { tags: ['x'] }, { type: 'person' }]) {
      const error = await prepareTimelineMaterialize(engine, row(slug, pageId, { ...base, ...forged }, sourceId), config()).then(() => null, (e: any) => e);
      expect(error?.code).toBe('invalid_params');
    }

    // A preimage digest that is not the page's own body is refused (content is derived, never supplied).
    const edited = await prepareTimelineMaterialize(engine, row(slug, pageId,
      { ...base, preimage_digest: digest(`${plan.content}\nreplacement`) }, sourceId), config()).then(() => null, (e: any) => e);
    expect(edited?.code).toBe('revision_conflict');

    // A concurrent write after planning makes the request stale.
    await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
      `UPDATE pages SET compiled_truth=compiled_truth || '\nconcurrent edit' WHERE id=$1`, [pageId]), TEST_WRITE_ATTRIBUTION));
    const stale = await prepareTimelineMaterialize(engine, row(slug, pageId, base, sourceId), config()).then(() => null, (e: any) => e);
    expect(stale?.code).toBe('revision_conflict');
    // Nothing above published anything.
    const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1`, [sourceId]);
    expect(n).toBe(0);
    const after = await engine.readPageSnapshot(slug, { sourceId });
    expect(after!.page.timeline).toBe('');
  });
}, 180_000);
