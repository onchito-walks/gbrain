/**
 * Stage 3B B04 (task t_e8aff02d) — default covered-atom retrieval policy.
 *
 * An `atom` page whose content is already reachable through a LIVE non-atom
 * page of the SAME source is hidden by default; `include_covered_atoms: true`
 * opts back out. Uncovered atoms stay reachable, and the coverage signal is
 * same-source and direction-correct:
 *
 *   - `covered-by-source-slug` — frozen frontmatter `source_slug` resolves to a
 *     live non-atom page of the same source → HIDDEN
 *   - `link-covered` — the atom's OWN outgoing link reaches a live non-atom
 *     page of the same source → HIDDEN
 *   - `unique-atom` — `source_slug` resolves to nothing → KEPT
 *   - `cross-source-atom` — its covering page exists, but only in ANOTHER
 *     source → KEPT (coverage is correlated per source)
 *   - `inverse-link-only` — a live non-atom page links TOWARD this atom while
 *     the atom has no outgoing link and no `source_slug` → KEPT (an inverse
 *     join on `to_page_id` would wrongly hide it)
 *
 * The assertions drive REAL code: dispatchToolCall → the public `search` op →
 * hybridSearchCached/searchKeyword → PGLite SQL over a disposable in-memory
 * engine, plus direct engine.searchKeyword calls for the SQL seam and the real
 * knobsHash for the cache-key identity.
 *
 * Fixture note: pages are written as raw markdown (never by UPDATE) because an
 * UPDATE on `pages` bumps `generation` and the FTS legs then no longer join the
 * page's chunks — the frozen-binding fields must land with the import.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { knobsHash, MODE_BUNDLES, type ResolvedSearchKnobs } from '../src/core/search/mode.ts';

let engine: PGLiteEngine;

const TOKEN = 'quokkastation';
const ATOMS = [
  'atoms/covered-by-source-slug',
  'atoms/link-covered',
  'atoms/unique-atom',
  'atoms/cross-source-atom',
  'atoms/inverse-link-only',
];

/** Raw markdown so the frozen `source_slug` binding lands in frontmatter. */
function doc(type: string, title: string, body: string, extra: Record<string, string> = {}): string {
  const head = ['---', `type: ${type}`, `title: ${title}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), '---', ''];
  return `${head.join('\n')}\n${body}\n`;
}

async function put(slug: string, sourceId: string, content: string): Promise<void> {
  await importFromContent(engine, slug, content, { noEmbed: true, forceRechunk: true, sourceId });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");

  // source `default`
  await put('notes/a-page', 'default', doc('note', 'A page', `${TOKEN} primary note of the default source`));
  await put('notes/inbound', 'default', doc('note', 'Inbound page', `${TOKEN} page that links toward an atom`));
  await put('atoms/covered-by-source-slug', 'default', doc('atom', 'Covered by source_slug', `${TOKEN} passage already reachable through notes/a-page`, { source_slug: 'notes/a-page' }));
  await put('atoms/link-covered', 'default', doc('atom', 'Covered by outgoing link', `${TOKEN} passage whose atom links out to notes/a-page`));
  await put('atoms/unique-atom', 'default', doc('atom', 'Unique atom', `${TOKEN} passage with no live covering page anywhere`, { source_slug: 'notes/does-not-exist' }));
  await put('atoms/cross-source-atom', 'default', doc('atom', 'Cross-source atom', `${TOKEN} passage whose only covering page is in another source`, { source_slug: 'notes/other-only' }));
  await put('atoms/inverse-link-only', 'default', doc('atom', 'Inverse link only', `${TOKEN} passage reachable only by an inbound link`));

  // source `other`: the same shape of covering page, in a DIFFERENT source.
  await put('notes/other-only', 'other', doc('note', 'Other-only page', `${TOKEN} note that exists only in the other source`));

  // Real link rows: atom -> notes/a-page (the covering direction) and
  // notes/inbound -> atom (inverse; must NOT count as coverage).
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, link_kind, resolution_type)
     SELECT a.id, t.id, 'plain', 'test-fixture', 'plain', 'qualified'
     FROM pages a, pages t WHERE a.slug = 'atoms/link-covered' AND a.source_id = 'default'
       AND t.slug = 'notes/a-page' AND t.source_id = 'default'`);
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source, link_kind, resolution_type)
     SELECT f.id, t.id, 'plain', 'test-fixture', 'plain', 'qualified'
     FROM pages f, pages t WHERE f.slug = 'notes/inbound' AND f.source_id = 'default'
       AND t.slug = 'atoms/inverse-link-only' AND t.source_id = 'default'`);
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

async function searchSlugs(params: Record<string, unknown>): Promise<string[]> {
  const r = await dispatchToolCall(engine, 'search', { query: TOKEN, limit: 50, ...params }, { remote: false, transport: 'http', sourceId: 'default' });
  const text = r.content[0]?.text ?? '';
  expect(text, `expected a result array, got: ${text.slice(0, 400)}`).toStartWith('[');
  return (JSON.parse(text) as Array<{ slug: string }>).map(x => x.slug);
}

describe('B04 covered-atom policy through the public search op', () => {
  test('default hides only the same-source covered atoms', async () => {
    const slugs = await searchSlugs({});
    expect(slugs).toContain('notes/a-page');            // the covering page itself is unaffected
    expect(slugs).not.toContain('atoms/covered-by-source-slug');
    expect(slugs).not.toContain('atoms/link-covered');
    expect(slugs).toContain('atoms/unique-atom');       // uncovered
    expect(slugs).toContain('atoms/cross-source-atom'); // covering page lives in another source
    expect(slugs).toContain('atoms/inverse-link-only'); // inverse edge is not coverage
  });

  test('include_covered_atoms: true returns every atom page', async () => {
    const slugs = await searchSlugs({ include_covered_atoms: true });
    for (const slug of ATOMS) expect(slugs).toContain(slug);
    expect(slugs).toContain('notes/a-page');
  });

  test('a soft-deleted covering page stops covering its atom', async () => {
    await engine.softDeletePage('notes/a-page');
    try {
      const slugs = await searchSlugs({});
      expect(slugs).toContain('atoms/covered-by-source-slug'); // its cover is gone
      expect(slugs).toContain('atoms/link-covered');           // its link target is gone too
      expect(slugs).toContain('notes/inbound');                // the live non-atom page stays
      expect(slugs).not.toContain('notes/a-page');             // the soft-deleted cover is hidden
    } finally {
      await engine.restorePage('notes/a-page');
    }
  });
});

describe('B04 covered-atom policy at the engine SQL seam', () => {
  test('searchKeyword applies the same carve-out and the opt-out', async () => {
    const covered = (await engine.searchKeyword(TOKEN, { limit: 50 })).map(r => r.slug);
    expect(covered).not.toContain('atoms/covered-by-source-slug');
    expect(covered).toContain('atoms/unique-atom');

    const all = (await engine.searchKeyword(TOKEN, { limit: 50, includeCoveredAtoms: true })).map(r => r.slug);
    expect(all).toContain('atoms/covered-by-source-slug');
    expect(all).toContain('atoms/link-covered');
  });

  test('the clause never rewrites atom bodies or frozen provenance', async () => {
    const page = await engine.getPage('atoms/covered-by-source-slug');
    expect(page?.compiled_truth).toContain(TOKEN);
    expect(page?.frontmatter?.source_slug).toBe('notes/a-page');
  });
});

describe('B04 cache-key identity', () => {
  function baseKnobs(): ResolvedSearchKnobs {
    return { ...MODE_BUNDLES.balanced, resolved_mode: 'balanced', mode_valid: true };
  }
  test('includeCoveredAtoms separates cache rows; absent hashes like false', () => {
    const knobs = baseKnobs();
    const on = knobsHash(knobs, { includeCoveredAtoms: true });
    const off = knobsHash(knobs, { includeCoveredAtoms: false });
    const absent = knobsHash(knobs, {});
    expect(on).not.toBe(off);
    expect(off).toBe(absent);
  });
});
