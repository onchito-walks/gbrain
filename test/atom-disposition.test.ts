/**
 * Stage 3B B27 (task t_e8aff02d) — read-time atom_disposition enrichment from
 * canonical companion assessment pages.
 *
 * Real paths only: a disposable in-memory PGLite engine, the module's own
 * batched loader, the public `search` op and the public `get_page` op. The
 * companion assessment is written the way the evidence-repair pass writes it
 * (a SEPARATE canonical `operations/atom-evidence-repair-20261011/assessments-*`
 * note carrying a frontmatter `atom_assessments` array); the atom itself is
 * never touched.
 *
 * Guarded behaviour: same-source + visibility isolation, field-exact binding
 * against the live atom, fail-closed stale/conflict/absent handling, sanitized
 * references, historical=true / certified=false framing, stale-clearing on the
 * cache-hit path, and no original-atom mutation.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { computeAtomBodySha256, stampAtomDispositions } from '../src/core/search/atom-disposition.ts';

let engine: PGLiteEngine;

const TOKEN = 'dispositio';
const ASSESS_PAGE = 'operations/atom-evidence-repair-20261011/assessments-2026-01-01';
const VALIDATED_SLUG = 'notes/evidence-page';

function doc(type: string, title: string, body: string, extra: Record<string, string> = {}): string {
  const head = ['---', `type: ${type}`, `title: ${title}`, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`).map(s => s.replace('=', ': ')), '---', ''];
  return `${head.join('\n')}\n${body}\n`;
}

async function put(slug: string, content: string, sourceId = 'default'): Promise<void> {
  await importFromContent(engine, slug, content, { noEmbed: true, forceRechunk: true, sourceId });
}

async function pageRow(slug: string): Promise<{ id: number; body: string; sh: string | null; ss: string | null }> {
  const rows = await engine.executeRaw<{ id: number; body: string; sh: string | null; ss: string | null }>(
    `SELECT id, compiled_truth AS body, frontmatter->>'source_hash' AS sh, frontmatter->>'source_slug' AS ss
       FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]);
  return rows[0];
}

/** The evidence-repair pass writes the record array onto the companion note. */
async function writeAssessments(records: unknown[]): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages SET frontmatter = COALESCE(frontmatter,'{}'::jsonb) || jsonb_build_object('atom_assessments', $1::jsonb)
      WHERE slug = $2 AND source_id = 'default'`,
    [JSON.stringify(records), ASSESS_PAGE]);
}

/** A well-formed record bound exactly to the live atom. */
async function recordFor(slug: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const row = await pageRow(slug);
  return {
    atom_id: Number(row.id),
    atom_slug: slug,
    source_id: 'default',
    frozen_source_hash: row.sh,
    frozen_source_slug: row.ss,
    body_sha256: computeAtomBodySha256(row.body),
    status: 'retained',
    explanation: 'passage verified against the live source page',
    assessed_at: '2026-10-11T00:00:00Z',
    ...over,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await put('notes/live', doc('note', 'Live page', `${TOKEN} the live source body`));
  await put('notes/evidence-page', doc('note', 'Evidence page', `${TOKEN} cited evidence`));
  await put('notes/private-evidence', doc('note', 'Private evidence', `${TOKEN} private evidence`, { visibility: 'private' }));
  await put('atoms/2026-01-01/assessable', doc('atom', 'Assessable atom', `${TOKEN} assessed passage`, { source_slug: 'notes/live', source_hash: 'aaaabbbbccccdddd' }));
  await put('atoms/2026-01-01/unassessed', doc('atom', 'Unassessed atom', `${TOKEN} no companion record`, { source_slug: 'notes/live', source_hash: 'aaaabbbbccccdddd' }));
  await put(ASSESS_PAGE, doc('note', 'Assessment companion', 'holds the atom_assessments array'));
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

async function dispositionViaModule(slug: string): Promise<Record<string, unknown> | undefined> {
  const row = await pageRow(slug);
  const page = await engine.getPage(slug);
  const map = await (await import('../src/core/search/atom-disposition.ts')).loadAtomDispositions(engine, [{
    id: Number(row.id), slug, source_id: 'default', source_hash: row.sh, source_slug: row.ss,
    body_sha256: computeAtomBodySha256(row.body),
  }]);
  expect(page?.slug).toBe(slug);
  return map.get(Number(row.id)) as unknown as Record<string, unknown> | undefined;
}

describe('B27 read-time atom disposition', () => {
  test('a field-exact, same-source assessment is surfaced as historical evidence', async () => {
    const rec = await recordFor('atoms/2026-01-01/assessable', { evidence_slug: VALIDATED_SLUG, successor_slug: '/etc/passwd' });
    await writeAssessments([rec]);
    const d = await dispositionViaModule('atoms/2026-01-01/assessable');
    expect(d?.status).toBe('retained');
    expect(d?.historical).toBe(true);
    expect(d?.certified).toBe(false);
    expect((d?.warning as Record<string, unknown>)?.code).toBe('historical_not_certified');
    expect(d?.source_id).toBe('default');
    expect(d?.assessment_slug).toBe(ASSESS_PAGE);
    // Sanitized references: a live same-source slug is exposed; a filesystem
    // path shape is never exposed.
    expect(d?.evidence_slug).toBe(VALIDATED_SLUG);
    expect(d?.successor_slug).toBeUndefined();
  });

  test('a stale binding fails closed', async () => {
    const rec = await recordFor('atoms/2026-01-01/assessable');
    await writeAssessments([rec]);
    // The atom changes after it was assessed → the frozen body hash no longer matches.
    await put('atoms/2026-01-01/assessable', doc('atom', 'Assessable atom', `${TOKEN} assessed passage REWRITTEN`, { source_slug: 'notes/live', source_hash: 'aaaabbbbccccdddd' }));
    const d = await dispositionViaModule('atoms/2026-01-01/assessable');
    expect(d?.status).toBe('untrusted');
    expect((d?.warning as Record<string, unknown>)?.code).toBe('assessment_stale');
    expect(d?.certified).toBe(false);
  });

  test('disagreeing records fail closed and an unassessed atom stays absent', async () => {
    const a = await recordFor('atoms/2026-01-01/assessable', { status: 'retained' });
    const b = await recordFor('atoms/2026-01-01/assessable', { status: 'superseded', assessed_at: '2026-10-12T00:00:00Z' });
    await writeAssessments([a, b]);
    const d = await dispositionViaModule('atoms/2026-01-01/assessable');
    expect(d?.status).toBe('untrusted');
    expect((d?.warning as Record<string, unknown>)?.code).toBe('assessment_conflict');
    expect(await dispositionViaModule('atoms/2026-01-01/unassessed')).toBeUndefined();
  });

  test('the stamp clears a stale disposition before re-enriching (cache-hit path)', async () => {
    await writeAssessments([]);           // no companion record any more
    const rows = [{ page_id: (await pageRow('atoms/2026-01-01/assessable')).id, type: 'atom', slug: 'atoms/2026-01-01/assessable', atom_disposition: { status: 'stale-cached' } }] as never[];
    await stampAtomDispositions(engine, rows as never);
    expect((rows[0] as Record<string, unknown>).atom_disposition).toBeUndefined();
  });
});

describe('B27 enrichment on the public read paths', () => {
  test('get_page and search both surface the validated disposition', async () => {
    const rec = await recordFor('atoms/2026-01-01/assessable', { evidence_slug: VALIDATED_SLUG });
    await writeAssessments([rec]);

    const got = await dispatchToolCall(engine, 'get_page', { slug: 'atoms/2026-01-01/assessable' }, { remote: false, transport: 'http', sourceId: 'default' });
    const page = JSON.parse(got.content[0]?.text ?? '{}') as { atom_disposition?: Record<string, unknown> };
    expect(page.atom_disposition?.status).toBe('retained');
    expect(page.atom_disposition?.historical).toBe(true);

    const found = await dispatchToolCall(engine, 'search', { query: TOKEN, limit: 50, include_covered_atoms: true }, { remote: false, transport: 'http', sourceId: 'default' });
    const rows = JSON.parse(found.content[0]?.text ?? '[]') as Array<{ slug: string; atom_disposition?: Record<string, unknown> }>;
    const atom = rows.find(r => r.slug === 'atoms/2026-01-01/assessable');
    expect(atom?.atom_disposition?.status).toBe('retained');
    expect(atom?.atom_disposition?.certified).toBe(false);
    // The original atom body and its frozen provenance are untouched.
    const row = await pageRow('atoms/2026-01-01/assessable');
    expect(row.body).toContain('REWRITTEN');
    expect(row.ss).toBe('notes/live');
  });

  test('the direct keyword path (match: keyword) also carries the disposition', async () => {
    const rec = await recordFor('atoms/2026-01-01/assessable', { evidence_slug: VALIDATED_SLUG });
    await writeAssessments([rec]);

    // `match: keyword` takes the op's direct-FTS path (its own stampKeywordRows
    // tail), a different route from the hybrid arms above.
    const found = await dispatchToolCall(engine, 'search', { query: TOKEN, limit: 50, match: 'keyword', include_covered_atoms: true }, { remote: false, transport: 'http', sourceId: 'default' });
    const rows = JSON.parse(found.content[0]?.text ?? '[]') as Array<{ slug: string; atom_disposition?: Record<string, unknown> }>;
    const atom = rows.find(r => r.slug === 'atoms/2026-01-01/assessable');
    expect(atom?.atom_disposition?.status).toBe('retained');
    expect(atom?.atom_disposition?.historical).toBe(true);
    expect(atom?.atom_disposition?.certified).toBe(false);
  });
});
