import { beforeAll, afterAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildGazetteer, findMentionedEntities } from '../src/core/by-mention.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

async function seed(slug: string, title: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, {type: 'person', title, compiled_truth: 'Fixture entity', timeline: '', frontmatter});
}

test('quarantined wrong-root names cannot outrank canonical live names', async () => {
  await seed('hermes-moncho/people/hermes', 'Hermes', {quarantine: {reason: 'wrong-root-sync'}});
  await seed('people/hermes', 'Hermes');
  const gazetteer = await buildGazetteer(engine);
  expect(gazetteer.get('hermes')!.map(e => e.slug)).toEqual(['people/hermes']);
  expect(findMentionedEntities('Hermes runs this system.', gazetteer, {fromSlug: 'ops/probe', fromSourceId: 'default'})[0]!.slug).toBe('people/hermes');
});

test('aliases of quarantined entities are excluded as well as their titles', async () => {
  await seed('people/hidden', 'Hidden Person', {quarantine: {reason: 'junk_pattern'}});
  await engine.setPageAliases('people/hidden', 'default', ['ghostalias']);
  const gazetteer = await buildGazetteer(engine);
  expect(gazetteer.has('hidden')).toBe(false);
  expect(gazetteer.has('ghostalias')).toBe(false);
});

test('quarantine-key presence mirrors search visibility even for a null marker', async () => {
  await seed('people/hidden', 'Hidden Person', {quarantine: null});
  expect((await buildGazetteer(engine)).has('hidden')).toBe(false);
});

test('flagged-but-live entities remain eligible and clearing quarantine restores aliases', async () => {
  await seed('people/flagged', 'Flagged Person', {content_flag: {reason: 'oversize'}});
  await seed('people/hidden', 'Hidden Person', {quarantine: {reason: 'junk_pattern'}});
  await engine.setPageAliases('people/hidden', 'default', ['ghostalias']);
  expect((await buildGazetteer(engine)).has('flagged')).toBe(true);
  await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter-'quarantine' WHERE slug='people/hidden'");
  const gazetteer = await buildGazetteer(engine);
  expect(gazetteer.has('hidden')).toBe(true);
  expect(gazetteer.has('ghostalias')).toBe(true);
});