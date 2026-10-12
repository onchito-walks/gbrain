/**
 * Stage 3B B05 (task t_e8aff02d) — verified legacy source-root alias
 * resolution for frozen atom bindings.
 *
 * The historical whole-vault `hermes-moncho/` → root rename left extracted
 * atoms carrying a FROZEN `frontmatter.source_slug` of `hermes-moncho/<path>`
 * while the live source page sits at `<path>`. An exact-only coverage predicate
 * judged those atoms source-gone and kept them visible. The fix adds ONE
 * prefix-only de-prefixed alias arm per verified legacy rename, inside the SAME
 * same-source / non-atom EXISTS — never a basename or fuzzy match, and never a
 * rewrite of the frozen field.
 *
 * Assertions drive real code:
 *   - `engine.searchKeyword` (the engine SQL seam every retrieval leg feeds),
 *     asserted as an EXACT result set for the whole fixture;
 *   - `dispatchToolCall` → public `search` op → hybridSearchCached →
 *     PGLite SQL, for the caller-visible behaviour;
 *   - the pure resolver the read-time provenance classifier shares.
 *
 * Cases:
 *   - alias-covered         : frozen `hermes-moncho/notes/a-page`, live
 *                             `notes/a-page` of the same source → HIDDEN
 *   - exact-covered         : frozen `notes/a-page` → HIDDEN (unchanged)
 *   - alias-cross-source    : same frozen slug, cover only in ANOTHER source
 *                             → KEPT
 *   - alias-wrong-subtree   : `hermes-moncho/other/b-page` when only
 *                             `notes/a-page` exists → KEPT (no basename match)
 *   - alias-not-leading     : `drafts/hermes-moncho/readme` → KEPT (prefix-only)
 *   - alias-covered-by-atom : the alias resolves to a LIVE ATOM → KEPT
 *
 * The public-op cases assert only the policy-critical rows: this fixture is
 * deliberately atom-heavy, and upstream `dedupResults` layer 3 ("no page type
 * exceeds 60% of results") trims the tail of an atom-dominated set on the op
 * path. That trim is pre-existing upstream behaviour, unchanged here; the exact
 * set assertions live at the SQL seam where the predicate itself is observable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { aliasSourceSlug, sourceSlugCandidates } from '../src/core/atom-slug-alias.ts';

let engine: PGLiteEngine;

const TOKEN = 'vireoalias';
const FROZEN = 'hermes-moncho/notes/a-page';

const DEFAULT_UNCOVERED = [
  'atoms/alias-covered-by-atom',
  'atoms/alias-not-leading',
  'atoms/alias-wrong-subtree',
  'atoms/sibling-atom',
  'notes/a-page',
];
const DEFAULT_ALL = [...DEFAULT_UNCOVERED, 'atoms/alias-covered', 'atoms/exact-covered'];
const ALL_SOURCES_DEFAULT = [...DEFAULT_UNCOVERED, 'atoms/alias-cross-source'];
const ALL_SOURCES_OPTOUT = [...DEFAULT_ALL, 'atoms/alias-cross-source'];

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
  await put('notes/a-page', 'default', doc('note', 'A page', `${TOKEN} the de-prefixed live source page`));
  await put('atoms/sibling-atom', 'default', doc('atom', 'Sibling atom', `${TOKEN} a live atom page, never a cover`));
  await put('atoms/alias-covered', 'default', doc('atom', 'Alias covered', `${TOKEN} passage whose frozen source_slug carries the legacy prefix`, { source_slug: FROZEN }));
  await put('atoms/exact-covered', 'default', doc('atom', 'Exact covered', `${TOKEN} exact source_slug binding, no legacy prefix`, { source_slug: 'notes/a-page' }));
  await put('atoms/alias-wrong-subtree', 'default', doc('atom', 'Alias wrong subtree', `${TOKEN} frozen slug resolves nowhere after de-prefixing`, { source_slug: 'hermes-moncho/other/b-page' }));
  await put('atoms/alias-not-leading', 'default', doc('atom', 'Alias not leading', `${TOKEN} the legacy prefix is not at the start of the slug`, { source_slug: 'drafts/hermes-moncho/readme' }));
  await put('atoms/alias-covered-by-atom', 'default', doc('atom', 'Alias covered by an atom', `${TOKEN} the alias resolves to a live ATOM page`, { source_slug: 'hermes-moncho/atoms/sibling-atom' }));

  // source `other`: the frozen slug's cover exists only in `default`.
  await put('atoms/alias-cross-source', 'other', doc('atom', 'Alias cross source', `${TOKEN} covering page lives in another source`, { source_slug: FROZEN }));
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

async function seamSlugs(opts: Record<string, unknown> = {}): Promise<string[]> {
  const rows = await engine.searchKeyword(TOKEN, { limit: 50, ...opts } as never);
  return (rows as Array<{ slug: string }>).map(r => r.slug).sort();
}

async function searchSlugs(params: Record<string, unknown>, sourceId = 'default'): Promise<string[]> {
  const r = await dispatchToolCall(engine, 'search', { query: TOKEN, limit: 50, ...params }, { remote: false, transport: 'http', sourceId });
  const text = r.content[0]?.text ?? '';
  expect(text, `expected a result array, got: ${text.slice(0, 400)}`).toStartWith('[');
  return (JSON.parse(text) as Array<{ slug: string }>).map(x => x.slug);
}

describe('B05 covered-atom predicate at the engine SQL seam', () => {
  test('the alias arm covers, and nothing else is hidden', async () => {
    expect(await seamSlugs()).toEqual([...ALL_SOURCES_DEFAULT].sort());
  });

  test('includeCoveredAtoms returns every atom, alias arms included', async () => {
    expect(await seamSlugs({ includeCoveredAtoms: true })).toEqual([...ALL_SOURCES_OPTOUT].sort());
  });

  test('the alias predicate never rewrites the frozen binding', async () => {
    const page = await engine.getPage('atoms/alias-covered');
    expect(page?.frontmatter?.source_slug).toBe(FROZEN);
  });
});

describe('B05 through the public search op', () => {
  test('the default hides the legacy-bound and the exact-bound atom', async () => {
    const slugs = await searchSlugs({});
    expect(slugs).toContain('notes/a-page');
    expect(slugs).not.toContain('atoms/alias-covered');
    expect(slugs).not.toContain('atoms/exact-covered');
    expect(slugs).toContain('atoms/alias-wrong-subtree');   // no basename matching
    expect(slugs).toContain('atoms/alias-not-leading');     // prefix-only, not a substring rule
  });

  test('include_covered_atoms: true returns the alias-covered atom', async () => {
    expect(await searchSlugs({ include_covered_atoms: true })).toContain('atoms/alias-covered');
  });

  test('the alias never crosses a source boundary', async () => {
    const other = await searchSlugs({}, 'other');
    expect(other).toContain('atoms/alias-cross-source');    // its cover lives in `default`
    expect(other).not.toContain('notes/a-page');
  });
});

describe('B05 the shared prefix-only resolver', () => {
  test('aliasSourceSlug strips exactly one leading verified prefix', () => {
    expect(aliasSourceSlug(FROZEN)).toBe('notes/a-page');
    expect(aliasSourceSlug('notes/a-page')).toBeNull();          // exact-first: nothing to strip
    expect(aliasSourceSlug('hermes-moncho/')).toBeNull();        // prefix alone is not a slug
    expect(aliasSourceSlug('drafts/hermes-moncho/readme')).toBeNull();
    expect(aliasSourceSlug('hermes-moncho-archive/x')).toBeNull();
  });

  test('sourceSlugCandidates is exact-first, then the alias arm', () => {
    expect(sourceSlugCandidates(FROZEN)).toEqual([FROZEN, 'notes/a-page']);
    expect(sourceSlugCandidates('notes/a-page')).toEqual(['notes/a-page']);
  });
});
