/**
 * Entity mention index on a managed-persistence brain (the slot builds'
 * shape: a git-backed source with a claimed worktree). `page_aliases` is
 * guarded by the managed-writer trigger, so derived alias rows must be
 * written through the coordinated writer, both at import and in the stale
 * sweep; sync's inline extraction runs links only.
 *
 * Regression: a derived alias write outside the coordinator (refused by the
 * guard, failing the sweep), or sync writing mention rows.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gbrainPath } from '../src/core/config.ts';
import { loadActivePackForWriteVocabulary } from '../src/core/schema-pack/write-vocabulary.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { runReindexAliases } from '../src/commands/reindex-aliases.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { derivedAliases, mentionLinks } from './helpers/mention-brain.ts';

const put = (ctx: OperationContext, slug: string, type: string, title: string, body: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: ${type}\ntitle: "${title}"\n---\n\n${body}\n` } });

test('managed brain: import writes derived aliases; sync-style extraction writes no mention rows; extract --stale links them', async () => {
  // This suite tests mention ownership, not admission of arbitrary page types.
  await managedBrain(async ({ engine, ctx }) => {
    const root = gbrainPath('schema-packs', 'mention-fixture');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'pack.json'), JSON.stringify({ api_version: 'gbrain-schema-pack-v1',
      name: 'mention-fixture', version: '1.0.0', extends: 'gbrain-base-v2',
      page_types: [{ name: 'ticket', primitive: 'temporal', path_prefixes: ['tickets/'] }],
      link_types: [], frontmatter_links: [] }));

    await engine.setConfig('schema_pack', 'mention-fixture');
    const pack = await loadActivePackForWriteVocabulary(ctx);
    expect(pack?.manifest.page_types.find(type => type.name === 'account')?.primitive).toBe('entity');
    expect(pack?.manifest.page_types.some(type => type.name === 'ticket')).toBe(true);
    await put(ctx, 'crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO');
    expect((await engine.getPage('crm/123', { sourceId: 'default' }))?.type).toBe('account');
    await put(ctx, 'tickets/t1', 'ticket', 'Ticket 1', 'Customer: QUCO\nStatus: Open');
    await disposePersistenceConsumer(engine);
    expect(await derivedAliases(engine, 'crm/123')).toEqual(['declared:quco (cs)', 'subject:quormiro capital']);
    await extractManagedStaleLinks(engine, { sourceId: 'default', mentions: false });
    expect(await mentionLinks(engine)).toEqual([]);
    const r = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
    expect(r.mentions).toMatchObject({ state: 'complete', remaining: 0 });
    expect(await mentionLinks(engine)).toEqual(['tickets/t1 -> crm/123']);
    // Derived rows refresh through the coordinated writer in the sweep and in reindex --aliases.
    await engine.executeRaw("UPDATE page_mention_state SET alias_revision = NULL");
    await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
    await runReindexAliases(engine, ['--json']);
    expect(await derivedAliases(engine, 'crm/123')).toEqual(['declared:quco (cs)', 'subject:quormiro capital']);
  });
}, 180_000);
