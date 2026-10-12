/**
 * B03 — public search/query slug-prefix exclusion (Stage 3B, task t_e8aff02d).
 *
 * `resolveHardExcludes`/`buildHardExcludeClause` and every engine leg already
 * honored a caller-supplied `SearchOpts.exclude_slug_prefixes`, but neither
 * the `search` nor the `query` op DECLARED the parameter, so the CLI/MCP
 * validator dropped it and the engine field was unreachable from the public
 * surface. This drives the REAL dispatch path (dispatchToolCall → op handler →
 * hybridSearchCached / searchKeyword → PGLite SQL) against a disposable
 * in-memory engine, not the helper in isolation:
 *
 *   - the excluded prefix disappears from the result rows on the hybrid leg,
 *     the keyword leg and the `query` op, while an unexcluded control page
 *     (and the same atom page without the param) stays reachable;
 *   - the comma-separated CLI form works;
 *   - a malformed value is refused (invalid_params) and a structurally empty
 *     one is treated as absent (the #5390 convention `types` already uses).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

const PAGES: Array<[string, string, string, Record<string, unknown>]> = [
  ['concepts/widget-pattern', 'the widget pattern is a useful design pattern for widgets', 'concept', { type: 'concept', title: 'Widget Pattern', tags: [] }],
  ['atoms/widget-passage', 'widget passage captured verbatim from a source document', 'atom', { type: 'atom', title: 'Widget passage', tags: [] }],
  ['notes/widget-note', 'widget note describing the widget rollout', 'note', { type: 'note', title: 'Widget note', tags: [] }],
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, body, , fm] of PAGES) {
    await importFromContent(engine, slug, serializeMarkdown({}, body, '', fm as never), { noEmbed: true, forceRechunk: true });
  }
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

async function slugs(name: 'search' | 'query', params: Record<string, unknown>): Promise<string[]> {
  const r = await dispatchToolCall(engine, name, params, { remote: false, transport: 'http', sourceId: 'default' });
  const text = r.content[0]?.text ?? '';
  expect(text, `expected a result array, got: ${text.slice(0, 400)}`).toStartWith('[');
  return (JSON.parse(text) as Array<{ slug: string }>).map(x => x.slug);
}

describe('B03 exclude_slug_prefixes on the public search op', () => {
  test('control: an atom page is returned by the hybrid leg without the param', async () => {
    const slugsOut = await slugs('search', { query: 'widget', limit: 20 });
    expect(slugsOut).toContain('atoms/widget-passage');
    expect(slugsOut).toContain('concepts/widget-pattern');
  });

  test('the caller prefix removes exactly that namespace (hybrid leg)', async () => {
    const slugsOut = await slugs('search', { query: 'widget', limit: 20, exclude_slug_prefixes: ['atoms/'] });
    expect(slugsOut).not.toContain('atoms/widget-passage');
    expect(slugsOut).toContain('concepts/widget-pattern');
    expect(slugsOut).toContain('notes/widget-note');
  });

  test('the array form the CLI parses stacks across several prefixes', async () => {
    const slugsOut = await slugs('search', { query: 'widget', limit: 20, exclude_slug_prefixes: ['atoms/', 'notes/'] });
    expect(slugsOut).toEqual(['concepts/widget-pattern']);
  });

  test('the keyword leg forwards the same exclusion', async () => {
    const control = await slugs('search', { query: 'widget', limit: 20, match: 'keyword' });
    expect(control).toContain('atoms/widget-passage');
    const filtered = await slugs('search', { query: 'widget', limit: 20, match: 'keyword', exclude_slug_prefixes: ['atoms/'] });
    expect(filtered).not.toContain('atoms/widget-passage');
    expect(filtered).toContain('concepts/widget-pattern');
  });

  test('a structurally empty list is treated as absent (no filter applied)', async () => {
    const slugsOut = await slugs('search', { query: 'widget', limit: 20, exclude_slug_prefixes: [] });
    expect(slugsOut).toContain('atoms/widget-passage');
  });

  test('a malformed value is refused as invalid_params', async () => {
    const r = await dispatchToolCall(engine, 'search', { query: 'widget', limit: 20, exclude_slug_prefixes: 42 }, { remote: false, transport: 'http', sourceId: 'default' });
    const text = r.content.map(c => c.text ?? '').join('\n');
    expect(text).toContain('exclude_slug_prefixes');
    expect(text).toContain('invalid_params');
  });
});

describe('B03 exclude_slug_prefixes on the public query op', () => {
  test('the query op forwards the exclusion through the hybrid path', async () => {
    const control = await slugs('query', { query: 'widget', limit: 20, expand: false });
    expect(control).toContain('atoms/widget-passage');
    const filtered = await slugs('query', { query: 'widget', limit: 20, expand: false, exclude_slug_prefixes: ['atoms/'] });
    expect(filtered).not.toContain('atoms/widget-passage');
    expect(filtered).toContain('concepts/widget-pattern');
  });

  test('the query op refuses a malformed value the same way', async () => {
    const r = await dispatchToolCall(engine, 'query', { query: 'widget', expand: false, exclude_slug_prefixes: { a: 1 } }, { remote: false, transport: 'http', sourceId: 'default' });
    const text = r.content.map(c => c.text ?? '').join('\n');
    expect(text).toContain('exclude_slug_prefixes');
    expect(text).toContain('invalid_params');
  });
});
