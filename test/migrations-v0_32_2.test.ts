/**
 * v0.32.2 — migration orchestrator tests.
 *
 * Covers phaseASchema (asserts v51 ran), phaseBFenceFacts (legacy
 * row → derived fence document under strict preservation: no stamped
 * position, no rewritten claim, no page body gaining a fence; idempotent
 * re-run, dry-run, NULL entity_slug skip, missing local_path skip), and
 * phaseCVerify (both coordinate systems: the fence against the index and
 * every derived document against its current originals).
 *
 * Real PGLite + real tempdir filesystem. Engine injected via
 * __setTestEngineOverride so we don't need a configured brain.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { v0_32_2, __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, upsertFactRow, type ParsedFact } from '../src/core/facts-fence.ts';
import {
  derivedFenceOf, planPagePreservedFencePublication, readPreservedFencePublication,
} from '../src/core/facts/preserved-fence-store.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const DRY_OPTS = { ...OPTS, dryRun: true };

/** The derived document of one page, which must exist by the time it is read. */
async function derivedDocument(slug: string) {
  const document = await readPreservedFencePublication(engine, 'default', slug);
  expect(document).not.toBeNull();
  return document!;
}

async function seedLegacyFact(input: {
  entity_slug: string | null;
  fact: string;
  source_id?: string;
  visibility?: 'private' | 'world';
  notability?: 'high' | 'medium' | 'low';
  withPage?: boolean;
}): Promise<number> {
  const sourceId = input.source_id ?? 'default';
  if (input.entity_slug && input.withPage !== false &&
      !await engine.getPage(input.entity_slug, { sourceId })) {
    await engine.putPage(input.entity_slug, {
      type: 'note', title: input.entity_slug, compiled_truth: '# Existing page\n', frontmatter: {},
    }, { sourceId });
    const sources = await engine.executeRaw<{ local_path: string | null }>(
      'SELECT local_path FROM sources WHERE id = $1', [sourceId],
    );
    const root = sources[0]?.local_path;
    if (root) {
      const path = join(root, `${input.entity_slug}.md`);
      mkdirSync(join(path, '..'), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, '# Existing page\n');
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, source, confidence)
     VALUES ($1, $2, $3, 'fact', $4, $5, now(), 'mcp:put_page', 1.0)
     RETURNING id`,
    [
      input.source_id ?? 'default',
      input.entity_slug,
      input.fact,
      input.visibility ?? 'private',
      input.notability ?? 'medium',
    ],
  );
  return r.rows[0].id;
}

describe('phaseASchema', () => {
  test('passes when schema is at v51', async () => {
    // initSchema ran v51, so the version config + columns are set.
    const r = await __testing.phaseASchema(engine, OPTS);
    expect(r.status).toBe('complete');
  });

  test('skipped under dry-run', async () => {
    const r = await __testing.phaseASchema(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('dry-run');
  });

  test('skipped when no engine is available', async () => {
    const r = await __testing.phaseASchema(null, OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('no_brain_configured');
  });
});

describe('phaseBFenceFacts — dry-run reporting', () => {
  test('reports counts without writing FS or updating DB', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });
    await seedLegacyFact({ entity_slug: 'people/bob', fact: 'Met at YC W22' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unparented claim' });

    const r = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('dry-run');
    expect(r.detail).toContain('would fence 2 rows');  // 3 total - 1 unparented
    expect(r.detail).toContain('1 unfenceable');

    expect(readFileSync(join(brainDir, 'people/alice.md'), 'utf8')).toBe('# Existing page\n');
    expect(readFileSync(join(brainDir, 'people/bob.md'), 'utf8')).toBe('# Existing page\n');
    // DB rows still have NULL row_num.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT row_num FROM facts WHERE entity_slug IS NOT NULL',
    );
    expect(rows.rows.every((r: { row_num: number | null }) => r.row_num === null)).toBe(true);
  });
});

describe('phaseBFenceFacts — happy path backfill', () => {
  test('publishes legacy DB rows into the page derived document and leaves the originals literal', async () => {
    const id1 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme in 2017' });
    const id2 = await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Prefers async over meetings' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=2');
    expect(r.detail).toContain('pages=1');

    // Strict preservation: no page body gained a fence and no row was stamped.
    const filePath = join(brainDir, 'people/alice.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('# Existing page\n');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      'SELECT id, row_num, source_markdown_slug, fact FROM facts ORDER BY id',
    );
    expect(rows.rows[0]).toMatchObject({ id: id1, row_num: null, source_markdown_slug: null, fact: 'Founded Acme in 2017' });
    expect(rows.rows[1]).toMatchObject({ id: id2, row_num: null, source_markdown_slug: null, fact: 'Prefers async over meetings' });

    // The adopted positions live in the derived document, bound to both rows.
    const document = await derivedDocument('people/alice');
    expect(document.bindings.map(binding => binding.original_fact_id).sort()).toEqual([String(id1), String(id2)].sort());
    expect(document.bindings.every(binding => binding.original_row_num === null)).toBe(true);
    expect(new Set(document.bindings.map(binding => binding.derived_row_num)).size).toBe(2);
    expect(document.derived_body).toContain('## Facts');
    expect(document.derived_body).toContain('Founded Acme in 2017');
    expect(document.derived_body).toContain('Prefers async over meetings');
  });

  test('groups by entity page — multi-entity batch touches multiple files', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'A1' });
    await seedLegacyFact({ entity_slug: 'companies/acme', fact: 'C1' });
    await seedLegacyFact({ entity_slug: 'deals/seed', fact: 'D1' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=3');
    expect(r.detail).toContain('pages=3');

    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'companies/acme.md'))).toBe(true);
    expect(existsSync(join(brainDir, 'deals/seed.md'))).toBe(true);
  });

  test('keeps an existing entity page byte-identical and publishes the fence into the derived document', async () => {
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    const original = '---\ntype: person\ntitle: Alice\nslug: people/alice\n---\n\n# Alice\n\nNotes about Alice.\n';
    writeFileSync(join(brainDir, 'people/alice.md'), original, 'utf-8');
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    await __testing.phaseBFenceFacts(engine, OPTS);

    expect(readFileSync(join(brainDir, 'people/alice.md'), 'utf-8')).toBe(original);
    const document = await derivedDocument('people/alice');
    expect(document.bindings).toHaveLength(1);
    expect(document.derived_body).toContain('## Facts');
    expect(document.derived_body).toContain('Founded Acme');
  });

  test('idempotent: re-running republishes the same derived document without duplicating rows', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'First' });
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Second' });

    await __testing.phaseBFenceFacts(engine, OPTS);
    const first = await derivedDocument('people/alice');
    expect(first.bindings).toHaveLength(2);

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');

    // The projection is recomputed from the same originals, so it reads back
    // identical, and no fact row was added or stamped.
    const second = await derivedDocument('people/alice');
    expect(second).toEqual(first);
    expect(second).toEqual(await planPagePreservedFencePublication(engine, 'default', 'people/alice'));
    const derived = derivedFenceOf(second);
    expect(derived.map(row => row.claim).sort()).toEqual(['First', 'Second']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts ORDER BY id');
    expect(rows.rows.map((row: { row_num: number | null }) => row.row_num)).toEqual([null, null]);
  });

  test('skips facts with NULL entity_slug (unfenceable)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Fenceable' });
    await seedLegacyFact({ entity_slug: null, fact: 'Unfenceable' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=1');
    expect(r.detail).toContain('skipped_no_entity=1');

    // The unparented fact's row_num remains NULL and no document binds it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT entity_slug, row_num FROM facts ORDER BY id`,
    );
    expect(rows.rows[0]).toMatchObject({ entity_slug: 'people/alice', row_num: null });
    expect(rows.rows[1]).toMatchObject({ entity_slug: null, row_num: null });
    expect((await derivedDocument('people/alice')).bindings).toHaveLength(1);
  });

  test('skips when source has no local_path', async () => {
    // Wipe default source's local_path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Whatever' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('skipped_no_local_path=1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
  });
});

describe('phaseBFenceFacts — missing pages and occupied fence rows', () => {
  const slug = 'people/alice-example';

  async function page(body = '# Existing notes\n', sourcePath = `${slug}.md`): Promise<string> {
    await engine.putPage(slug, {
      type: 'person', title: 'Alice Example', compiled_truth: body, frontmatter: {}, source_path: sourcePath,
    }, { sourceId: 'default' });
    const filePath = join(brainDir, sourcePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, body);
    return filePath;
  }

  test('skips unresolved root slugs and missing page files without creating stubs or deleting facts', async () => {
    const existingPath = await page();
    await seedLegacyFact({ entity_slug: slug, fact: 'Existing page fact' });
    await seedLegacyFact({ entity_slug: 'missing-example', fact: 'Unresolved root fact', withPage: false });
    await seedLegacyFact({ entity_slug: 'projects/missing-example', fact: 'Missing prefixed fact', withPage: false });
    await engine.putPage('projects/missing-example', {
      type: 'project', title: 'Missing Example', compiled_truth: 'DB-only page', frontmatter: {},
    }, { sourceId: 'default' });
    const result = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(result.status).toBe('complete');
    expect(result.detail).toContain('skipped_no_page=2');
    expect(result.detail).toContain('fenced=1');
    expect(existsSync(join(brainDir, 'missing-example.md'))).toBe(false);
    expect(existsSync(join(brainDir, 'projects/missing-example.md'))).toBe(false);
    // The recorded page keeps its own body: the adopted position is published
    // into the derived document, never appended to the page.
    expect(readFileSync(existingPath, 'utf8')).toBe('# Existing notes\n');
    const rows = await engine.executeRaw<{ fact: string; row_num: number | null }>(
      `SELECT fact, row_num FROM facts ORDER BY id`,
    );
    expect(rows).toEqual([
      { fact: 'Existing page fact', row_num: null },
      { fact: 'Unresolved root fact', row_num: null },
      { fact: 'Missing prefixed fact', row_num: null },
    ]);
    expect(derivedFenceOf(await derivedDocument(slug)).map(row => row.claim)).toEqual(['Existing page fact']);
  });

  test('requires a live entity page in the fact source even when an orphan file exists', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('migration-other', 'Other') ON CONFLICT DO NOTHING`);
    await engine.putPage('foreign-example', {
      type: 'note', title: 'Foreign Example', compiled_truth: 'Other source', frontmatter: {},
    }, { sourceId: 'migration-other' });
    const orphan = join(brainDir, 'foreign-example.md');
    writeFileSync(orphan, '# Local orphan file\n');
    await seedLegacyFact({ entity_slug: 'foreign-example', fact: 'Keep unparented', withPage: false });
    const result = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(result.detail).toContain('skipped_no_page=1');
    expect(readFileSync(orphan, 'utf8')).toBe('# Local orphan file\n');
  });

  test('dry-run reports missing pages and a dirty source containing only unfenceable facts is a no-op', async () => {
    execFileSync('git', ['-C', brainDir, 'init', '-q']);
    writeFileSync(join(brainDir, 'unrelated.md'), '# Uncommitted notes\n');
    await seedLegacyFact({ entity_slug: 'missing-example', fact: 'No target', withPage: false });
    const dry = await __testing.phaseBFenceFacts(engine, DRY_OPTS);
    expect(dry.status).toBe('skipped');
    expect(dry.detail).toContain('would fence 0 rows');
    expect(dry.detail).toContain('skipped_no_page=1');
    const write = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(write.status).toBe('complete');
    expect(write.detail).toContain('skipped_no_page=1');
    expect(existsSync(join(brainDir, 'missing-example.md'))).toBe(false);
  });

  test('publishes against the recorded page path instead of creating a slug-named twin', async () => {
    const path = await page('# Existing notes\n', 'People/Alice Example.md');
    await seedLegacyFact({ entity_slug: slug, fact: 'Recorded file fact' });
    expect((await __testing.phaseBFenceFacts(engine, OPTS)).status).toBe('complete');
    // The recorded file is the page the document is planned from, and it stays as it is.
    expect(readFileSync(path, 'utf8')).toBe('# Existing notes\n');
    expect(existsSync(join(brainDir, `${slug}.md`))).toBe(false);
    expect(derivedFenceOf(await derivedDocument(slug)).map(row => row.claim)).toEqual(['Recorded file fact']);
    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');
  });

  test('allocates above DB-owned numbers after a markdown fence disappeared, without renumbering the original', async () => {
    await page();
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source, row_num, source_markdown_slug)
       VALUES ('default', $1, 'Already indexed', 'fact', 'mcp:put_page', 7, $1)`, [slug],
    );
    await seedLegacyFact({ entity_slug: slug, fact: 'Needs fencing' });
    const result = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(result.status).toBe('complete');
    // Originals literal: the row that held 7 keeps 7 and the legacy row keeps NULL.
    expect(await engine.executeRaw(`SELECT fact, row_num FROM facts ORDER BY id`)).toEqual([
      { fact: 'Already indexed', row_num: 7 }, { fact: 'Needs fencing', row_num: null },
    ]);
    const document = await derivedDocument(slug);
    expect(document.bindings.map(binding => [binding.original_row_num, binding.derived_row_num]))
      .toEqual([[7, 7], [null, 8]]);
  });

  test('moves a stranded colliding row without dropping an earlier appended fact', async () => {
    const body = upsertFactRow('# Existing notes\n', {
      rowNum: 1, claim: 'Stranded fact', kind: 'fact', confidence: 1, visibility: 'private',
      notability: 'medium', source: 'mcp:put_page',
    }).body;
    const path = await page(body);
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source, row_num, source_markdown_slug)
       VALUES ('default', $1, 'Already indexed', 'fact', 'mcp:put_page', 1, $1)`, [slug],
    );
    await seedLegacyFact({ entity_slug: slug, fact: 'Append before stranded' });
    await seedLegacyFact({ entity_slug: slug, fact: 'Stranded fact' });
    const before = await engine.executeRaw('SELECT id, fact, row_num, source_markdown_slug, expired_at FROM facts ORDER BY id');
    const result = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(result.status).toBe('complete');
    expect(result.detail).toContain('scanned=3 fenced=3 pages=1');
    expect(result.detail).toContain('renumbered=1');
    // The page keeps its own fence with the stranded row exactly where it was.
    expect(readFileSync(path, 'utf8')).toBe(body);
    expect(await engine.executeRaw('SELECT id, fact, row_num, source_markdown_slug, expired_at FROM facts ORDER BY id')).toEqual(before);
    // The collision is resolved in the DERIVED document: the colliding
    // DB-owned claim takes 2, the appended row 3, and the stranded fence row
    // 4 — neither claim is dropped.
    const derived = derivedFenceOf(await derivedDocument(slug));
    expect(derived.map(row => [row.claim, row.rowNum]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([['Already indexed', 2], ['Append before stranded', 3], ['Stranded fact', 4]]);
    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');
    const rerun = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(rerun.detail).toBe('scanned=3 fenced=0 pages=0 skipped_no_entity=0 skipped_no_local_path=0 skipped_no_page=0');
    expect(readFileSync(path, 'utf8')).toBe(body);
    expect(await engine.executeRaw('SELECT id, fact, row_num, source_markdown_slug, expired_at FROM facts ORDER BY id')).toEqual(before);
  });

  test('never lets two legacy rows claim the same stranded fence row', async () => {
    const body = upsertFactRow('# Notes\n', {
      rowNum: 5, claim: 'Same claim', kind: 'fact', confidence: 1, visibility: 'private',
      notability: 'medium', source: 'mcp:put_page',
    }).body;
    const path = await page(body);
    await seedLegacyFact({ entity_slug: slug, fact: 'Same claim' });
    await seedLegacyFact({ entity_slug: slug, fact: 'Same claim', visibility: 'world' });
    expect((await __testing.phaseBFenceFacts(engine, OPTS)).status).toBe('complete');
    expect(readFileSync(path, 'utf8')).toBe(body);
    expect(derivedFenceOf(await derivedDocument(slug)).map(row => row.rowNum)).toEqual([5, 6]);
    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');
  });

  test('preserves a legitimate DB-owned matching fence row and appends the separate legacy fact', async () => {
    const body = upsertFactRow('# Notes\n', {
      rowNum: 4, claim: 'Shared claim', kind: 'fact', confidence: 0.8, visibility: 'private',
      notability: 'high', source: 'mcp:put_page', context: 'Original provenance',
      claimMetric: 'count', claimValue: 8,
    }).body;
    const path = await page(body);
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source, row_num, source_markdown_slug)
       VALUES ('default', $1, 'Shared claim', 'fact', 'mcp:put_page', 4, $1)`, [slug],
    );
    await seedLegacyFact({ entity_slug: slug, fact: 'Shared claim', visibility: 'world' });
    expect((await __testing.phaseBFenceFacts(engine, OPTS)).status).toBe('complete');
    // The fence row the database already owns is carried unchanged, provenance
    // and claim metrics included; only the separate legacy fact is appended.
    expect(readFileSync(path, 'utf8')).toBe(body);
    const facts = derivedFenceOf(await derivedDocument(slug));
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      rowNum: 4, claim: 'Shared claim', confidence: 0.8, visibility: 'private',
      notability: 'high', context: 'Original provenance', claimMetric: 'count', claimValue: 8,
    });
    expect(facts[1]).toMatchObject({ rowNum: 5, claim: 'Shared claim', visibility: 'world' });
    expect((await __testing.phaseCVerify(engine, OPTS)).status).toBe('complete');
  });

  test('does not re-fence soft-expired facts or rewrite a malformed existing fence', async () => {
    const path = await page();
    const id = await seedLegacyFact({ entity_slug: slug, fact: 'Withdrawn fact' });
    await engine.executeRaw('UPDATE facts SET expired_at = now() WHERE id = $1', [id]);
    expect((await __testing.phaseBFenceFacts(engine, OPTS)).status).toBe('complete');
    expect(readFileSync(path, 'utf8')).toBe('# Existing notes\n');
    expect((await engine.executeRaw<{ row_num: number | null }>(
      'SELECT row_num FROM facts WHERE id = $1', [id],
    ))[0].row_num).toBeNull();

    const malformed = '# Notes\n\n## Facts\n<!--- gbrain:facts:begin -->\n| not a valid header |\n<!--- gbrain:facts:end -->\n';
    writeFileSync(path, malformed);
    await seedLegacyFact({ entity_slug: slug, fact: 'New fact' });
    expect((await __testing.phaseBFenceFacts(engine, OPTS)).status).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });
});

describe('subdirectory source dirty check', () => {
  test('ignores sibling changes but refuses changes inside the source', async () => {
    execFileSync('git', ['-C', brainDir, 'init', '-q']);
    const sourcePath = join(brainDir, 'source');
    mkdirSync(sourcePath);
    writeFileSync(join(brainDir, 'sibling.md'), 'Unrelated change');
    expect(__testing.isLocalPathDirty(sourcePath)).toBe(false);
    writeFileSync(join(sourcePath, 'local.md'), 'Local change');
    expect(__testing.isLocalPathDirty(sourcePath)).toBe(true);
  });
});

describe('phaseBFenceFacts — dirty-tree refusal scoping (#927)', () => {
  let dirtyDir: string;

  beforeEach(async () => {
    // A second source whose local_path is a git repo with uncommitted changes.
    dirtyDir = mkdtempSync(join(tmpdir(), 'mig-v0_32_2-dirty-'));
    execFileSync('git', ['-C', dirtyDir, 'init', '-q']);
    writeFileSync(join(dirtyDir, 'uncommitted.md'), 'dirty', 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', $1)`,
      [dirtyDir],
    );
  });

  afterEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`DELETE FROM sources WHERE id = 'other'`);
    rmSync(dirtyDir, { recursive: true, force: true });
  });

  test('no legacy facts at all → complete, dirty unrelated source ignored', async () => {
    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('scanned=0');
  });

  test('facts scoped to a clean source fence despite dirty unrelated source', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('fenced=1');
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(true);
  });

  test('still refuses when the TARGETED source is dirty', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'F1', source_id: 'other' });

    const r = await __testing.phaseBFenceFacts(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('"other"');
    expect(r.detail).toContain('uncommitted changes');
  });
});

describe('phaseCVerify', () => {
  test('returns complete when the fence, the index and the derived document agree', async () => {
    await writeFencedPage([fenceRow(1, 'Lives in Paris'), fenceRow(2, 'Works at Acme example')]);
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', $1, 'Lives in Paris', 'fact', 'private', 'medium', now(), 'manual', 1.0, 1, $1),
              ('default', $1, 'Works at Acme example', 'fact', 'private', 'medium', now(), 'manual', 1.0, 2, $1)`,
      [SLUG],
    );
    // A legacy row is adopted: the backfill publishes the page's derived document.
    await seedLegacyFact({ entity_slug: SLUG, fact: 'Adopted later', withPage: false });
    expect((await __testing.phaseBFenceFacts(engine, OPTS)).status).toBe('complete');
    expect(derivedFenceOf(await derivedDocument(SLUG)).map(row => row.claim))
      .toEqual(['Lives in Paris', 'Works at Acme example', 'Adopted later']);

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('pages_checked=1');
  });

  test('returns failed when the fence drifts from the database', async () => {
    await writeFencedPage([fenceRow(1, 'Lives in Paris')]);
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', $1, 'Lives in Paris', 'fact', 'private', 'medium', now(), 'manual', 1.0, 1, $1)`,
      [SLUG],
    );

    // Corrupt the fence: append a row manually that's not in the DB.
    const path = join(brainDir, `${SLUG}.md`);
    const body = readFileSync(path, 'utf-8');
    const corrupted = body.replace(
      '<!--- gbrain:facts:end -->',
      '| 99 | extra row | fact | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->',
    );
    expect(corrupted).not.toBe(body);
    writeFileSync(path, corrupted, 'utf-8');

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toContain('drifted');
    expect(r.detail).toContain(SLUG);
  });

  test('ignores conversation-miner facts that have no markdown fence', async () => {
    await writeFencedPage([fenceRow(1, 'Lives in Paris')]);
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', $1, 'Lives in Paris', 'fact', 'private', 'medium', now(), 'manual', 1.0, 1, $1)`,
      [SLUG],
    );

    const slug = 'cursor-sessions/chat-1';
    mkdirSync(join(brainDir, 'cursor-sessions'), { recursive: true });
    writeFileSync(
      join(brainDir, `${slug}.md`),
      '---\ntype: conversation\n---\n\n# chat\n\nhello\n',
      'utf-8',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                          valid_from, source, confidence, row_num, source_markdown_slug)
       VALUES ('default', NULL, 'Said hello', 'fact', 'private', 'medium',
               now(), 'cli:extract-conversation-facts:seg', 1.0, 1, $1)`,
      [slug],
    );

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('complete');
    expect(r.detail).toContain('pages_checked=1');
  });

  // #5814: extract_facts indexes a duplicate ACTIVE fence row (same claim and
  // source) once (#1781), so the fence legitimately holds one row more than
  // the index. Verify must read that page as in sync, and still catch a fence
  // row or an indexed row the other side lacks.
  const SLUG = 'people/alice-example';
  const fenceRow = (rowNum: number, claim: string): ParsedFact => ({
    rowNum, claim, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
    validFrom: '2026-01-01', source: 'manual', active: true,
  });
  const DUPLICATE_FENCE = [fenceRow(1, 'Lives in Paris'), fenceRow(2, 'Lives in Paris'), fenceRow(3, 'Works at Acme example')];

  async function writeFencedPage(rows: ParsedFact[]): Promise<void> {
    const body = replaceOrInsertFactsFence('# Alice Example\n', renderFactsTable(rows));
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    writeFileSync(join(brainDir, `${SLUG}.md`), `---\ntype: person\ntitle: Alice Example\n---\n\n${body}`);
    await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: body, frontmatter: {} });
  }

  async function indexedRowNums(): Promise<number[]> {
    const rows = await engine.executeRaw<{ row_num: number }>(
      'SELECT row_num FROM facts WHERE source_markdown_slug = $1 AND row_num IS NOT NULL ORDER BY row_num', [SLUG]);
    return rows.map(r => Number(r.row_num));
  }

  test('a duplicate active row that extract_facts indexes once is in sync (#5814)', async () => {
    await writeFencedPage(DUPLICATE_FENCE);
    await runExtractFacts(engine, { slugs: [SLUG] });
    expect(await indexedRowNums()).toEqual([1, 3]);

    expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'complete', detail: 'pages_checked=1' });
  });

  test.each([
    ['a non-duplicate fence row is not indexed', [1, 2], 'not indexed: 3'],
    ['an indexed row number is not in the fence', [1, 3, 4], 'not in fence: 4'],
    ['each side holds a row number the other lacks', [1, 4], 'not indexed: 3; not in fence: 4'],
    ['more row numbers are missing than the detail lists', [1, 3, 4, 5, 6, 7, 8, 9, 10], 'not in fence: 4, 5, 6, 7, 8, +2 more'],
  ])('reports drift on a page with a duplicate active row when %s (#5814)', async (_case, indexed, missing) => {
    await writeFencedPage(DUPLICATE_FENCE);
    for (const rowNum of indexed) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                            valid_from, source, confidence, row_num, source_markdown_slug)
         VALUES ('default', $1, $2, 'fact', 'private', 'medium', now(), 'manual', 1.0, $3, $1)`,
        [SLUG, DUPLICATE_FENCE[rowNum - 1]?.claim ?? `Visited city ${rowNum}`, rowNum],
      );
    }

    const r = await __testing.phaseCVerify(engine, OPTS);
    expect(r.status).toBe('failed');
    expect(r.detail).toBe(`1 pages drifted: ${SLUG} (fence=3, db=${indexed.length}; ${missing})`);
  });
});

describe('orchestrator end-to-end', () => {
  test('clean run returns status:complete with 3 phases', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Founded Acme' });

    const result = await v0_32_2.orchestrator(OPTS);
    expect(result.version).toBe('0.32.2');
    expect(result.status).toBe('complete');
    expect(result.phases.map(p => p.name)).toEqual(['schema', 'fence_facts', 'verify']);
    expect(result.phases.every(p => p.status === 'complete')).toBe(true);
  });

  test('dry-run returns 3 phases all skipped (no FS or DB changes)', async () => {
    await seedLegacyFact({ entity_slug: 'people/alice', fact: 'Should not get fenced', withPage: false });

    const result = await v0_32_2.orchestrator(DRY_OPTS);
    expect(result.status).toBe('complete');
    expect(result.phases.every(p => p.status === 'skipped')).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT row_num FROM facts');
    expect(rows.rows[0].row_num).toBeNull();
    expect(existsSync(join(brainDir, 'people/alice.md'))).toBe(false);
  });
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});
