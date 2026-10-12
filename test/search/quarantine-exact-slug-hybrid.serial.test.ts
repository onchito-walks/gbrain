import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { hybridSearchCached, applyAliasHop } from '../../src/core/search/hybrid.ts';
import { structuralExactLookup } from '../../src/core/search/exact-lookup.ts';
import { buildQuarantineMarker } from '../../src/core/quarantine.ts';
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 30000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });
async function seed() {
  await engine.putPage('notes/hidden-example', { type: 'note', title: 'Hidden Example', compiled_truth: 'fixture hidden body', frontmatter: { quarantine: buildQuarantineMarker('junk_pattern', 'fixture') } });
  await engine.putPage('notes/visible-example', { type: 'note', title: 'Visible Example', compiled_truth: 'fixture visible body' });
}
test('real hybrid hides quarantined identity while direct recovery remains readable', async () => {
  await seed();
  const page = await engine.getPage('notes/hidden-example', { sourceId: 'default' });
  expect(page?.compiled_truth).toBe('fixture hidden body');
  expect(await structuralExactLookup(engine, 'notes/hidden-example', { sourceId: 'default' })).toEqual([]);
  const hidden = await hybridSearchCached(engine, 'notes/hidden-example', { sourceId: 'default', limit: 10 });
  expect(hidden.map(r => r.slug)).not.toContain('notes/hidden-example');
  const recovery = await hybridSearchCached(engine, 'notes/hidden-example', { sourceId: 'default', limit: 10, includeQuarantined: true });
  expect(recovery.map(r => r.slug)).toContain('notes/hidden-example');
  const visible = await hybridSearchCached(engine, 'notes/visible-example', { sourceId: 'default', limit: 10 });
  expect(visible.map(r => r.slug)).toContain('notes/visible-example');
});
test('quarantine alias cannot inject a hidden canonical', async () => {
  await seed();
  await engine.setPageAliases('notes/hidden-example', 'default', ['hidden fixture alias']);
  expect(await applyAliasHop(engine, [], 'hidden fixture alias', { sourceId: 'default' })).toEqual([]);
});
test('content warning is not quarantine', async () => {
  await engine.putPage('notes/flagged-example', { type: 'note', title: 'Flagged', compiled_truth: 'retained warning', frontmatter: { content_flag: { reason: 'markup_heavy', detail: 'fixture' } } });
  expect((await structuralExactLookup(engine, 'notes/flagged-example', { sourceId: 'default' })).map(r => r.slug)).toEqual(['notes/flagged-example']);
});
