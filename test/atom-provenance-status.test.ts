/**
 * Stage 3B B09 (task t_e8aff02d) — read-time atom provenance quote status.
 *
 * Drives real code, not helpers:
 *   - `classifyAtomProvenanceRecords` against a disposable in-memory engine
 *     (two real SELECTs), asserting every status, the legacy-alias resolution,
 *     source isolation and the read-only guarantee;
 *   - the public `search` op (dispatchToolCall → hybridSearchCached → PGLite
 *     SQL) for the caller-visible `provenance_status` marker;
 *   - the real `atom_provenance_drift` doctor check for the honest detail keys.
 *
 * Statuses:
 *   fresh                      source_hash still resolves to a live page
 *   quote_present_in_live_page drifted, source page alive, quote still folds in
 *   quote_orphaned             drifted, source page alive, quote no longer folds
 *   source_gone                drifted, no live non-atom page at the frozen slug
 *                              (exact, or via the single legacy alias)
 *   slug_unbound              no source_slug — not page-checkable
 *
 * A surviving quote is evidence the PASSAGE persisted; it is NOT a claim that
 * the atom is sound. Nothing here may write `source_hash`, frontmatter or
 * `page_versions` — asserted directly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { classifyAtomProvenanceRecords, type AtomProvenanceStatus } from '../src/core/cycle/provenance-status.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor/checks/extraction-sync.ts';

let engine: PGLiteEngine;

const TOKEN = 'quokkastation';
const QUOTE = 'the quivering passage survives verbatim';
const GONE_QUOTE = 'a passage no live page carries anymore';
const ALIAS_FROZEN = 'hermes-moncho/notes/live';
const STALE_HASH = 'deadbeefdeadbeef';

function doc(type: string, title: string, body: string, extra: Record<string, string> = {}): string {
  const head = ['---', `type: ${type}`, `title: ${title}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), '---', ''];
  return `${head.join('\n')}\n${body}\n`;
}

async function put(slug: string, sourceId: string, content: string): Promise<void> {
  await importFromContent(engine, slug, content, { noEmbed: true, forceRechunk: true, sourceId });
}

async function atomRecords(): Promise<Array<{ slug: string; sourceId: string; sourceSlug: string | null; sourceHash: string | null; sourceQuote: string | null }>> {
  const rows = await engine.executeRaw<{ slug: string; sid: string; ss: string | null; sh: string | null; q: string | null }>(
    `SELECT slug, source_id AS sid,
            frontmatter->>'source_slug' AS ss,
            frontmatter->>'source_hash' AS sh,
            frontmatter->>'source_quote' AS q
       FROM pages WHERE type = 'atom' AND deleted_at IS NULL ORDER BY slug`);
  return rows.map(r => ({ slug: r.slug, sourceId: r.sid, sourceSlug: r.ss, sourceHash: r.sh, sourceQuote: r.q }));
}

async function statusesBySlug(): Promise<Map<string, AtomProvenanceStatus>> {
  const records = await atomRecords();
  const verdicts = await classifyAtomProvenanceRecords(engine, records);
  return new Map(records.map((r, i) => [r.slug, verdicts[i].status]));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");

  // The live source page (default source). Its content_hash feeds the `fresh` case.
  await put('notes/live', 'default', doc('note', 'Live page', `${TOKEN} ${QUOTE} and then some more words`));
  const hashRows = await engine.executeRaw<{ sh: string | null }>(
    `SELECT substring(content_hash from 1 for 16) AS sh FROM pages WHERE slug = 'notes/live' AND source_id = 'default'`);
  const liveHash = hashRows[0]?.sh ?? '';
  expect(liveHash).toBeTruthy();

  await put('atoms/fresh', 'default', doc('atom', 'Fresh atom', `${TOKEN} claim text`, { source_slug: 'notes/live', source_hash: liveHash, source_quote: QUOTE }));
  await put('atoms/quote-present', 'default', doc('atom', 'Quote present atom', `${TOKEN} claim text`, { source_slug: 'notes/live', source_hash: STALE_HASH, source_quote: QUOTE }));
  await put('atoms/quote-orphaned', 'default', doc('atom', 'Quote orphaned atom', `${TOKEN} claim text`, { source_slug: 'notes/live', source_hash: STALE_HASH, source_quote: GONE_QUOTE }));
  await put('atoms/source-gone', 'default', doc('atom', 'Source gone atom', `${TOKEN} claim text`, { source_slug: 'notes/vanished', source_hash: STALE_HASH, source_quote: QUOTE }));
  await put('atoms/alias-resolved', 'default', doc('atom', 'Alias resolved atom', `${TOKEN} claim text`, { source_slug: ALIAS_FROZEN, source_hash: STALE_HASH, source_quote: QUOTE }));
  await put('atoms/slug-unbound', 'default', doc('atom', 'Slug unbound atom', `${TOKEN} claim text`, { source_hash: STALE_HASH, source_quote: QUOTE }));
  // Same frozen slug, but the cover lives in the OTHER source only.
  await put('atoms/cross-source', 'other', doc('atom', 'Cross source atom', `${TOKEN} claim text`, { source_slug: 'notes/live', source_hash: STALE_HASH, source_quote: QUOTE }));

  // Enough additional source-gone atoms to cross the check's warn threshold
  // (MIN_DRIFTED = 25) so the operator-visible warn message is exercised.
  for (let i = 0; i < 22; i++) {
    await put(`atoms/bulk-gone-${i}`, 'default', doc('atom', `Bulk gone ${i}`, `${TOKEN} claim text`, { source_slug: 'notes/vanished-bulk', source_hash: STALE_HASH, source_quote: QUOTE }));
  }
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

describe('B09 read-time provenance classification', () => {
  test('every status is derived from the live corpus', async () => {
    const s = await statusesBySlug();
    expect(s.get('atoms/fresh')).toBe('fresh');
    expect(s.get('atoms/quote-present')).toBe('quote_present_in_live_page');
    expect(s.get('atoms/quote-orphaned')).toBe('quote_orphaned');
    expect(s.get('atoms/source-gone')).toBe('source_gone');
    expect(s.get('atoms/alias-resolved')).toBe('quote_present_in_live_page');
    expect(s.get('atoms/slug-unbound')).toBe('slug_unbound');
    expect(s.get('atoms/cross-source')).toBe('source_gone');   // never crosses source_id
  });

  test('classification is read-only: frozen fields and versions are untouched', async () => {
    const before = await atomRecords();
    const versionsBefore = await engine.executeRaw<{ n: string }>(`SELECT count(*) AS n FROM page_versions`);
    await statusesBySlug();
    await statusesBySlug();
    const after = await atomRecords();
    const versionsAfter = await engine.executeRaw<{ n: string }>(`SELECT count(*) AS n FROM page_versions`);
    expect(after).toEqual(before);
    expect(Number(versionsAfter[0].n)).toBe(Number(versionsBefore[0].n));
  });
});

describe('B09 provenance_status on search results', () => {
  test('the public search op stamps atom rows and leaves ordinary pages alone', async () => {
    const r = await dispatchToolCall(engine, 'search',
      { query: TOKEN, limit: 50, include_covered_atoms: true },
      { remote: false, transport: 'http', sourceId: 'default' });
    const rows = JSON.parse(r.content[0]?.text ?? '[]') as Array<{ slug: string; type: string; provenance_status?: string }>;
    const bySlug = new Map(rows.map(x => [x.slug, x.provenance_status]));
    expect(bySlug.get('atoms/quote-present')).toBe('quote_present_in_live_page');
    expect(bySlug.get('atoms/source-gone')).toBe('source_gone');
    expect(bySlug.get('notes/live')).toBeUndefined();          // non-atom: never stamped
    expect(rows.find(x => x.slug === 'atoms/fresh')?.provenance_status).toBe('fresh');
  });
});

describe('B09 atom_provenance_drift doctor check', () => {
  test('reports the real per-class detail and keeps the historical-warn honesty', async () => {
    const check = await computeAtomProvenanceDriftCheck(engine);
    const d = check.details as Record<string, unknown>;
    expect(d.total_atoms).toBe(28);         // page-bound atoms only (all but the slug-unbound one)
    expect(d.slug_unbound).toBe(1);
    expect(d.fresh).toBe(1);
    expect(d.drifted).toBe(27);
    expect(d.source_changed).toBe(3);       // quote-present, quote-orphaned, alias-resolved
    expect(d.source_gone).toBe(24);         // vanished slug, the cross-source atom, the 22 bulk atoms
    expect(d.quote_probe).toBe('folded');
    expect(d.quote_present_in_live_page).toBe(2); // alias-resolved counts via the legacy alias
    expect(d.quote_orphaned).toBe(1);
    // The operator-visible warn must state the read-time truth, never "the
    // evidence is gone": a surviving quote means the passage persisted.
    expect(check.status).toBe('warn');
    expect(String(check.message)).toContain("still carry the atom's source_quote verbatim");
    expect(String(check.message)).toContain('binding-freshness signal, not an integrity verdict');
    expect(String(check.message)).toContain('does NOT restore the atom');
  });
});
