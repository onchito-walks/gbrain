/**
 * Default covered-atom retrieval policy (v0.48.4.0-custom).
 *
 * By default, retrieval hides atom pages whose frontmatter `source_slug`
 * resolves to a live (non-deleted), non-atom page, OR that have a live
 * non-atom link fallback. Uncovered atom pages (no usable source_slug, a
 * missing source, or a soft-deleted source) are ALWAYS kept so no potentially
 * unique data becomes unreachable. `include_covered_atoms: true` opts OUT of
 * the default carve-out and returns every atom.
 *
 * The carve-out is corpus-faithful: the engine re-evaluates the live `pages`
 * + `links` tables at query time, so coverage tracks source-page deletions and
 * recoveries automatically (no snapshot, no reindex, no embeddings change).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const searchOp = operations.find((o) => o.name === 'search')!;
const queryOp = operations.find((o) => o.name === 'query')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: console as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

/** Build a page findable for 'quasar telescope', namespaced by slug. */
async function seedPage(
  slug: string,
  label: string,
  opts: { type?: string; frontmatter?: Record<string, unknown> } = {},
): Promise<void> {
  await engine.putPage(slug, {
    type: opts.type ?? 'note',
    title: `Quasar ${label}`,
    compiled_truth: `the quasar telescope glows in the ${label} page`,
    frontmatter: opts.frontmatter ?? {},
  });
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: `the quasar telescope glows in the ${label} page`, chunk_source: 'compiled_truth' },
  ]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Live non-atom source pages.
  await seedPage('notes/quasar-source', 'source');
  await seedPage('notes/quasar-note', 'note');
  // Soft-deleted source page (its atom below is a `src_deleted` exception).
  await seedPage('notes/quasar-deleted', 'deleted-source');
  await engine.softDeletePage('notes/quasar-deleted');

  // COVERED via frontmatter source_slug -> live non-atom source (excluded by default).
  await seedPage('atoms/covered-001', 'covered-atom', { type: 'atom', frontmatter: { source_slug: 'notes/quasar-source' } });
  // COVERED via live non-atom link fallback (no source_slug; excluded by default).
  await seedPage('atoms/covered-link-001', 'covered-link-atom', { type: 'atom', frontmatter: {} });
  await engine.addLink('atoms/covered-link-001', 'notes/quasar-source', 'source link');
  // UNCOVERED: no source_slug, no link (kept by default).
  await seedPage('atoms/uncovered-001', 'uncovered-atom', { type: 'atom', frontmatter: {} });
  // UNCOVERED: source_slug points at a soft-deleted page (src_deleted; kept by default).
  await seedPage('atoms/deleted-source-001', 'deleted-source-atom', { type: 'atom', frontmatter: { source_slug: 'notes/quasar-deleted' } });

  // Keyword-only for the search op so the battery needs no embedding provider.
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

function slugsOf(results: unknown): string[] {
  return (results as SearchResult[]).map((r) => r.slug).sort();
}

describe('default covered-atom retrieval policy — search op', () => {
  test('covered atoms (source_slug + link fallback) are absent by default', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'quasar telescope' });
    expect(slugsOf(out)).toEqual([
      'atoms/deleted-source-001',
      'atoms/uncovered-001',
      'notes/quasar-note',
      'notes/quasar-source',
    ]);
  });

  test('uncovered atom exceptions remain in default results', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'quasar telescope' });
    const slugs = slugsOf(out);
    expect(slugs).toContain('atoms/uncovered-001'); // no source_slug, no link
    expect(slugs).toContain('atoms/deleted-source-001'); // source page soft-deleted
  });

  test('explicit include_covered_atoms:true returns covered atoms too', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'quasar telescope', include_covered_atoms: true });
    expect(slugsOf(out)).toEqual([
      'atoms/covered-001',
      'atoms/covered-link-001',
      'atoms/deleted-source-001',
      'atoms/uncovered-001',
      'notes/quasar-note',
      'notes/quasar-source',
    ]);
  });

  test('non-atom results are unchanged between default and opt-in', async () => {
    const def = slugsOf(await searchOp.handler(ctxOf(), { query: 'quasar telescope' }));
    const incl = slugsOf(await searchOp.handler(ctxOf(), { query: 'quasar telescope', include_covered_atoms: true }));
    const nonAtom = ['notes/quasar-note', 'notes/quasar-source'];
    for (const slug of nonAtom) {
      expect(def).toContain(slug);
      expect(incl).toContain(slug);
    }
  });

  test('exclude_slug_prefixes still stacks with the default covered-atom carve-out', async () => {
    // Even opted-in, a caller can still hard-prefix-exclude the whole atoms/ namespace.
    const out = await searchOp.handler(ctxOf(), {
      query: 'quasar telescope',
      include_covered_atoms: true,
      exclude_slug_prefixes: ['atoms/'],
    });
    expect(slugsOf(out)).toEqual(['notes/quasar-note', 'notes/quasar-source']);
  });
});

describe('default covered-atom retrieval policy — query op (hybrid keyword leg)', () => {
  test('covered atoms absent by default; uncovered + non-atom kept', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), { query: 'quasar telescope', expand: false });
      expect(slugsOf(out)).toEqual([
        'atoms/deleted-source-001',
        'atoms/uncovered-001',
        'notes/quasar-note',
        'notes/quasar-source',
      ]);
    });
  });

  test('include_covered_atoms:true restores covered atoms on the hybrid leg', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), {
        query: 'quasar telescope',
        expand: false,
        include_covered_atoms: true,
      });
      expect(slugsOf(out)).toContain('atoms/covered-001');
      expect(slugsOf(out)).toContain('atoms/covered-link-001');
    });
  });
});