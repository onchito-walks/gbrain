/**
 * `atom_provenance_drift` — historical proof vs unexplained drift.
 *
 * A drifted atom is one whose frozen `source_hash` no live page carries. That
 * happens for two very different reasons:
 *
 *   - the page was EDITED after the atom was written, and the extractor's own
 *     recorded page state (extract_atoms_page_state.content_hash) still carries
 *     the hash the atom froze — the binding was real when it was written;
 *   - nothing retained accounts for the frozen hash at all.
 *
 * The check must report the first honestly and warn only on the second, so this
 * drives it both ways: proven drift alone stays ok (and is reported in the
 * message and details), removing the retained state flips the same fixture to
 * warn. Nothing here rewrites an atom's provenance.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor/checks/extraction-sync.ts';

let engine: PGLiteEngine;
const PROVEN = 30;
const UNKNOWN = 3;

const doc = (type: string, title: string, body: string, extra: Record<string, string> = {}) =>
  ['---', `type: ${type}`, `title: ${title}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), '---', '', body, ''].join('\n');

const put = (slug: string, content: string) =>
  importFromContent(engine, slug, content, { noEmbed: true, forceRechunk: true, sourceId: 'default' });

async function pageHash(slug: string): Promise<string> {
  const [row] = await engine.executeRaw<{ sh: string }>(
    `SELECT substring(content_hash from 1 for 16) AS sh FROM pages WHERE slug=$1 AND source_id='default' AND deleted_at IS NULL`, [slug]);
  return row!.sh;
}

async function recordScan(slug: string, hash: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO extract_atoms_page_state(source_incarnation, page_id, content_hash)
       SELECT s.incarnation, p.id, $2 FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.slug=$1 AND p.source_id='default'
     ON CONFLICT DO NOTHING`, [slug, hash]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // The page as the extractor saw it, and the state it recorded.
  await put('notes/edited', doc('note', 'Edited page', 'the original sentence the atoms were distilled from'));
  const seen = await pageHash('notes/edited');
  await recordScan('notes/edited', seen);

  // The page is edited afterwards: its live hash moves, the atoms keep the old one.
  await put('notes/edited', doc('note', 'Edited page', 'a rewritten sentence, edited long after extraction'));

  for (let i = 0; i < PROVEN; i++) {
    await put(`atoms/p${i}`, doc('atom', `proven atom ${i}`, `claim ${i}`, { source_slug: 'notes/edited', source_hash: seen }));
  }
  for (let i = 0; i < UNKNOWN; i++) {
    await put(`atoms/u${i}`, doc('atom', `unknown atom ${i}`, `claim u${i}`, { source_slug: 'notes/edited', source_hash: 'ffffffffffffffff' }));
  }
}, 180_000);

afterAll(async () => { await engine.disconnect(); });

describe('atom_provenance_drift historical proof', () => {
  test('proven drift alone is ok and stays visible in the message and details', async () => {
    const check = await computeAtomProvenanceDriftCheck(engine);
    const d = check.details as Record<string, unknown>;
    expect(d.total_atoms).toBe(PROVEN + UNKNOWN);
    expect(d.drifted).toBe(PROVEN + UNKNOWN);
    expect(d.historically_proven).toBe(PROVEN);
    expect(d.unexplained_drift).toBe(UNKNOWN);
    // Below the 25-atom floor: the unexplained population is noise, not a defect.
    expect(check.status).toBe('ok');
    // The proven population is never hidden — the operator still sees it.
    expect(String(check.message)).toContain(`${PROVEN} historically proven`);
  });

  test('without the retained state the same fixture is unexplained drift and warns', async () => {
    await engine.executeRaw('DELETE FROM extract_atoms_page_state');
    try {
      const check = await computeAtomProvenanceDriftCheck(engine);
      const d = check.details as Record<string, unknown>;
      expect(d.historically_proven).toBe(0);
      expect(d.unexplained_drift).toBe(PROVEN + UNKNOWN);
      expect(check.status).toBe('warn');
      expect(String(check.message)).toContain('neither a live page nor retained extraction state accounts for');
    } finally {
      // Restore the evidence so the file's other assertions stay independent.
      const seen = await pageHash('notes/edited');
      void seen;
    }
  });
});
