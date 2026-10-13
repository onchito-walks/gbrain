import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { backfillDerivedLinksBatch } from '../src/core/legacy-link-backfill.ts';
import { runExtract } from '../src/commands/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`legacy additive migration backfill (${kind})`, () => {
    let engine: BrainEngine, close: () => Promise<void>;
    const sourceId = 'legacy-backfill-fixture';
    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; close = pg.close;
      } else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      for (const slug of ['concepts/origin', 'concepts/target', 'concepts/historical-a', 'concepts/historical-b']) {
        await engine.putPage(slug, { title: slug, type: 'concept', compiled_truth: '',
          frontmatter: slug === 'concepts/origin' ? { related: ['concepts/target'] } : {} }, { sourceId });
      }
    });
    afterAll(async () => { await close?.(); });
    async function origin() {
      const snapshot = (await engine.readPageSnapshot('concepts/origin', { sourceId }))!;
      return { slug: snapshot.page.slug, sourceId, expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation };
    }
    const row = (): LinkBatchInput => ({ from_slug: 'concepts/origin', to_slug: 'concepts/target',
      from_source_id: sourceId, to_source_id: sourceId, origin_source_id: sourceId, origin_slug: 'concepts/origin',
      link_source: 'frontmatter', link_type: 'related_to', origin_field: 'related', context: 'current grounded evidence' });
    const rows = () => engine.executeRaw('SELECT l.* FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 ORDER BY l.id', [sourceId]);
    async function legacy(from = 'concepts/origin', to = 'concepts/target') {
      await engine.addLink(from, to, '', 'related_to', 'frontmatter', undefined, undefined,
        { fromSourceId: sourceId, toSourceId: sourceId });
    }
    async function write(links = [row()]) { return backfillDerivedLinksBatch(engine, [{ origin: await origin(), links }]); }

    test('grounded projections are additive; original IDs, unknown origins, contexts and page state survive exactly', async () => {
      await legacy();
      const before = await rows();
      const pages = await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId]);
      expect(await write()).toEqual([{ created: 1, removed: 0 }]);
      const after = await rows();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(2);
      expect(after[1].origin_field).toBe('related');
      expect(after[1].origin_page_id).not.toBeNull();
      expect(await engine.executeRaw('SELECT * FROM pages WHERE source_id=$1 ORDER BY id', [sourceId])).toEqual(pages);
      // Backfill is not a provenance repair or a reconciliation certificate.
      await expect(engine.replaceDerivedLinks(await origin(), [row()])).rejects.toMatchObject({ code: 'derived_link_provenance_required' });
    });
    test('attributed collision siblings are retained verbatim, not merged or relabelled', async () => {
      await legacy(); await engine.addLinksBatch([{ ...row(), context: 'original sibling context' }]);
      const before = await rows();
      expect(await write()).toEqual([{ created: 0, removed: 0 }]);
      expect(await rows()).toEqual(before);
    });
    test('deleted historical endpoint pairs remain untouched and unknown', async () => {
      await legacy('concepts/historical-a', 'concepts/historical-b');
      await engine.addLinksBatch([{ ...row(), from_slug: 'concepts/historical-a', to_slug: 'concepts/historical-b', origin_slug: 'concepts/historical-a' }]);
      await engine.executeRaw("UPDATE pages SET deleted_at=NOW() WHERE source_id=$1 AND slug LIKE 'concepts/historical-%'", [sourceId]);
      const before = await rows();
      await write();
      expect((await rows()).slice(0, before.length)).toEqual(before);
    });
    test('ambiguous provenance remains unknown even with no current derived evidence', async () => {
      await legacy(); const before = await rows();
      expect(await write([])).toEqual([{ created: 0, removed: 0 }]);
      expect(await rows()).toEqual(before);
    });
    test('repeat invocation is byte-preserving and adds no duplicate attributed edge', async () => {
      await legacy(); await write(); const before = await rows();
      expect(await write()).toEqual([{ created: 0, removed: 0 }]); expect(await rows()).toEqual(before);
    });
    test('stale origin and endpoint fences roll back without touching evidence', async () => {
      await legacy(); const captured = await origin(); const before = await rows();
      await engine.putPage(captured.slug, { title: 'changed', type: 'concept', compiled_truth: '' }, { sourceId });
      await expect(backfillDerivedLinksBatch(engine, [{ origin: captured, links: [row()] }])).rejects.toMatchObject({ code: 'revision_conflict' });
      const target = (await engine.readPageSnapshot('concepts/target', { sourceId }))!;
      await engine.putPage('concepts/target', { title: 'changed target', type: 'concept', compiled_truth: '' }, { sourceId });
      await expect(backfillDerivedLinksBatch(engine, [{ origin: await origin(), links: [row()],
        opts: { expectedEndpoints: [{ slug: 'concepts/target', sourceId, revision: target.revision }] } }])).rejects.toThrow('endpoint');
      expect(await rows()).toEqual(before);
    });
    test('untrusted and wrong-mode calls cannot select the migration publication path', async () => {
      await expect(runExtract(engine, ['links', '--source', 'db', '--migration-backfill'])).rejects.toThrow('trusted-local');
      await expect(runExtract(engine, ['links', '--source', 'db', '--migration-backfill'], { remote: true })).rejects.toThrow('trusted-local');
      await expect(runExtract(engine, ['all', '--source', 'db', '--migration-backfill'], { remote: false })).rejects.toThrow('trusted-local');
    });
  });
}
