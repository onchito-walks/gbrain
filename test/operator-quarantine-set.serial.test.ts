/**
 * Operator quarantine-set — hermetic PGLite fixture.
 *
 * Pins the first-class, fail-closed, metadata-only wrong-root incident lane
 * (`gbrain quarantine set --manifest <JSONL>`), which exists as a deliberate
 * alternative to a bulk `gbrain import` (source-cycle) bypass of the
 * git-managed owner gate.
 *
 * Contract under test:
 *   1. manifest JSONL parses fail-closed (missing field / dup / bad hash →
 *      error; a comma-containing source_path survives verbatim);
 *   2. plan verifies EXACT rows (id + slug + source_id + content_hash +
 *      source_path) and rejects canonical-file-backed pages;
 *   3. apply writes ONLY a `frontmatter.quarantine` marker — content_hash,
 *      chunks, and page_aliases are byte-for-byte unchanged; page generation
 *      and the global query-generation clock both advance;
 *   4. quarantine filter hides the page from keyword AND vector search;
 *   5. rollback (from the before-state snapshot) removes the marker, again
 *      leaving content_hash/chunks/aliases untouched;
 *   6. the write is NOT the owner/coordinator mutation path (no worktree
 *      binding, no persistence request) — owner-gate semantics.
 *
 * Fresh PGLite per test (resetPgliteState) + a temp source root on disk.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { hybridSearchCached } from '../src/core/search/hybrid.ts';
import { buildVisibilityClause } from '../src/core/search/sql-ranking.ts';
import { probeProjectionReadiness } from '../src/core/search/projection-readiness.ts';
import { isQuarantined } from '../src/core/quarantine.ts';
import {
  parseOperatorManifest,
  planOperatorQuarantine,
  applyOperatorQuarantine,
  rollbackOperatorQuarantine,
  buildOperatorQuarantineMarker,
  OperatorQuarantineError,
  QUARANTINE_SET_HARD_CAP,
  type OperatorManifestRecord,
  type OperatorQuarantineSnapshot,
} from '../src/core/operator-quarantine.ts';
import type { ChunkInput } from '../src/core/types.ts';

const DIM = 1536;

function basisEmbedding(idx: number): Float32Array {
  const e = new Float32Array(DIM);
  e[idx % DIM] = 1.0;
  return e;
}

let engine: PGLiteEngine;
let root: string;
const savedKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { ...process.env },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  delete process.env.OPENAI_API_KEY;
  root = mkdtempSync(join(tmpdir(), 'op-quarantine-root-'));
});

afterAll(async () => {
  if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await engine.disconnect(); } catch { /* ignore */ }
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Fresh source root per test (a previous test may have materialized a
  // canonical file to exercise the canonical_file_backed rejection).
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  // Registry the incident-relevant source root (the canonical hermes-moncho
  // tree). The wrong-root pages' recorded source_path does NOT resolve here,
  // so they are correctly classified as DB-only.
  await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [root]);
});

// The 5 fixture records — including a comma-containing source_path and a
// page_alias row.
const FIXTURE = [
  { slug: 'readwise/incident-one',     source_path: 'Readwise/one.md' },
  { slug: 'readwise/incident-two',     source_path: 'Readwise/Tldraw 250309, v2.md' },
  { slug: 'tldraw/tldraw-250309-10.21', source_path: 'tldraw/Tldraw 250309 10.21.md' },
  { slug: 'hermes-moncho/conversations/foo', source_path: 'hermes-moncho/conversations/foo.md' },
  { slug: 'untitled',                   source_path: 'Untitled.md' },
] as const;

async function seedFive(): Promise<OperatorManifestRecord[]> {
  const records: OperatorManifestRecord[] = [];
  for (const f of FIXTURE) {
    await engine.putPage(f.slug, {
      type: 'note',
      title: f.slug,
      compiled_truth: `INC_BODY ${f.slug}`,
      source_path: f.source_path,
      frontmatter: {},
    });
  }
  // One alias row (slug-keyed, must never be touched by the marker lane).
  await engine.executeRaw(
    `INSERT INTO page_aliases(source_id, alias_norm, slug) VALUES ('default','incident alias two','readwise/incident-two')
     ON CONFLICT DO NOTHING`,
  );
  for (const f of FIXTURE) {
    const row = (await engine.executeRaw<{ id: number; slug: string; content_hash: string; source_path: string; source_id: string }>(
      `SELECT id, slug, source_id, content_hash, source_path FROM pages WHERE slug=$1 AND source_id='default'`,
      [f.slug],
    ))[0]!;
    records.push({ id: Number(row.id), slug: row.slug, source_id: row.source_id, content_hash: row.content_hash, source_path: row.source_path });
  }
  return records;
}

function manifestText(records: OperatorManifestRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

async function snapshot(cols = ''): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw(`SELECT id, slug, content_hash, generation, frontmatter ${cols} FROM pages ORDER BY id`);
}

describe('operator quarantine-set — manifest parsing (fail-closed)', () => {
  test('parses JSONL and preserves a comma-containing source_path verbatim', () => {
    const records = seedNoneParse([{ id: 1, slug: 'readwise/x', source_id: 'default', content_hash: 'a'.repeat(64), source_path: 'Readwise/Tldraw 250309, v2.md' }]);
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    expect(parsed[0]!.source_path).toBe('Readwise/Tldraw 250309, v2.md');
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('rejects a line missing content_hash', () => {
    const bad = JSON.stringify({ id: 1, slug: 'a', source_id: 'default', source_path: 'a.md' });
    expect(() => parseOperatorManifest(bad)).toThrow(OperatorQuarantineError);
  });

  test('rejects a duplicate id', () => {
    const r: OperatorManifestRecord = { id: 1, slug: 'a', source_id: 'default', content_hash: 'a'.repeat(64), source_path: 'a.md' };
    expect(() => parseOperatorManifest(manifestText([r, { ...r, slug: 'b' }]))).toThrow(/duplicate/i);
  });

  test('rejects an empty manifest', () => {
    expect(() => parseOperatorManifest('\n\n')).toThrow(OperatorQuarantineError);
  });

  test('hard cap is declared and positive', () => {
    expect(QUARANTINE_SET_HARD_CAP).toBeGreaterThanOrEqual(6916);
  });
});

function seedNoneParse(records: OperatorManifestRecord[]): OperatorManifestRecord[] {
  return records;
}

describe('operator quarantine-set — plan / apply / search / rollback', () => {
  test('dry-run plan finds exactly 5 eligible DB-only rows', async () => {
    const records = await seedFive();
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const plan = await planOperatorQuarantine(engine, parsed, { sourceId: 'default', incident: 'fixture', manifestSha256: sha256 });
    expect(plan.eligible.length).toBe(5);
    expect(plan.rejections.length).toBe(0);
    expect(plan.already.length).toBe(0);
    // dry-run must not mutate
    for (const id of records.map((r) => r.id)) {
      const row = (await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [id]))[0]!;
      expect(isQuarantined(row.frontmatter)).toBe(false);
    }
  });

  test('apply writes only the marker; content_hash/chunks/aliases unchanged; generation + clock advance', async () => {
    const records = await seedFive();
    // install a chunk so search can prove exclusion
    await installFixtureChunks(engine, 'readwise/incident-one', [
      { chunk_index: 0, chunk_text: 'INC_BODY readwise/incident-one', chunk_source: 'compiled_truth', embedding: basisEmbedding(0) } satisfies ChunkInput,
    ]);
    const beforeRows = await snapshot(', page_kind');
    const beforeChunks = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks`))[0]!.n;
    const beforeAliases = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_aliases`))[0]!.n;
    const beforeClock = (await engine.executeRaw<{ last_value: string }>(`SELECT last_value FROM page_generation_clock_seq`))[0]!.last_value;
    const beforeJobs = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_projection_jobs`))[0]!.n;

    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const { applied, snapshot: snap } = await applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256,
    });
    expect(applied).toBe(5);
    expect(snap.rows.length).toBe(5);

    const afterRows = await snapshot(', page_kind');
    for (let i = 0; i < beforeRows.length; i++) {
      expect(afterRows[i]!.content_hash).toBe(beforeRows[i]!.content_hash);
      const fm = afterRows[i]!.frontmatter as Record<string, unknown>;
      expect(isQuarantined(fm)).toBe(true);
      const marker = fm.quarantine as Record<string, unknown>;
      expect(marker.reason).toBe('wrong-root-sync');
      expect(marker.operator).toBe(true);
      expect(marker.manifest_sha256).toBe(sha256);
      // generation strictly advanced (query-cache invalidation)
      expect(Number(afterRows[i]!.generation)).toBeGreaterThan(Number(beforeRows[i]!.generation));
    }
    const afterChunks = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks`))[0]!.n;
    const afterAliases = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_aliases`))[0]!.n;
    const afterClock = (await engine.executeRaw<{ last_value: string }>(`SELECT last_value FROM page_generation_clock_seq`))[0]!.last_value;
    expect(afterChunks).toBe(beforeChunks);
    expect(afterAliases).toBe(beforeAliases);
    expect(Number(afterClock)).toBeGreaterThan(Number(beforeClock));
    // projection-job state is restored to its pre-write state (no collateral churn)
    const jobs = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_projection_jobs`))[0]!.n;
    expect(jobs).toBe(beforeJobs);
  });

  test('quarantine filter hides the page from keyword AND vector search', async () => {
    const records = await seedFive();
    // clean control page with a matching chunk/embedding
    await engine.putPage('readwise/clean-control', { type: 'note', title: 'clean control', compiled_truth: 'CONTROL BODY' });
    await installFixtureChunks(engine, 'readwise/clean-control', [
      { chunk_index: 0, chunk_text: 'CONTROL BODY', chunk_source: 'compiled_truth', embedding: basisEmbedding(0) } satisfies ChunkInput,
    ]);
    await installFixtureChunks(engine, 'readwise/incident-one', [
      { chunk_index: 0, chunk_text: 'INC_BODY readwise/incident-one', chunk_source: 'compiled_truth', embedding: basisEmbedding(0) } satisfies ChunkInput,
    ]);

    // sanity: both legs see them before quarantine
    expect((await engine.searchVector(basisEmbedding(0), { limit: 10, detail: 'high' })).map((r) => r.slug)).toContain('readwise/incident-one');
    expect((await hybridSearchCached(engine, 'INC_BODY', { limit: 10, sourceId: 'default' })).map((r) => r.slug)).toContain('readwise/incident-one');

    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    await applyOperatorQuarantine(engine, parsed, { sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256 });

    // keyword leg (no embedding provider → keyword path)
    const kw = await hybridSearchCached(engine, 'INC_BODY', { limit: 10, sourceId: 'default' });
    expect(kw.map((r) => r.slug)).not.toContain('readwise/incident-one');
    // non-quarantined control is still returned (no over-reach)
    expect((await hybridSearchCached(engine, 'CONTROL BODY', { limit: 10, sourceId: 'default' })).map((r) => r.slug)).toContain('readwise/clean-control');
    // vector leg
    const vec = await engine.searchVector(basisEmbedding(0), { limit: 10, detail: 'high' });
    expect(vec.map((r) => r.slug)).not.toContain('readwise/incident-one');

    // the shared visibility clause carries the quarantine filter for both legs
    expect(buildVisibilityClause('p', 's')).toContain(`? 'quarantine'`);
  });

  test('rollback from snapshot removes only the operator marker', async () => {
    const records = await seedFive();
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const applied = await applyOperatorQuarantine(engine, parsed, { sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256 });
    const beforeRollback = await snapshot();
    const { rolledBack } = await rollbackOperatorQuarantine(engine, applied.snapshot);
    expect(rolledBack).toBe(5);
    const afterRollback = await snapshot();
    for (let i = 0; i < beforeRollback.length; i++) {
      expect(afterRollback[i]!.content_hash).toBe(beforeRollback[i]!.content_hash);
      expect(isQuarantined(afterRollback[i]!.frontmatter as Record<string, unknown>)).toBe(false);
      expect(Number(afterRollback[i]!.generation)).toBeGreaterThan(Number(beforeRollback[i]!.generation));
    }
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_aliases`))[0]!.n).toBe(1);
  });

  test('rollback refuses when the live marker provenance no longer matches the snapshot', async () => {
    const records = await seedFive();
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const applied = await applyOperatorQuarantine(engine, parsed, { sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256 });
    // tamper: overwrite one page's marker with a different provenance
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('quarantine', $1::text::jsonb) WHERE id=$2`,
      [JSON.stringify(buildOperatorQuarantineMarker('wrong-root-sync', { incident: 'someone-else', manifestSha256: 'f'.repeat(64) })), records[0]!.id]);
    await expect(rollbackOperatorQuarantine(engine, applied.snapshot)).rejects.toThrow(OperatorQuarantineError);
  });
});

describe('operator quarantine-set — fail-closed guards', () => {
  test('rejects a canonical-file-backed page (file exists under the source root)', async () => {
    const records = await seedFive();
    // materialize the canonical file for record 0
    const p = join(root, 'Readwise/one.md');
    mkdirSync(join(root, 'Readwise'), { recursive: true });
    writeFileSync(p, '---\ntitle: one\n---\nbody\n');
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const plan = await planOperatorQuarantine(engine, parsed, { sourceId: 'default', incident: 'fixture', manifestSha256: sha256 });
    expect(plan.eligible.length).toBe(4);
    expect(plan.rejections.some((r) => r.reason === 'canonical_file_backed')).toBe(true);
    await expect(applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256,
    })).rejects.toThrow(/canonical_file_backed/);
  });

  test('rejects a content_hash mismatch (stale manifest)', async () => {
    const records = await seedFive();
    records[0] = { ...records[0]!, content_hash: '0'.repeat(64) };
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const plan = await planOperatorQuarantine(engine, parsed, { sourceId: 'default', incident: 'fixture', manifestSha256: sha256 });
    expect(plan.rejections.some((r) => r.reason === 'content_hash_mismatch')).toBe(true);
  });

  test('rejects a source_path mismatch', async () => {
    const records = await seedFive();
    records[1] = { ...records[1]!, source_path: 'Readwise/wrong-path.md' };
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const plan = await planOperatorQuarantine(engine, parsed, { sourceId: 'default', incident: 'fixture', manifestSha256: sha256 });
    expect(plan.rejections.some((r) => r.reason === 'source_path_mismatch')).toBe(true);
  });
});

describe('operator quarantine-set — owner-gate semantics', () => {
  test('applies without creating a worktree binding or persistence request (not the coordinator path)', async () => {
    const records = await seedFive();
    const beforeWt = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_worktrees`))[0]!.n;
    const beforeReq = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests`))[0]!.n;
    const writeThrough = await engine.getConfig('sync.write_through');
    // fixture default: write-through resolves ON and there is no canonical
    // worktree binding — the exact state where the owner-gated put_page path
    // returns owner_unavailable. The operator lane must still succeed.
    expect(beforeWt).toBe(0);
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    await applyOperatorQuarantine(engine, parsed, { sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256 });
    const afterWt = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_worktrees`))[0]!.n;
    const afterReq = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests`))[0]!.n;
    expect(afterWt).toBe(beforeWt);
    expect(afterReq).toBe(beforeReq);
    void writeThrough;
  });

  test('snapshot round-trips through disk (before-state is durable)', async () => {
    const records = await seedFive();
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot: snap } = await applyOperatorQuarantine(engine, parsed, { sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256 });
    const file = join(root, 'snapshot.json');
    writeFileSync(file, JSON.stringify(snap));
    const loaded = JSON.parse(readFileSync(file, 'utf8')) as OperatorQuarantineSnapshot;
    expect(loaded.rows.length).toBe(5);
    expect(loaded.manifest_sha256).toBe(sha256);
    await rollbackOperatorQuarantine(engine, loaded);
  });
});

describe('operator quarantine-set — CLI end-to-end', () => {
  test('gbrain quarantine set --yes applies, then rollback --yes clears', async () => {
    const records = await seedFive();
    const manifestFile = join(root, 'manifest.jsonl');
    writeFileSync(manifestFile, manifestText(records));
    const snapFile = join(root, 'cli-snapshot.json');
    const { runQuarantine } = await import('../src/commands/quarantine.ts');

    // dry-run first: no mutation
    await runQuarantine(engine, ['set', '--manifest', manifestFile, '--reason', 'wrong-root-sync', '--snapshot-out', snapFile, '--dry-run', '--json']);
    expect(isQuarantined((await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [records[0]!.id]))[0]!.frontmatter)).toBe(false);

    // apply
    await runQuarantine(engine, ['set', '--manifest', manifestFile, '--reason', 'wrong-root-sync', '--snapshot-out', snapFile, '--yes', '--json']);
    for (const r of records) {
      expect(isQuarantined((await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [r.id]))[0]!.frontmatter)).toBe(true);
    }
    const snap = JSON.parse(readFileSync(snapFile, 'utf8')) as OperatorQuarantineSnapshot;
    expect(snap.rows.length).toBe(5);

    // rollback
    await runQuarantine(engine, ['rollback', '--snapshot', snapFile, '--yes', '--json']);
    for (const r of records) {
      expect(isQuarantined((await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [r.id]))[0]!.frontmatter)).toBe(false);
    }
  });

  test('refuses an unknown --reason before touching the DB', async () => {
    const records = await seedFive();
    const manifestFile = join(root, 'manifest2.jsonl');
    writeFileSync(manifestFile, manifestText(records));
    const { runQuarantine } = await import('../src/commands/quarantine.ts');
    const origExit = process.exit;
    class ExitSignal extends Error { constructor(public code: number) { super('exit'); } }
    // process.exit is typed as never; stub it to THROW so execution halts the
    // way a real exit would (a no-op stub would let runSet continue to mutate).
    (process as unknown as { exit: (c?: number) => void }).exit = ((c?: number) => { throw new ExitSignal(c ?? 0); }) as never;
    let code: number | undefined;
    try {
      await runQuarantine(engine, ['set', '--manifest', manifestFile, '--reason', 'not-a-reason', '--yes']);
    } catch (err) {
      if (err instanceof ExitSignal) code = err.code;
      else throw err;
    } finally {
      (process as unknown as { exit: typeof origExit }).exit = origExit;
    }
    expect(code).toBe(2);
    expect(isQuarantined((await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [records[0]!.id]))[0]!.frontmatter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Projection visibility through apply + rollback (adversarial review blocker #1).
//
// The marker UPDATE bumps knowledge_revision, which NULLs text_projection_revision
// and queues a projection job. The prototype's job-restore then DELETED that job
// WITHOUT re-sealing the projection, so the page was left permanently
// `text_projection_revision IS DISTINCT FROM knowledge_revision`:
//   - every text/keyword search hides it (currentTextProjectionFilter), and
//   - doctor / probeProjectionReadiness reports projection_pending forever,
// even after a rollback removed the marker.
// The fix re-seals text_projection_revision=knowledge_revision for the exact
// affected rows that were sealed before the write, so apply keeps the page
// projection-ready (and hidden by its marker) and rollback restores search.
// ---------------------------------------------------------------------------

async function sealedNow(id: number): Promise<boolean> {
  const row = (await engine.executeRaw<{ s: boolean }>(
    `SELECT (text_projection_revision = knowledge_revision) IS TRUE AS s FROM pages WHERE id=$1`,
    [id],
  ))[0]!;
  return row.s === true;
}

/** Seal every fixture page so a source-scoped readiness probe sees only them. */
async function sealAll(records: readonly OperatorManifestRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    await installFixtureChunks(engine, r.slug, [
      { chunk_index: 0, chunk_text: `INC_BODY ${r.slug}`, chunk_source: 'compiled_truth', embedding: basisEmbedding(i) } satisfies ChunkInput,
    ]);
  }
}

describe('operator quarantine-set — projection visibility (apply + rollback)', () => {
  test('apply keeps targets projection-ready; rollback restores keyword search and readiness', async () => {
    const records = await seedFive();
    await sealAll(records);
    const kw = async () => (await hybridSearchCached(engine, 'INC_BODY', { limit: 10, sourceId: 'default' })).map((r) => r.slug);

    // Pre-state: every target is sealed, searchable, and readiness is clean.
    for (const r of records) expect(await sealedNow(r.id)).toBe(true);
    expect(await kw()).toContain('readwise/incident-one');
    expect((await probeProjectionReadiness(engine, { sourceId: 'default' })).status).toBe('ready');

    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot } = await applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256,
    });

    // Apply: pages stay projection-ready (no permanent projection_pending) and
    // are hidden ONLY by their quarantine marker.
    for (const r of records) expect(await sealedNow(r.id)).toBe(true);
    expect((await probeProjectionReadiness(engine, { sourceId: 'default' })).status).toBe('ready');
    expect(await kw()).not.toContain('readwise/incident-one');

    // Rollback: the marker clears AND the page is searchable/projection-ready again.
    await rollbackOperatorQuarantine(engine, snapshot);
    for (const r of records) expect(await sealedNow(r.id)).toBe(true);
    expect((await probeProjectionReadiness(engine, { sourceId: 'default' })).status).toBe('ready');
    expect(await kw()).toContain('readwise/incident-one');
  });

  test('rollback heals a page left unsealed with no job by the pre-fix lane (restores search)', async () => {
    const records = await seedFive();
    await sealAll(records);
    const target = records[0]!;
    const kw = async () => (await hybridSearchCached(engine, 'INC_BODY', { limit: 10, sourceId: 'default' })).map((r) => r.slug);
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot } = await applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256,
    });
    // Emulate the pre-fix prototype's residue on one target: marker present but
    // text_projection_revision NULL and the queued job deleted → permanently
    // hidden with no worker to repair it.
    await engine.executeRaw(`UPDATE pages SET text_projection_revision=NULL WHERE id=$1`, [target.id]);
    await engine.executeRaw(
      `DELETE FROM page_projection_jobs j USING sources s, pages p
        WHERE j.source_incarnation=s.incarnation AND j.slug=p.slug AND p.id=$1`,
      [target.id],
    );
    expect(await sealedNow(target.id)).toBe(false);
    expect(await kw()).not.toContain('readwise/incident-one');

    await rollbackOperatorQuarantine(engine, snapshot);
    // The post-condition sweep must leave every row either sealed or queued;
    // this one is sealed, so search comes back.
    expect(await sealedNow(target.id)).toBe(true);
    for (const r of records) expect(await sealedNow(r.id)).toBe(true);
    expect(await kw()).toContain('readwise/incident-one');
    expect((await probeProjectionReadiness(engine, { sourceId: 'default' })).status).toBe('ready');
  });

  test('a pre-existing pending projection is preserved, not silently sealed', async () => {
    const records = await seedFive();
    // Leave the target UNSEALED with its original pending job (as an unprojected page is).
    const target = records[0]!;
    await engine.executeRaw(
      `INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
         SELECT s.incarnation, p.slug, p.knowledge_revision, 'canonical_change'
           FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1
       ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason`,
      [target.id],
    );
    const before = (await engine.executeRaw<{ revision: string }>(
      `SELECT j.revision FROM page_projection_jobs j JOIN pages p ON p.slug=j.slug JOIN sources s ON s.incarnation=j.source_incarnation WHERE p.id=$1`,
      [target.id],
    ))[0]!;
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot } = await applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256,
    });
    // The page was NOT sealed before, so it must remain pending (still queued),
    // and the marker write must not silently claim it is projected.
    expect(await sealedNow(target.id)).toBe(false);
    const after = (await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM page_projection_jobs j JOIN pages p ON p.slug=j.slug AND p.source_id='default' WHERE p.id=$1`,
      [target.id],
    ))[0]!.n;
    expect(after).toBe(1);
    void before;
    await rollbackOperatorQuarantine(engine, snapshot);
    expect(await sealedNow(target.id)).toBe(false);
  });
});

describe('operator quarantine-set — concurrency + persistence guards', () => {
  test('metadata-only inventory classification preserves exact body, hash, chunks, aliases and other frontmatter through apply/rollback', async () => {
    const records = await seedFive();
    const fm = { visibility: 'private', tags: ['keep'], custom: { nested: ['unchanged', 17] } };
    await engine.executeRaw(`UPDATE pages SET frontmatter=$1::text::jsonb WHERE id=$2`, [JSON.stringify(fm), records[0]!.id]);
    // A frontmatter update may change the hash; capture the actual immutable manifest afterwards.
    records[0]!.content_hash = (await engine.executeRaw<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE id=$1`, [records[0]!.id]))[0]!.content_hash;
    await sealAll(records);
    const preserved = async () => ({
      pages: await engine.executeRaw(`SELECT id, source_id, slug, source_path, content_hash, compiled_truth,
        frontmatter - 'quarantine' AS frontmatter FROM pages ORDER BY id`),
      chunks: await engine.executeRaw(`SELECT * FROM content_chunks ORDER BY id`),
      aliases: await engine.executeRaw(`SELECT * FROM page_aliases ORDER BY source_id, alias_norm, slug`),
    });
    const before = await preserved();
    const { sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot } = await applyOperatorQuarantine(engine, records, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'metadata-only', manifestSha256: sha256,
    });
    expect(await preserved()).toEqual(before);
    await rollbackOperatorQuarantine(engine, snapshot);
    expect(await preserved()).toEqual(before);
  });

  test('rollback refuses a foreign incident or manifest marker and preserves the marker', async () => {
    const records = await seedFive();
    const { sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot } = await applyOperatorQuarantine(engine, records, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'metadata-only', manifestSha256: sha256,
    });
    const before = await engine.executeRaw(`SELECT * FROM pages ORDER BY id`);
    for (const changed of [{ incident: 'foreign' }, { manifest_sha256: 'f'.repeat(64) }]) {
      await expect(rollbackOperatorQuarantine(engine, { ...snapshot, ...changed })).rejects.toThrow(/operator marker/);
      expect(await engine.executeRaw(`SELECT * FROM pages ORDER BY id`)).toEqual(before);
    }
  });

  test('unknown persistence mode refuses apply and rollback without any page mutation', async () => {
    const records = await seedFive();
    const { sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot } = await applyOperatorQuarantine(engine, records, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'metadata-only', manifestSha256: sha256,
    });
    await engine.executeRaw(`DELETE FROM persistence_brain`);
    const before = await engine.executeRaw(`SELECT * FROM pages ORDER BY id`);
    await expect(applyOperatorQuarantine(engine, records, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'metadata-only', manifestSha256: sha256,
    })).rejects.toThrow();
    await expect(rollbackOperatorQuarantine(engine, snapshot)).rejects.toThrow();
    expect(await engine.executeRaw(`SELECT * FROM pages ORDER BY id`)).toEqual(before);
    // Restore the fixture control row for the next test, not a production repair.
    await engine.executeRaw(`INSERT INTO persistence_brain(singleton, enabled) VALUES (1, false)`);
  });

  test('apply refuses a row that drifts between plan and apply, atomically (no marker written)', async () => {
    const records = await seedFive();
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const plan = await planOperatorQuarantine(engine, parsed, { sourceId: 'default', incident: 'fixture', manifestSha256: sha256 });
    expect(plan.eligible.length).toBe(5);
    // Simulate a concurrent writer changing an eligible row after the plan read.
    await engine.executeRaw(`UPDATE pages SET content_hash = repeat('b', 64) WHERE id=$1`, [records[2]!.id]);
    await expect(applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256,
    })).rejects.toThrow(OperatorQuarantineError);
    for (const r of records) {
      expect(isQuarantined((await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [r.id]))[0]!.frontmatter)).toBe(false);
    }
  });

  test('refuses apply and rollback when persistence_brain.enabled=true (raw metadata UPDATE)', async () => {
    const records = await seedFive();
    await engine.executeRaw(`UPDATE persistence_brain SET enabled=true WHERE singleton=1`);
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    await expect(applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'fixture', manifestSha256: sha256,
    })).rejects.toThrow(/persistence_brain\.enabled/);
    for (const r of records) {
      expect(isQuarantined((await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [r.id]))[0]!.frontmatter)).toBe(false);
    }
    const snap: OperatorQuarantineSnapshot = {
      schema_version: 1, reason: 'wrong-root-sync', incident: 'fixture', source_id: 'default',
      manifest_sha256: sha256, created_at: new Date().toISOString(),
      rows: records.map((r) => ({ ...r, generation: 0, updated_at: '', marker: buildOperatorQuarantineMarker('wrong-root-sync', { incident: 'fixture', manifestSha256: sha256 }) })),
    };
    await expect(rollbackOperatorQuarantine(engine, snap)).rejects.toThrow(/persistence_brain\.enabled/);
    await engine.executeRaw(`UPDATE persistence_brain SET enabled=false WHERE singleton=1`);
  });
});

describe('operator quarantine-set — manifest scale + artifact safety', () => {
  function synth(n: number): { text: string; records: OperatorManifestRecord[] } {
    const records: OperatorManifestRecord[] = [];
    for (let i = 1; i <= n; i++) {
      records.push({ id: i, slug: `s/${i}`, source_id: 'default', content_hash: 'a'.repeat(64), source_path: `p/${i}.md` });
    }
    return { text: records.map((r) => JSON.stringify(r)).join('\n') + '\n', records };
  }

  test('accepts the exact 6915-row incident manifest and rejects beyond the hard cap', () => {
    const { text } = synth(6915);
    const { records, sha256 } = parseOperatorManifest(text);
    expect(records.length).toBe(6915);
    expect(records[6914]!.id).toBe(6915);
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => parseOperatorManifest(synth(QUARANTINE_SET_HARD_CAP + 1).text)).toThrow(/hard cap/);
  });

  test('CLI archives the manifest with its sha and writes the snapshot 0600', async () => {
    const records = await seedFive();
    const manifestFile = join(root, 'archive-manifest.jsonl');
    const manifestRaw = manifestText(records);
    writeFileSync(manifestFile, manifestRaw);
    const snapFile = join(root, 'archive-snapshot.json');
    const { runQuarantine } = await import('../src/commands/quarantine.ts');
    await runQuarantine(engine, ['set', '--manifest', manifestFile, '--reason', 'wrong-root-sync', '--snapshot-out', snapFile, '--yes', '--json']);

    const mode = statSync(snapFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const snap = JSON.parse(readFileSync(snapFile, 'utf8')) as OperatorQuarantineSnapshot & { manifest_path?: string };
    expect(typeof snap.manifest_path).toBe('string');
    const archived = readFileSync(snap.manifest_path!, 'utf8');
    expect(archived).toBe(manifestRaw);
    expect(createHash('sha256').update(archived, 'utf8').digest('hex')).toBe(snap.manifest_sha256);
    expect(statSync(snap.manifest_path!).mode & 0o777).toBe(0o600);

    // Rollback verifies the archived manifest sha before clearing.
    await runQuarantine(engine, ['rollback', '--snapshot', snapFile, '--yes', '--json']);
    expect(isQuarantined((await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [records[0]!.id]))[0]!.frontmatter)).toBe(false);
  });
});
