/**
 * Expose `exclude_slug_prefixes?: string[]` on the public search + query ops
 * (atom-exclusion avenue).
 *
 * The SQL-level plumbing (SearchOpts.exclude_slug_prefixes → both engines'
 * keyword/vector/hybrid legs via resolveHardExcludes, consumed as
 * `AND NOT (slug LIKE '<prefix>%')`) has existed for the DEFAULT_HARD_EXCLUDES
 * set; pre-fix the search and query ops simply never accepted the param, so
 * MCP/CLI callers could not carve out an opaque slug-namespaced set (e.g. the
 * `atoms/` prefix). Pins: the prefix excludes ONLY matching slugs, absent is
 * byte-for-byte identical to current behavior, CLI comma-string form works,
 * and junk rejects as invalid_params.
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

/** Builds a page that is findable for the query text, namespaced by slug. */
async function seedPage(slug: string, label: string): Promise<void> {
  await engine.putPage(slug, {
    type: label.startsWith('atoms/') ? 'atom' : 'note',
    title: `Quasar ${label}`,
    compiled_truth: `the quasar telescope glows in the ${label} page`,
    frontmatter: {},
  });
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: `the quasar telescope glows in the ${label} page`, chunk_source: 'compiled_truth' },
  ]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Two atom slugs under the `atoms/` namespace plus two non-atom slugs.
  await seedPage('atoms/alpha', 'atom-alpha');
  await seedPage('atoms/beta', 'atom-beta');
  await seedPage('notes/quasar-note', 'note');
  await seedPage('concepts/quasar-concept', 'concept');
  // Keyword-only path for the search op: no embedding provider needed.
  await engine.setConfig('search.mcp_keyword_only', 'true');
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

function slugsOf(results: unknown): string[] {
  return (results as SearchResult[]).map((r) => r.slug).sort();
}

describe('search op — exclude_slug_prefixes', () => {
  test('absent option preserves exact current behavior (all slugs)', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'quasar telescope' });
    expect(slugsOf(out)).toEqual(['atoms/alpha', 'atoms/beta', 'concepts/quasar-concept', 'notes/quasar-note']);
  });

  test("prefix 'atoms/' excludes only atom slugs", async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'quasar telescope', exclude_slug_prefixes: ['atoms/'] });
    expect(slugsOf(out)).toEqual(['concepts/quasar-concept', 'notes/quasar-note']);
  });

  test('unrelated prefix leaves every slug intact (exclusion is additive, not type-blind)', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'quasar telescope', exclude_slug_prefixes: ['test/'] });
    expect(slugsOf(out)).toEqual(['atoms/alpha', 'atoms/beta', 'concepts/quasar-concept', 'notes/quasar-note']);
  });

  test('CLI comma-string form works (--exclude-slug-prefixes atoms/)', async () => {
    const out = await searchOp.handler(ctxOf(), { query: 'quasar telescope', exclude_slug_prefixes: 'atoms/' });
    expect(slugsOf(out)).toEqual(['concepts/quasar-concept', 'notes/quasar-note']);
  });

  test('non-string entries reject loudly as invalid_params', async () => {
    await expect(
      searchOp.handler(ctxOf(), { query: 'quasar telescope', exclude_slug_prefixes: [42] }),
    ).rejects.toThrow(/exclude_slug_prefixes.*must be an array/i);
  });

  test('all-empty list rejects loudly instead of silently dropping the filter', async () => {
    await expect(
      searchOp.handler(ctxOf(), { query: 'quasar telescope', exclude_slug_prefixes: ' , ' }),
    ).rejects.toThrow(/no usable slug-prefix/i);
  });
});

describe('query op — exclude_slug_prefixes', () => {
  test('prefix exclusion applies on the no-provider hybrid path', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), {
        query: 'quasar telescope',
        expand: false,
        exclude_slug_prefixes: ['atoms/'],
      });
      expect(slugsOf(out)).toEqual(['concepts/quasar-concept', 'notes/quasar-note']);
    });
  });

  test('query without the option keeps full recall', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = await queryOp.handler(ctxOf(), { query: 'quasar telescope', expand: false });
      expect(slugsOf(out)).toEqual(['atoms/alpha', 'atoms/beta', 'concepts/quasar-concept', 'notes/quasar-note']);
    });
  });

  test('junk excludes reject before any retrieval work', async () => {
    await expect(
      queryOp.handler(ctxOf(), { query: 'quasar telescope', exclude_slug_prefixes: { atoms: true } }),
    ).rejects.toThrow(/exclude_slug_prefixes.*must be an array/i);
  });
});