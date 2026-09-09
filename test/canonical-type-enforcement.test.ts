/**
 * Stage-2 canonical-type enforcement (approved policy) — the gap where remote +
 * local `put_page` wrote arbitrary frontmatter `type:` verbatim.
 *
 * Contract pinned here:
 *   1. With `enforceCanonicalType: true` (the put_page new-write path, remote
 *      AND local), a declared pack ALIAS is NORMALIZED to its canonical type
 *      before persistence: startup / yc-company → company, draft → writing.
 *   2. A canonical type (conversation) passes through unchanged.
 *   3. A fully UNRELATED type (neither canonical nor a known alias) is REJECTED
 *      with status:'error' and NOTHING is persisted.
 *   4. Legacy safety: the SAME content with enforcement OFF (sync/legacy path)
 *      still stores the alias string literally — enforcement never leaks into
 *      sync or existing-page processing.
 *
 * Runs against in-memory PGLite (hermetic, no DATABASE_URL). We drive
 * importFromContent directly with a synthetic activePack (the exact thin shape
 * put_page threads) so the assertions are deterministic and do not depend on
 * which pack the host config resolves to.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, type ImportResult } from '../src/core/import-file.ts';

const TEST_PACK = {
  page_types: [
    { name: 'company', path_prefixes: ['companies/'], aliases: ['yc-company', 'startup', 'product', 'org'] },
    { name: 'writing', path_prefixes: ['writing/'], aliases: ['draft', 'post-draft'] },
    { name: 'conversation', path_prefixes: ['conversations/'], aliases: [] },
  ],
};

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages', []);
});

async function readStoredType(slug: string): Promise<string | null> {
  const rows = await engine.executeRaw(
    'SELECT type FROM pages WHERE slug = $1',
    [slug],
  ) as Array<{ type: unknown }>;
  return (rows[0]?.type as string | null) ?? null;
}

function pageContent(type: string): string {
  return `---\ntype: ${type}\ntitle: Test Page\n---\n\nbody of the page\n`;
}

async function enforceWrite(type: string, slug: string): Promise<ImportResult> {
  return importFromContent(engine, slug, pageContent(type), {
    noEmbed: true,
    activePack: TEST_PACK,
    enforceCanonicalType: true,
  });
}

describe('canonical-type enforcement (enforceCanonicalType = true — put_page path)', () => {
  test('declared alias `yc-company` is normalized to canonical `company`', async () => {
    const res = await enforceWrite('yc-company', 'companies/acme-enforced');
    expect(res.status).toBe('imported');
    expect(await readStoredType('companies/acme-enforced')).toBe('company');
  });

  test('declared alias `startup` is normalized to canonical `company`', async () => {
    const res = await enforceWrite('startup', 'companies/startco-enforced');
    expect(res.status).toBe('imported');
    expect(await readStoredType('companies/startco-enforced')).toBe('company');
  });

  test('declared alias `draft` is normalized to canonical `writing`', async () => {
    const res = await enforceWrite('draft', 'writing/draft-enforced');
    expect(res.status).toBe('imported');
    expect(await readStoredType('writing/draft-enforced')).toBe('writing');
  });

  test('a canonical type (`conversation`) passes through unchanged', async () => {
    const res = await enforceWrite('conversation', 'conversations/chat-enforced');
    expect(res.status).toBe('imported');
    expect(await readStoredType('conversations/chat-enforced')).toBe('conversation');
  });

  test('a rogue type is rejected with status:error and NOT persisted', async () => {
    const res = await enforceWrite('definitely-not-a-type', 'companies/rogue-enforced');
    expect(res.status).toBe('error');
    expect(res.error).toContain("'definitely-not-a-type'");
    expect(res.error).toContain('company (yc-company, startup, product, org)');
    // Nothing on disk: the write was rejected before persistence.
    expect(await readStoredType('companies/rogue-enforced')).toBeNull();
  });
});

describe('legacy safety (enforcement OFF — sync / legacy path)', () => {
  test('an alias is stored verbatim when enforceCanonicalType is unset', async () => {
    const res = await importFromContent(engine, 'companies/legacy-verbatim', pageContent('yc-company'), {
      noEmbed: true,
      activePack: TEST_PACK,
      // enforceCanonicalType intentionally NOT set — the sync/legacy surface.
    });
    expect(res.status).toBe('imported');
    expect(await readStoredType('companies/legacy-verbatim')).toBe('yc-company');
  });
});