// Cross-page embedding batching (request-capped providers, e.g. Voyage free
// tier at ~3 RPM): GBRAIN_EMBED_BATCH_ACROSS_PAGES=1 must coalesce stale chunks
// from DIFFERENT pages into shared embedBatch requests (fewer, larger API
// calls), while preserving per-page metadata carry / signature stamping /
// upsert semantics and the embedding-IS-NULL idempotency contract.
//
// Serial because it mocks the embedding module globally (same isolation class
// as embed.serial.test.ts).
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';

// Global mock state for embedBatch.
let totalEmbedCalls = 0;
let embedSizes: number[] = [];
let embedBatchInputs: (number | undefined)[] = [];
// Inject a transient failure on the Nth produced call (1-indexed) to exercise
// the resume-safe catch branch.
let failCallN: number | null = null;

// Mock the embedding module BEFORE importing runEmbedCore so both the
// embed-retry wrapper and the CLI loop resolve the fake embedBatch.
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[], opts?: { batchInputs?: number }) => {
    totalEmbedCalls++;
    const callIndex = totalEmbedCalls;
    embedSizes.push(texts.length);
    embedBatchInputs.push(opts?.batchInputs);
    if (failCallN !== null && callIndex === failCallN) {
      // Permanent (non-retriable) so embedBatchWithBackoff throws immediately
      // and the cross-page loop's per-request catch has to keep working.
      throw new AIConfigError('simulated permanent provider failure', 'test fixture');
    }
    return texts.map((_, i) => new Float32Array(1024).fill(i + 1));
  },
  currentEmbeddingSignature: () => 'test:voyage:1024',
  // #3374: import-file pulls this too; inert here.
  embedMultimodal: async (inputs: unknown[]) => inputs.map(() => new Float32Array(512)),
}));

const { runEmbedCore } = await import('../src/commands/embed.ts');
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

// Proxy-based mock engine (matches embed.serial.test.ts).
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const track = (method: string) => (...args: any[]) => {
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  return new Proxy({} as any, {
    get(_t, prop: string) {
      if (overrides[prop]) return overrides[prop];
      return track(prop);
    },
  });
}

// 5 pages × 3 stale chunks each (all embedding NULL.)
const N_PAGES = 5;
const CHUNKS_PER_PAGE = 3;
function buildStaleChunks() {
  const chunksBySlug = new Map<string, any[]>();
  const stale: any[] = [];
  for (let p = 0; p < N_PAGES; p++) {
    const slug = `page-${p}`;
    const chunks = Array.from({ length: CHUNKS_PER_PAGE }, (_, c) => ({
      chunk_index: c,
      chunk_text: `text for ${slug} chunk ${c}`,
      chunk_source: 'compiled_truth',
      embedded_at: null,
      token_count: 2,
    }));
    chunksBySlug.set(slug, chunks);
    for (let c = 0; c < CHUNKS_PER_PAGE; c++) {
      stale.push({ slug, chunk_index: c, chunk_text: chunks[c].chunk_text, chunk_source: 'compiled_truth', model: null, token_count: 2, source_id: 'default', page_id: p + 1 });
    }
  }
  return { chunksBySlug, stale };
}

function buildEngine() {
  const { chunksBySlug, stale } = buildStaleChunks();
  const upserts: { slug: string; merged: any[] }[] = [];
  const engine = mockEngine({
    countStaleChunks: async () => stale.length,
    listStaleChunks: async () => stale,
    getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
    upsertChunks: async (slug: string, merged: any[]) => { upserts.push({ slug, merged }); },
  });
  return { engine, upserts };
}

beforeEach(() => {
  totalEmbedCalls = 0;
  embedSizes = [];
  embedBatchInputs = [];
  failCallN = null;
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_BATCH_ACROSS_PAGES;
  delete process.env.GBRAIN_EMBED_CHUNKS_PER_REQUEST;
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
});

describe('GBRAIN_EMBED_BATCH_ACROSS_PAGES — cross-page request batching', () => {
  test('coalesces all stale chunks across pages into ONE request when they fit the cap', async () => {
    process.env.GBRAIN_EMBED_BATCH_ACROSS_PAGES = '1';
    process.env.GBRAIN_EMBED_CHUNKS_PER_REQUEST = '100';
    const { engine, upserts } = buildEngine();

    const res = await runEmbedCore(engine, { stale: true });

    // 15 chunks, 1 request (not 5 page-calls like the default path).
    expect(totalEmbedCalls).toBe(1);
    expect(embedSizes).toEqual([15]);
    expect(embedBatchInputs[0]).toBe(100);
    // Every page was written and every embedded chunk got a vector.
    expect(upserts.length).toBe(N_PAGES);
    for (const u of upserts) {
      expect(u.merged.length).toBe(CHUNKS_PER_PAGE);
      for (const c of u.merged) expect(c.embedding).toBeInstanceOf(Float32Array);
    }
    expect(res.embedded).toBe(15);
  });

  test('splits a cross-page batch into chunksPerRequest-sized requests in input order', async () => {
    process.env.GBRAIN_EMBED_BATCH_ACROSS_PAGES = '1';
    process.env.GBRAIN_EMBED_CHUNKS_PER_REQUEST = '4';
    const { engine, upserts } = buildEngine();

    const res = await runEmbedCore(engine, { stale: true });

    // 15 chunks split into 4,4,4,3 (input order across pages preserved).
    expect(totalEmbedCalls).toBe(4);
    expect(embedSizes).toEqual([4, 4, 4, 3]);
    expect(embedBatchInputs.every(n => n === 4)).toBe(true);
    expect(upserts.length).toBe(N_PAGES);
    for (const u of upserts) {
      for (const c of u.merged) expect(c.embedding).toBeInstanceOf(Float32Array);
    }
    expect(res.embedded).toBe(15);
  });

  test('default (env off) still uses one request PER page', async () => {
    const { engine, upserts } = buildEngine();
    const res = await runEmbedCore(engine, { stale: true });
    expect(totalEmbedCalls).toBe(N_PAGES);
    expect(embedSizes).toEqual(Array(N_PAGES).fill(CHUNKS_PER_PAGE));
    expect(upserts.length).toBe(N_PAGES);
    expect(res.embedded).toBe(15);
  });

  test('a failed request leaves its chunks NULL (stale) for resume, other pages still write', async () => {
    process.env.GBRAIN_EMBED_BATCH_ACROSS_PAGES = '1';
    process.env.GBRAIN_EMBED_CHUNKS_PER_REQUEST = '5';
    // Flat order: p0(0-2),p1(3-5),p2(6-8),p3(9-11),p4(12-14) split into [0-4],[5-9],[10-14].
    // Failing call #2 drops p1#idx5, p2#idx6-8, p3#idx9 (5 chunks).
    failCallN = 2;
    const { engine, upserts } = buildEngine();

    const res = await runEmbedCore(engine, { stale: true });

    expect(totalEmbedCalls).toBe(3);
    expect(embedSizes).toEqual([5, 5, 5]);
    // 15 stale - 5 failed = 10 embedded.
    expect(res.embedded).toBe(10);
    expect(res.failures ?? 0).toBe(5);
    // All 5 pages still written; some chunks stayed NULL (resume-safe).
    expect(upserts.length).toBe(N_PAGES);
    const nullCount = upserts.flatMap(u => u.merged).filter(c => c.embedding === undefined || c.embedding === null).length;
    expect(nullCount).toBe(5);
    const vectorCount = upserts.flatMap(u => u.merged).filter(c => c.embedding instanceof Float32Array).length;
    expect(vectorCount).toBe(10);
  });
});