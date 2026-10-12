/**
 * Atom-extraction quarantine hardening (B12) — hermetic reproductions.
 *
 * Two gaps the extraction predicate used to have:
 *
 *  1. SELECTION. `discoverExtractablePages` and `countExtractAtomsBacklog` had
 *     no `quarantine` predicate, so high-confidence junk pages (Cloudflare /
 *     CAPTCHA interstitials, operator literals) were eligible candidates and
 *     were sent to the model. They now carry the same
 *     `quarantineFilterFragment` the search and doctor paths use.
 *
 *  2. EXECUTION BOUNDARY. A page can be quarantined BETWEEN listing and
 *     execution (a concurrent `quarantine scan`, an import disposition, a
 *     capture write). The batched re-check drops those pages, and when it
 *     CANNOT be answered (query error / DB unavailable) the phase FAILS CLOSED:
 *     `blocked: true`, zero model calls, rather than treating "unknown
 *     quarantine status" as "clean".
 *
 * No model calls anywhere: chat via the `_chat` seam, embed via
 * __setEmbedTransportForTests. Pure helper cases first; the PGLite describes
 * exercise the real SQL and the real phase.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runPhaseExtractAtoms,
  discoverExtractablePages,
  countExtractAtomsBacklog,
} from '../src/core/cycle/extract-atoms.ts';
import {
  quarantinedSlugsAmong,
  quarantineRecheckFailedResult,
  dropQuarantinedListedPages,
  QuarantineRecheckError,
} from '../src/core/cycle/extract-atoms-quarantine.ts';
import { buildAtomWorkList } from '../src/core/cycle/extract-atoms-work.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

const PRICED_CHAT = 'anthropic:claude-haiku-4-5-20251001';
/**
 * Keyless-available embed route (a `litellm` proxy needs no API key, so
 * `isAvailable('embedding')` is true with an empty env). It is deliberately NOT
 * in the shipped pricing maps, so the tests that let the run proceed declare a
 * $0 operator override — the same operator escape hatch B11 documents.
 */
const EMBED_MODEL = 'litellm:nvidia/some-local-embedder';
const DIMS = 1536;

describe('quarantinedSlugsAmong / quarantineRecheckFailedResult (pure seams)', () => {
  test('a query failure THROWS — it never returns an empty "none quarantined" set', async () => {
    const broken = {
      executeRaw: async () => { throw new Error('pg: connection reset by peer'); },
    } as never;
    await expect(quarantinedSlugsAmong(broken, 'default', ['meeting/x']))
      .rejects.toBeInstanceOf(QuarantineRecheckError);
    // Nothing to verify ⇒ no query, no throw (only meaningful for a non-empty batch).
    await expect(quarantinedSlugsAmong(broken, 'default', [])).resolves.toEqual(new Set());
  });

  test('the fail-closed result is a blocked refusal that claims no cap and no spend', () => {
    const result = quarantineRecheckFailedResult(new Error('boom'), {
      sourceId: 'default', transcriptsTotal: 2, pagesTotal: 3,
      duplicatesSkipped: 1, budgetUsd: null, dryRun: false,
    });
    expect(result.status).toBe('skipped');
    expect(result.details).toMatchObject({
      reason: 'quarantine_recheck_failed',
      blocked: true,
      blocked_reason: 'quarantine_recheck_failed',
      atoms_extracted: 0,
      transcripts_total: 2,
      pages_total: 3,
      estimated_spend_usd: 0,
      budget_usd: null,
    });
    // A refusal is NOT a cap stop: the two must not be conflated downstream.
    expect(result.details?.budget_exhausted).toBeUndefined();
  });
});

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('models.dream.extract_atoms', PRICED_CHAT);
  // Hermetic gateway: a priced embedding model with a stubbed transport, so the
  // atom import really embeds under the phase's BudgetTracker (no network) and
  // the "zero model calls" assertions below are about the refused run, not
  // about embedding being unavailable.
  configureGateway({ embedding_model: EMBED_MODEL, embedding_dimensions: DIMS, env: {} });
}, 120000);

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(async () => {
  await engine.unsetConfig('pricing.overrides');
  await engine.unsetConfig('cycle.extract_atoms.budget_usd');
  __setEmbedTransportForTests(null);
});

/**
 * Seed an extractable page (type `meeting`, >= 500 chars, content_hash set) with
 * an optional `quarantine` marker. The content_hash the phase sees for a
 * seam-supplied page is the one handed to `_pages`, so it is computed here and
 * written to the row too.
 */
async function seedPage(
  slug: string,
  opts: { quarantine?: boolean; chars?: number } = {},
): Promise<{ content: string; contentHash: string }> {
  const content = 'z'.repeat(opts.chars ?? 600);
  const contentHash = createHash('sha256').update(`${slug}:${content}`).digest('hex');
  const stored = await engine.putPage(slug, {
    type: 'meeting',
    title: slug,
    compiled_truth: content,
    timeline: '',
    frontmatter: opts.quarantine
      ? { quarantine: { reason: 'junk_pattern', detail: 'fixture', assessed_at: '2026-01-01T00:00:00Z' } }
      : {},
  });
  await engine.executeRaw(
    'UPDATE pages SET compiled_truth=$1, content_hash=$2 WHERE source_id=$3 AND id=$4',
    [content, contentHash, 'default', stored.id],
  );
  return { content, contentHash };
}

function okChat(): (o: ChatOpts) => Promise<ChatResult> {
  return async () => ({
    text: '[{"title":"Hardened atom","atom_type":"insight","body":"quarantine never reaches the model."}]',
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: PRICED_CHAT,
    providerId: 'stub',
  });
}

/** Count both transports so every case can assert the model-call budget. */
function countingTransports(): { chat: (o: ChatOpts) => Promise<ChatResult>; chatCalls: () => number; embedCalls: () => number } {
  let chatN = 0;
  let embedN = 0;
  __setEmbedTransportForTests((async (args: { values: string[] }) => {
    embedN++;
    return {
      embeddings: (args.values as string[]).map(() => Array.from({ length: DIMS }, () => 0.01)),
      usage: { tokens: 10 * (args.values as string[]).length },
    };
  }) as never);
  const chat = async (o: ChatOpts) => { chatN++; return okChat()(o); };
  return { chat, chatCalls: () => chatN, embedCalls: () => embedN };
}

describe('quarantined pages are excluded from atom extraction selection', () => {
  test('discoverExtractablePages excludes a quarantined page', async () => {
    await seedPage('meeting/clean');
    await seedPage('meeting/junk', { quarantine: true });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((p) => p.slug).sort()).toEqual(['meeting/clean']);
  }, 60000);

  test('countExtractAtomsBacklog excludes a quarantined page (scoped and brain-wide)', async () => {
    await seedPage('meeting/clean');
    await seedPage('meeting/junk', { quarantine: true });

    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    // Brain-wide (doctor) mode keys the same predicate on the page alias.
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
  }, 60000);

  test('the re-check SQL is source-scoped', async () => {
    await seedPage('meeting/junk', { quarantine: true });
    expect([...(await quarantinedSlugsAmong(engine, 'default', ['meeting/junk']))]).toEqual(['meeting/junk']);
    expect(await quarantinedSlugsAmong(engine, 'some-other-source', ['meeting/junk'])).toEqual(new Set());
    // A non-quarantined slug in the same batch is not reported.
    await seedPage('meeting/clean');
    expect([...(await quarantinedSlugsAmong(engine, 'default', ['meeting/junk', 'meeting/clean']))]).toEqual(['meeting/junk']);
  }, 60000);
});

describe('execution-boundary quarantine re-check', () => {
  test('dropQuarantinedListedPages drops page items only and reports the count', async () => {
    await seedPage('meeting/junk', { quarantine: true });
    const list = buildAtomWorkList(
      [{ filePath: '/fake/meeting.txt', content: 'transcript content', contentHash: 'feedfacefeedface' }],
      [
        { slug: 'meeting/junk', content: 'z'.repeat(600), contentHash: 'a'.repeat(64) },
        { slug: 'meeting/absent', content: 'z'.repeat(600), contentHash: 'b'.repeat(64) },
      ],
    );
    expect(list.work.filter((w) => w.kind === 'page')).toHaveLength(2);

    const outcome = await dropQuarantinedListedPages(engine, 'default', list.work, {
      sourceId: 'default', transcriptsTotal: 1, pagesTotal: 2,
      duplicatesSkipped: 0, budgetUsd: null, dryRun: false,
    });
    expect(outcome).toEqual({ excluded: 1 });
    expect(list.work.filter((w) => w.kind === 'transcript')).toHaveLength(1);
    expect(list.work.filter((w) => w.kind === 'page').map((w) => (w as { slug: string }).slug)).toEqual(['meeting/absent']);
  }, 60000);

  test('a page quarantined BETWEEN list and execution never reaches the model', async () => {
    const t = countingTransports();
    // The page is listed as a candidate (the `_pages` snapshot) but already
    // carries the marker when the phase reaches it — the race this closes.
    const { content, contentHash } = await seedPage('meeting/junk', { quarantine: true });

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: 'meeting/junk', content, contentHash }],
      _chat: t.chat,
    });

    expect(t.chatCalls()).toBe(0);
    expect(t.embedCalls()).toBe(0);
    expect(result.details?.pages_excluded_quarantined).toBe(1);
    expect(result.details?.pages_total).toBe(0);
    expect(result.status).toBe('skipped');
    expect(result.details?.reason).toBe('no_work');
  }, 60000);

  test('control: a listed non-quarantined page still extracts', async () => {
    const t = countingTransports();
    // Operator escape hatch (B11): declare the embed route's rate so the cost
    // gate enforces the cap and the import really embeds (through the stub).
    await engine.setConfig('pricing.overrides', JSON.stringify({ [EMBED_MODEL]: 0 }));
    const { content, contentHash } = await seedPage('meeting/clean');

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [{ slug: 'meeting/clean', content, contentHash }],
      _chat: t.chat,
    });

    expect(t.chatCalls()).toBe(1);
    expect(t.embedCalls()).toBeGreaterThan(0);
    expect(result.details?.pages_excluded_quarantined).toBe(0);
    expect(result.details?.pages_total).toBe(1);
    expect(result.details?.atoms_extracted).toBe(1);
    expect(result.details?.budget_exhausted).toBe(false);
  }, 60000);

  test('a failing re-check query FAILS CLOSED: 0 chat, 0 embed, blocked result', async () => {
    const t = countingTransports();
    const { content, contentHash } = await seedPage('meeting/clean');

    // Make ONLY the execution-boundary re-check query fail; its SQL is
    // distinguishable by `slug = ANY($2::text[])` (discovery uses $5).
    const original = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: unknown }).executeRaw = async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('slug = ANY($2::text[])')) {
        throw new Error('simulated DB error on the quarantine re-check');
      }
      return (original as (s: string, p?: unknown[]) => Promise<unknown>)(sql, params);
    };

    const stderr: string[] = [];
    const saved = console.error;
    console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
    let result;
    try {
      result = await runPhaseExtractAtoms(engine, {
        _transcripts: [{ filePath: '/fake/meeting-fail.txt', content: 'transcript content', contentHash: 'deadbeefdeadbeef' }],
        _pages: [{ slug: 'meeting/clean', content, contentHash }],
        _chat: t.chat,
      });
    } finally {
      (engine as unknown as { executeRaw: unknown }).executeRaw = original;
      console.error = saved;
    }

    expect(result.status).toBe('skipped');
    expect(result.details?.blocked).toBe(true);
    expect(result.details?.blocked_reason).toBe('quarantine_recheck_failed');
    expect(result.details?.reason).toBe('quarantine_recheck_failed');
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.estimated_spend_usd).toBe(0);
    expect(result.details?.budget_usd).toBeNull();
    // THE GUARANTEE: an unanswerable re-check ⇒ ZERO model calls, pages AND
    // transcripts alike (an empty-set fail-open would have extracted from both).
    expect(t.chatCalls()).toBe(0);
    expect(t.embedCalls()).toBe(0);
    expect(stderr.join('\n')).toContain('quarantine re-check failed');
    expect(stderr.join('\n')).toContain('FAIL-CLOSED');
  }, 60000);
});
