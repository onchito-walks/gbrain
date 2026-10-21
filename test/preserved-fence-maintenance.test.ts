import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { maintainAndCompleteSourceCycle, refreshPreservedFencePublications } from '../src/core/cycle/preserved-fence-maintenance.ts';
import { PRESERVED_FENCE_SOURCE, preservedFencePublicationState, publishPreservedFencePublication, readPreservedFencePublication } from '../src/core/facts/preserved-fence-store.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { stableJson, sha256 } from '../src/core/persistence/digest.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SLUG = 'people/maintenance-example';
async function seed(engine: BrainEngine) {
  await engine.putPage(SLUG, { type: 'person', title: 'Maintenance Example', compiled_truth: '# Original page\n' });
  await engine.putPage('atoms/saved-example', { type: 'atom', title: 'Saved atom', compiled_truth: 'Never re-extract or change this atom.' });
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num)
    VALUES ('default',$1,'Saved literal original claim  ','fact','world','medium','2026-01-01','mcp:remember',1,NULL)`, [SLUG]);
}
async function unchanged(engine: BrainEngine) {
  const pages = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM pages ORDER BY id');
  return {
    // A direct fixture page edit invalidates the derived text-index seal. The
    // coordinator may finish that seal; it is not an original fact or page
    // content. Keep EVERY atom column in the comparison without exceptions.
    pages: pages.map(page => {
      if (page.type === 'atom') return page;
      const { text_projection_revision, ...original } = page;
      return original;
    }),
    facts: await engine.executeRaw('SELECT * FROM facts ORDER BY id'),
  };
}
for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const mutation of ['source', 'page', 'fact'] as const) {
    test(`${backend}: derived upkeep after ${mutation} edit preserves atoms/originals, archives old projection, completes twice`, async () => {
      await managedBrain(async ({ engine, root }) => {
        await publishPreservedFencePublication(engine, 'default', SLUG);
        const old = await readPreservedFencePublication(engine, 'default', SLUG);
        if (mutation === 'source') await engine.updateSourceConfig('default', { legitimate_setting: 2 });
        else await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(mutation === 'page'
          ? "UPDATE pages SET compiled_truth = '# Legitimate updated page' WHERE source_id='default' AND slug=$1"
          : "UPDATE facts SET source_session='legitimate-session' WHERE source_id='default' AND entity_slug=$1", [SLUG]),
          { requestId: null, principal: { kind: 'application', id: 'synthetic-test-editor' } }));
        // Finish the edited page's normal text projection before taking the
        // preservation baseline (the fixture mutation bypasses put_page).
        await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
        expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('drifted');
        const before = await unchanged(engine);
        const first = await refreshPreservedFencePublications(engine, 'default');
        expect(first).toEqual({ inspected: 1, refreshed: 1 });
        expect(await unchanged(engine)).toEqual(before);
        expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
        const history = await engine.executeRaw<{ data: unknown }>('SELECT data FROM raw_data WHERE source=$1',
          [`${PRESERVED_FENCE_SOURCE}:version:${sha256(stableJson(old))}`]);
        expect(history).toEqual([{ data: old }]);
        const raw = await engine.executeRaw('SELECT * FROM raw_data ORDER BY id');
        expect(await refreshPreservedFencePublications(engine, 'default')).toEqual({ inspected: 1, refreshed: 0 });
        expect(await engine.executeRaw('SELECT * FROM raw_data ORDER BY id')).toEqual(raw);
        const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['orphans'] });
        expect(report.stamp_write_failed).toBeUndefined();
        expect(['ok', 'clean']).toContain(report.status);
        const [source] = await engine.executeRaw<{ config: Record<string, unknown> }>("SELECT config FROM sources WHERE id='default'");
        expect(source!.config.last_source_cycle_at).toBeDefined();
        await maintainAndCompleteSourceCycle(engine, 'default', '2026-10-21T06:00:00.000Z');
        expect((await preservedFencePublicationState(engine, 'default', SLUG)).state).toBe('current');
        expect(await unchanged(engine)).toEqual(before);
      }, { databaseUrl, setup: ({ engine }) => seed(engine) });
    }, 120_000);
  }
}
