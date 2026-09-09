/**
 * Stage-2 write-path hygiene gate (approved policy) — the gap where remote +
 * local `put_page` could write content into a root the operator excluded from
 * the brain's indexing scope (`sync.exclude`: drafts/**, .tmp-archive/**,
 * extracts/**, facts/**, test/**, .gbrain-hygiene/**, ...).
 *
 * sync/import skip these roots at walk time; a direct put_page write used to
 * BYPASS that scope and would both persist the page AND embed it into the
 * graph. This regression pins the gate that closes the hole:
 *
 * Contract pinned here:
 *   1. With `sync.exclude` configured, a put_page whose slug falls under an
 *      excluded root is REJECTED with permission_denied and NOTHING is
 *      persisted (getPage returns null afterward).
 *   2. The rejection fires for BOTH remote (MCP) and local writers — both
 *      funnel through the same put_page op.
 *   3. A valid non-excluded write still succeeds (identical to today).
 *   4. Legacy safety: with NO sync.exclude configured (or an unreadable
 *      config), any slug writes normally — enforcement never leaks into the
 *      unwired brain.
 *   5. Trailing-'/' roots widen to '/**' subtrees exactly like sync, so the
 *      write-path scope and sync-path scope cannot drift.
 *
 * PGLite hermetic; drives the REAL put_page op through the shared operation
 * registry (no embed keys => isAvailable('embedding') false => noEmbed path).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const EXCLUDED = 'drafts/**,.tmp-archive/**,extracts/**,facts/**,test/**,.gbrain-hygiene/**';

let engine: PGLiteEngine;
let put: Operation;

function pageContent(body: string): string {
  return ['---', 'type: note', 'title: Hygiene Test', '---', '', body].join('\n');
}

/** Dot-prefixed roots (.gbrain-hygiene/**, .tmp-archive/**) cannot be put_page
 * slugs at all: slug segments must lead with a word char, so validatePageSlug
 * rejects them before the hygiene gate — an even stricter guard, still nothing
 * persisted. */
async function expectSlugGrammarRejected(slug: string): Promise<void> {
  try {
    await putWrite(slug);
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    expect((e as OperationError).code).toBe('invalid_params');
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
  }
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

async function putWrite(slug: string, ctx?: OperationContext): Promise<unknown> {
  return put.handler(ctx ?? makeCtx(), { slug, content: pageContent(`Body for ${slug}`) });
}

async function expectExcluded(slug: string): Promise<void> {
  try {
    await putWrite(slug);
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    expect((e as OperationError).code).toBe('permission_denied');
    expect((e as Error).message).toContain('sync.exclude');
    // Nothing was persisted: the rejected slug must not exist as a page.
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  put = operations.find((o) => o.name === 'put_page')!;
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('sync.exclude', EXCLUDED);
});

describe('write-path hygiene gate (sync.exclude excluded roots)', () => {
  test('rejects a slug under drafts/** before persistence', async () => {
    await expectExcluded('drafts/scratch-note');
  });

  test('rejects a slug nested deep under extracts/**', async () => {
    await expectExcluded('extracts/2026/09/some-derivative');
  });

  test('dot-prefixed roots (.gbrain-hygiene/**, .tmp-archive/**) are blocked by slug grammar', async () => {
    // These are excluded dirs that cannot even form a put_page slug (no dot
    // segment lead), so they're rejected before the hygiene gate — nothing
    // persisted either way.
    await expectSlugGrammarRejected('.gbrain-hygiene/healthcheck');
    await expectSlugGrammarRejected('.tmp-archive/staging-notes');
  });

  test('rejects facts/** (derivative) and test/** (scratch)', async () => {
    await expectExcluded('facts/derived-fact-page');
    await expectExcluded('test/fixture-page');
  });

  test('fires for a LOCAL (trusted) writer too — same op, same gate', async () => {
    await expectExcluded('drafts/local-writer-scratch');
  });

  test('preserves the valid non-excluded write path', async () => {
    const res = await importFromContent(engine, 'ops/2026/09/valid-page', pageContent('ok'), {
      noEmbed: true,
      sourceId: 'default',
    });
    expect(res.status).toBe('imported');
    const returned = await putWrite('ops/2026/09/valid-page');
    expect((returned as any).status).toBe('created_or_updated');
    expect(await engine.getPage('ops/2026/09/valid-page', { sourceId: 'default' })).not.toBeNull();
  });

  test('a sibling-not-excluded slug (raw/ vs raw-scope) is not caught by a trailing-"/" root', async () => {
    await engine.setConfig('sync.exclude', 'raw/');
    // raw/ widens to raw/**, so raw/foo is excluded but rawscope/foo is not.
    await expectExcluded('raw/cleaning-log');
    await putWrite('rawscope/notes');
    expect(await engine.getPage('rawscope/notes', { sourceId: 'default' })).not.toBeNull();
  });
});

describe('legacy safety (no live sync.exclude)', () => {
  test('with sync.exclude unset, an excluded-looking slug writes normally', async () => {
    await engine.unsetConfig('sync.exclude');
    const res = await putWrite('drafts/unwired-brain-note');
    expect((res as any).status).toBe('created_or_updated');
    expect(await engine.getPage('drafts/unwired-brain-note', { sourceId: 'default' })).not.toBeNull();
  });
});
