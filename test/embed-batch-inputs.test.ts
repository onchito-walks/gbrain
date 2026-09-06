// embedBatch per-request input cap (batchInputs): for request-capped providers
// (Voyage free tier ~3 RPM), raising the inputs-per-request above the default
// 100 must issue FEWER, LARGER gateway calls — this is the provider-layer half
// of the cross-page batching (embed-stale) that coalesces chunks across pages.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { embedBatch } from '../src/core/embedding.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';

// Records the number of input texts the transport saw per request.
let requestInputCounts: number[] = [];

function fakeTransport(payload: any) {
  const values: string[] = payload.values;
  requestInputCounts.push(values.length);
  // First slot encodes input index; converted to Float32Array by gateway.
  return {
    embeddings: values.map((_, i) =>
      Array.from({ length: 1024 }, (_, j) => (j === 0 ? i : 0.1)),
    ),
  };
}

function configureVoyage(): void {
  configureGateway({
    embedding_model: 'voyage:voyage-4',
    embedding_dimensions: 1024,
    env: { VOYAGE_API_KEY: 'sk-fake' },
  });
}

const texts201 = Array.from({ length: 201 }, (_, i) => `doc text ${i}`);

beforeEach(() => {
  requestInputCounts = [];
  configureVoyage();
  __setEmbedTransportForTests(fakeTransport as any);
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('embedBatch batchInputs (inputs per request)', () => {
  test('default 100 slices 201 texts into 100/100/1 requests', async () => {
    const out = await embedBatch(texts201);
    expect(requestInputCounts).toEqual([100, 100, 1]);
    expect(out.length).toBe(201);
  });

  test('batchInputs=200 sends 201 texts as 200/1 (two requests, not three)', async () => {
    const out = await embedBatch(texts201, { batchInputs: 200 });
    expect(requestInputCounts).toEqual([200, 1]);
    expect(out.length).toBe(201);
  });

  test('batchInputs=1000 sends all 201 in ONE request (fast path)', async () => {
    const out = await embedBatch(texts201, { batchInputs: 1000 });
    expect(requestInputCounts).toEqual([201]);
    expect(out.length).toBe(201);
  });

  test('batchInputs smaller than default also respected (fast-path bypass)', async () => {
    const out = await embedBatch(['a', 'b', 'c'], { batchInputs: 2 });
    expect(requestInputCounts).toEqual([2, 1]);
    expect(out.length).toBe(3);
  });
});