/**
 * Operator quarantine-set — Postgres cross-engine regression (#jsonb-encoding).
 *
 * PGLite masks the positional `$N::jsonb` + `JSON.stringify(...)` double-encode:
 * its driver parses a text→jsonb cast natively, while postgres.js `.unsafe()`
 * types the bound STRING as jsonb and re-serializes it, so the cast yields a
 * jsonb *string scalar* instead of the intended object/array. On real Postgres
 * the apply path then fails outright:
 *
 *   PostgresError: cannot extract elements from a scalar
 *
 * (jsonb_array_elements($1::jsonb) over the double-encoded guard string). The
 * same class silently corrupts the marker (`$2::jsonb`) and the restored
 * projection-job payload. This is the #2339 footgun; the AST guard cannot see
 * it because `JSON.stringify` runs in a statement ABOVE the executeRaw call.
 *
 * This test is the real backstop: it seeds the 5-record pilot fixture, applies
 * the operator marker, proves keyword+vector exclusion, projection readiness
 * and alias/chunk non-mutation, then rolls back and proves search is restored —
 * all against a REAL Postgres database. DATABASE_URL-gated (engine-parity
 * convention) and refuses any non-test-shaped database name.
 *
 * The database is expected to be a disposable PROBE database created by the
 * harness (`gbrain_quarantine_test_*`), NOT the live brain. `assertSafeE2eDatabaseUrl`
 * enforces the test-shape floor; the harness creates/drops the probe DB.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { probeProjectionReadiness } from '../../src/core/search/projection-readiness.ts';
import { isQuarantined } from '../../src/core/quarantine.ts';
import {
  parseOperatorManifest,
  planOperatorQuarantine,
  applyOperatorQuarantine,
  rollbackOperatorQuarantine,
  type OperatorManifestRecord,
} from '../../src/core/operator-quarantine.ts';
import type { ChunkInput } from '../../src/core/types.ts';

const DIM = 1536;
const DB_URL = process.env.DATABASE_URL;
const skip = !DB_URL;
const describeIfDB = skip ? describe.skip : describe;

function basisEmbedding(idx: number): Float32Array {
  const e = new Float32Array(DIM);
  e[idx % DIM] = 1.0;
  return e;
}

const savedKey = process.env.OPENAI_API_KEY;

let engine: PostgresEngine;
let root: string;

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

async function sealAll(records: readonly OperatorManifestRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    await installFixtureChunks(engine, r.slug, [
      { chunk_index: 0, chunk_text: `INC_BODY ${r.slug}`, chunk_source: 'compiled_truth', embedding: basisEmbedding(i) } satisfies ChunkInput,
    ]);
  }
}

async function sealedNow(id: number): Promise<boolean> {
  const row = (await engine.executeRaw<{ s: boolean }>(
    `SELECT (text_projection_revision = knowledge_revision) IS TRUE AS s FROM pages WHERE id=$1`,
    [id],
  ))[0]!;
  return row.s === true;
}

async function kw(query: string): Promise<string[]> {
  return (await engine.searchKeyword(query, { limit: 10, sourceId: 'default' })).map((r) => r.slug);
}

beforeAll(async () => {
  if (skip) return;
  assertSafeE2eDatabaseUrl(DB_URL!);
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIM,
    env: { ...process.env },
  });
  engine = new PostgresEngine();
  await engine.connect({ database_url: DB_URL });
  await engine.initSchema();
  delete process.env.OPENAI_API_KEY;
  root = mkdtempSync(join(tmpdir(), 'op-quarantine-pg-root-'));
  mkdirSync(root, { recursive: true });
  await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [root]);
});

afterAll(async () => {
  if (skip) return;
  if (savedKey) process.env.OPENAI_API_KEY = savedKey;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await engine.disconnect(); } catch { /* ignore */ }
});

describeIfDB('operator quarantine-set — Postgres apply/rollback (jsonb encoding)', () => {
  test('apply writes an object marker, preserves content/chunks/aliases, keeps projection ready', async () => {
    const records = await seedFive();
    await sealAll(records);

    const beforeHashes = (await engine.executeRaw<{ id: number; content_hash: string; generation: number }>(
      `SELECT id, content_hash, generation FROM pages ORDER BY id`,
    ));
    const beforeChunks = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks`))[0]!.n;
    const beforeAliases = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_aliases`))[0]!.n;
    const beforeClock = (await engine.executeRaw<{ last_value: string }>(`SELECT last_value FROM page_generation_clock_seq`))[0]!.last_value;
    const beforeJobs = (await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_projection_jobs`))[0]!.n;
    for (const r of records) expect(await sealedNow(r.id)).toBe(true);

    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const { applied, snapshot } = await applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'pg-fixture', manifestSha256: sha256,
    });
    expect(applied).toBe(5);
    expect(snapshot.rows.length).toBe(5);

    // The marker must land as a jsonb OBJECT (not a double-encoded string scalar).
    const kinds = await engine.executeRaw<{ id: number; kind: string | null; reason: string | null; operator: boolean | null; sha: string | null }>(
      `SELECT id,
              jsonb_typeof(frontmatter->'quarantine') AS kind,
              frontmatter->'quarantine'->>'reason' AS reason,
              (frontmatter->'quarantine'->>'operator')::boolean AS operator,
              frontmatter->'quarantine'->>'manifest_sha256' AS sha
         FROM pages WHERE id = ANY($1::int[]) ORDER BY id`,
      [records.map((r) => r.id)],
    );
    expect(kinds.length).toBe(5);
    for (const k of kinds) {
      expect(k.kind).toBe('object');
      expect(k.reason).toBe('wrong-root-sync');
      expect(k.operator).toBe(true);
      expect(k.sha).toBe(sha256);
    }

    const afterHashes = (await engine.executeRaw<{ id: number; content_hash: string; generation: number }>(
      `SELECT id, content_hash, generation FROM pages ORDER BY id`,
    ));
    for (let i = 0; i < beforeHashes.length; i++) {
      expect(afterHashes[i]!.content_hash).toBe(beforeHashes[i]!.content_hash);
      expect(Number(afterHashes[i]!.generation)).toBeGreaterThan(Number(beforeHashes[i]!.generation));
    }
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks`))[0]!.n).toBe(beforeChunks);
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_aliases`))[0]!.n).toBe(beforeAliases);
    expect(Number((await engine.executeRaw<{ last_value: string }>(`SELECT last_value FROM page_generation_clock_seq`))[0]!.last_value))
      .toBeGreaterThan(Number(beforeClock));
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_projection_jobs`))[0]!.n).toBe(beforeJobs);

    // Apply keeps every target projection-ready (no permanent projection_pending).
    for (const r of records) expect(await sealedNow(r.id)).toBe(true);
    expect((await probeProjectionReadiness(engine, { sourceId: 'default' })).status).toBe('ready');

    // Search exclusion: marker hides the target from keyword AND vector search,
    // while a clean control page stays visible.
    await engine.putPage('readwise/clean-control', { type: 'note', title: 'clean control', compiled_truth: 'CONTROL BODY' });
    await installFixtureChunks(engine, 'readwise/clean-control', [
      { chunk_index: 0, chunk_text: 'CONTROL BODY', chunk_source: 'compiled_truth', embedding: basisEmbedding(0) } satisfies ChunkInput,
    ]);
    expect(await kw('INC_BODY')).not.toContain('readwise/incident-one');
    expect(await kw('CONTROL BODY')).toContain('readwise/clean-control');
    expect((await engine.searchVector(basisEmbedding(0), { limit: 10, detail: 'high' })).map((r) => r.slug))
      .not.toContain('readwise/incident-one');

    // Rollback restores search + readiness; marker gone; content/aliases intact.
    const { rolledBack } = await rollbackOperatorQuarantine(engine, snapshot);
    expect(rolledBack).toBe(5);
    for (const r of records) {
      const fm = (await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [r.id]))[0]!.frontmatter;
      expect(isQuarantined(fm)).toBe(false);
      expect(await sealedNow(r.id)).toBe(true);
    }
    expect(await kw('INC_BODY')).toContain('readwise/incident-one');
    expect((await probeProjectionReadiness(engine, { sourceId: 'default' })).status).toBe('ready');
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_aliases`))[0]!.n).toBe(beforeAliases);
  });

  test('restores projection-job state for a page that was pending before apply', async () => {
    const records = await seedFive();
    const target = records[0]!;
    // Force the target UNSEALED (independent of any earlier test) so the apply
    // path cannot re-seal it, then give it an original pending job.
    await engine.executeRaw(`UPDATE pages SET text_projection_revision = NULL WHERE id=$1`, [target.id]);
    await engine.executeRaw(
      `INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
         SELECT s.incarnation, p.slug, p.knowledge_revision, 'canonical_change'
           FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.id=$1
       ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason`,
      [target.id],
    );
    expect(await sealedNow(target.id)).toBe(false);
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const { snapshot } = await applyOperatorQuarantine(engine, parsed, {
      sourceId: 'default', reason: 'wrong-root-sync', incident: 'pg-fixture', manifestSha256: sha256,
    });
    // Unsealed-before target stays pending (its restored job survives).
    expect(await sealedNow(target.id)).toBe(false);
    const jobs = (await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM page_projection_jobs j JOIN pages p ON p.slug=j.slug AND p.source_id='default' WHERE p.id=$1`,
      [target.id],
    ))[0]!.n;
    expect(jobs).toBe(1);
    await rollbackOperatorQuarantine(engine, snapshot);
    expect(await sealedNow(target.id)).toBe(false);
  });

  test('plan dry-run reports exactly 5 eligible DB-only rows without mutating', async () => {
    const records = await seedFive();
    const { records: parsed, sha256 } = parseOperatorManifest(manifestText(records));
    const plan = await planOperatorQuarantine(engine, parsed, { sourceId: 'default', incident: 'pg-fixture', manifestSha256: sha256 });
    expect(plan.eligible.length).toBe(5);
    expect(plan.rejections.length).toBe(0);
    for (const r of records) {
      const fm = (await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(`SELECT frontmatter FROM pages WHERE id=$1`, [r.id]))[0]!.frontmatter;
      expect(isQuarantined(fm)).toBe(false);
    }
  });
});
