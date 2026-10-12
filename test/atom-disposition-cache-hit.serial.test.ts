/**
 * Cache-hit atom DISPOSITION re-enrichment (serial; process-global mocks).
 *
 * The semantic result cache is hard-disabled in production
 * (`semanticResultCacheAvailable() === false`), so the cache-HIT branch of
 * `hybridSearchCached` cannot be reached through the real cache. This test
 * forces the hit branch with a mocked cache module and pins the contract: a
 * hit returns rows STORED EARLIER, so any `atom_disposition` they carry is
 * stale — the hit path MUST re-enrich against CURRENT data before returning.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import * as realCache from '../src/core/search/query-cache.ts';

/** Deterministic 1536d unit vector — identical every call. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// The stale disposition a previously-stored cache row carries.
const STALE_DISPOSITION = {
  status: 'STALE_FROM_CACHE',
  explanation: 'stored at write time',
  assessed_at: '2000-01-01T00:00:00.000Z',
  assessment_slug: 'operations/atom-evidence-repair-20261011/assessments-9999',
  source_id: 'default',
  historical: true,
  certified: false,
  warning: { code: 'historical_not_certified', message: 'stale' },
};

// A cache row as it would have been stored at write time.
let cachedRows: unknown[] = [];

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

// Force the HIT branch: availability on, and a cache that always returns the
// pre-stored rows (spread keeps every other real export live).
mock.module('../src/core/search/query-cache.ts', () => ({
  ...realCache,
  semanticResultCacheAvailable: () => true,
  SemanticQueryCache: class {
    constructor() {}
    isEnabled() { return true; }
    async lookup() {
      return {
        hit: true,
        results: cachedRows,
        meta: { vector_enabled: true, detail_resolved: null, expansion_applied: false, degraded: [] },
        similarity: 0.99,
        ageSeconds: 5,
      };
    }
    async store() { /* no-op */ }
    async stats() { return {}; }
  },
}));

const { hybridSearchCached } = await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { computeAtomBodySha256, ATOM_ASSESSMENT_SLUG_PREFIX } = await import('../src/core/search/atom-disposition.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

let atomId = 0;
const ATOM_SLUG = 'atoms/2026-01-01/cache-000000';

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-atom-disposition-cache-'));
  process.env.GBRAIN_HOME = tmpHome;

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Live source page + atom + a valid companion assessment.
  await engine.putPage('guides/alpha', { type: 'article', title: 'guides/alpha', compiled_truth: 'The alpha system uses a queue.' });
  await engine.putPage(ATOM_SLUG, {
    type: 'atom',
    title: ATOM_SLUG,
    compiled_truth: 'claim body',
    frontmatter: { type: 'atom', source_slug: 'guides/alpha', source_hash: 'deadbeefdeadbeef' },
  });
  const [atomRow] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1`, [ATOM_SLUG]);
  atomId = Number(atomRow.id);
  await engine.putPage(`${ATOM_ASSESSMENT_SLUG_PREFIX}0001`, {
    type: 'note',
    title: 'assessments',
    compiled_truth: 'companion',
    frontmatter: {
      atom_assessments: [{
        atom_id: atomId,
        atom_slug: ATOM_SLUG,
        source_id: 'default',
        frozen_source_hash: 'deadbeefdeadbeef',
        frozen_source_slug: 'guides/alpha',
        body_sha256: computeAtomBodySha256('claim body'),
        status: 'repaired',
        explanation: 'evidence recovered',
        evidence_slug: 'guides/alpha',
        assessed_at: '2026-10-11T00:00:00.000Z',
      }],
    },
  });

  cachedRows = [
    {
      slug: ATOM_SLUG, page_id: atomId, title: ATOM_SLUG, type: 'atom',
      chunk_text: 'claim body', chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0,
      score: 0.9, stale: false, source_id: 'default',
      atom_disposition: STALE_DISPOSITION,
    },
    {
      slug: 'guides/alpha', page_id: 999_999, title: 'guides/alpha', type: 'article',
      chunk_text: 'body', chunk_source: 'compiled_truth', chunk_id: 2, chunk_index: 0,
      score: 0.5, stale: false, source_id: 'default',
    },
  ];
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('cache-hit atom_disposition re-enrichment', () => {
  test('a cache hit re-enriches stored atom rows with CURRENT data', async () => {
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const results = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { meta = m; },
    });

    // The hit branch really ran.
    expect(meta?.cache?.status).toBe('hit');

    const atom = results.find((r) => r.page_id === atomId)!;
    expect(atom).toBeDefined();
    // Fresh disposition from the companion, NOT the stale stored one.
    expect(atom.atom_disposition?.status).toBe('repaired');
    expect(atom.atom_disposition?.evidence_slug).toBe('guides/alpha');
    expect(atom.atom_disposition?.warning.code).toBe('historical_not_certified');

    // Non-atom rows never carry a disposition.
    const other = results.find((r) => r.page_id === 999_999)!;
    expect(other.atom_disposition).toBeUndefined();
  });
});
