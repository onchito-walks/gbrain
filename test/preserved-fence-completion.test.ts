/** Real-engine lifecycle controls: complete source digests are never normalized.
 * Both managed journal and unmanaged transaction paths use literal originals.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { COMPLETE_PRESERVED_CYCLE_INTENT, completeSourceCycle, preparePreservedCycleCompletion } from '../src/core/cycle/preserved-fence-completion.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { stableJson, sha256 } from '../src/core/persistence/digest.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { PRESERVED_FENCE_SOURCE, preservedFencePublicationState, publishPreservedFencePublication,
  readPreservedFencePublication } from '../src/core/facts/preserved-fence-store.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUGS = ['people/synthetic-one', 'people/synthetic-two'];
const DONE = '2026-10-17T18:00:00.000Z';
async function seed(engine: BrainEngine, root: string) {
  for (const slug of SLUGS) {
    const page = await engine.putPage(slug, { type: 'person', title: 'Synthetic Example', compiled_truth: '# Synthetic example\n' });
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${slug}.md`, page.id]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
    await engine.executeRaw(`INSERT INTO facts (source_id,entity_slug,fact,kind,visibility,notability,valid_from,source,confidence,row_num)
      VALUES ('default',$1,'Literal synthetic claim  ','fact','world','medium','2026-01-01','mcp:remember',1,NULL),
             ('default',$1,'Numbered synthetic claim','fact','world','medium','2026-01-01','mcp:remember',1,5)`, [slug]);
  }
}
async function originals(engine: BrainEngine, root: string) {
  return { facts: await engine.executeRaw('SELECT * FROM facts ORDER BY id'),
    pages: await engine.executeRaw('SELECT * FROM pages ORDER BY id'),
    files: SLUGS.map(slug => readFileSync(join(root, `${slug}.md`), 'utf8')) };
}
async function publish(engine: BrainEngine) {
  for (const slug of SLUGS) await publishPreservedFencePublication(engine, 'default', slug);
}
async function source(engine: BrainEngine) { return (await engine.executeRaw<Record<string, unknown>>("SELECT * FROM sources WHERE id='default'"))[0]!; }
async function raw(engine: BrainEngine) { return engine.executeRaw('SELECT * FROM raw_data ORDER BY id'); }

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  for (const managed of [false, true]) {
    const label = `${backend}: ${managed ? 'managed' : 'unmanaged'}`;
    async function brain(run: (engine: BrainEngine, root: string) => Promise<void>) {
      if (managed) return managedBrain(({ engine, root }) => run(engine, root), { databaseUrl, setup: ({ engine, root }) => seed(engine, root) });
      const home = mkdtempSync(join(tmpdir(), 'preserved-completion-'));
      try {
        await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
          try {
            const root = join(home, 'content'); mkdirSync(root);
            await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
            await seed(engine, root); await run(engine, root);
          } finally { await close(); }
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
    test(`${label}: completion atomically versions every current document against the complete final source, without original mutation`, async () => {
      await brain(async (engine, root) => {
        await publish(engine);
        const before = await originals(engine, root);
        const previous = await Promise.all(SLUGS.map(slug => readPreservedFencePublication(engine, 'default', slug)));
        const initialSource = await source(engine);
        await completeSourceCycle(engine, 'default', DONE);
        expect(await originals(engine, root)).toEqual(before);
        const finalSource = await source(engine);
        expect(finalSource).toEqual({ ...initialSource, config: { ...(initialSource.config as object), last_source_cycle_at: DONE, last_full_cycle_at: DONE } });
        for (const [index, slug] of SLUGS.entries()) {
          expect((await preservedFencePublicationState(engine, 'default', slug)).state).toBe('current');
          const next = (await readPreservedFencePublication(engine, 'default', slug))!;
          expect(next.original_source_sha256).toBe(sha256(stableJson(finalSource)));
          expect({ ...next, original_source_sha256: previous[index]!.original_source_sha256 }).toEqual(previous[index]!);
          const versions = await engine.executeRaw<{ data: unknown }>('SELECT data FROM raw_data WHERE source=$1 AND page_id=(SELECT id FROM pages WHERE slug=$2)',
            [`${PRESERVED_FENCE_SOURCE}:version:${sha256(stableJson(previous[index]))}`, slug]);
          expect(versions).toEqual([{ data: previous[index] }]);
        }
        const rows = await raw(engine);
        await completeSourceCycle(engine, 'default', DONE);
        // Replaying the exact timestamp is idempotent in content. Only fetched_at
        // is a storage refresh, not authority to change any document or original.
        expect((await raw(engine)).map(({ fetched_at, ...row }) => row)).toEqual(rows.map(({ fetched_at, ...row }) => row));
        expect(await originals(engine, root)).toEqual(before);
      });
    }, 120_000);

    for (const mutation of ['source-config', 'completion-key', 'page', 'fact', 'document']) {
      test(`${label}: completion refuses pre-existing ${mutation} drift, leaving stamps and stored evidence untouched`, async () => {
        await brain(async (engine, root) => {
          await publish(engine);
          if (mutation === 'source-config') await engine.updateSourceConfig('default', { unrelated_external_setting: true });
          if (mutation === 'completion-key') await engine.updateSourceConfig('default', { last_source_cycle_at: 'external-stamp' });
          const mutate = async (tx: BrainEngine) => {
            if (mutation === 'page') await tx.executeRaw("UPDATE pages SET compiled_truth='External page edit' WHERE slug=$1", [SLUGS[0]]);
            if (mutation === 'fact') await tx.executeRaw("UPDATE facts SET source_session='external' WHERE entity_slug=$1", [SLUGS[0]]);
            if (mutation === 'document') await tx.executeRaw("UPDATE raw_data SET data=jsonb_set(data,'{derived_body}','\"fabricated\"'::jsonb) WHERE source=$1", [PRESERVED_FENCE_SOURCE]);
          };
          // Test-only fixture mutation as an independent coordinated writer;
          // production completion must not silently bless any of these edits.
          if (managed) await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => mutate(tx),
            { requestId: null, principal: { kind: 'application', id: 'synthetic-external-editor' } }));
          else await mutate(engine);
          const beforeSource = await source(engine), beforeRaw = await raw(engine), beforeOriginals = await originals(engine, root);
          await expect(completeSourceCycle(engine, 'default', DONE)).rejects.toThrow(/original_or_derived_drift/);
          expect(await source(engine)).toEqual(beforeSource);
          expect(await raw(engine)).toEqual(beforeRaw);
          expect(await originals(engine, root)).toEqual(beforeOriginals);
        });
      }, 120_000);
    }

    for (const mutation of ['source', 'page', 'fact']) {
      test(`${label}: a concurrent ${mutation} edit after planning is not rebound and completion writes nothing`, async () => {
        await brain(async (engine, root) => {
          await publish(engine);
          const beforeRaw = await raw(engine);
          const transaction = engine.transaction.bind(engine);
          let injected = false;
          if (managed) {
            // Prepare from an actual admitted journal shape, then commit an
            // independent writer before validating/applying that prepared plan.
            // Do not intercept PGLite's transaction dispatcher: it holds its
            // engine mutex before nested calls, so interception deadlocks.
            const template = (await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests ORDER BY created_at DESC LIMIT 1"))[0]!;
            const snapshot = (await engine.readPageSnapshot(SLUGS[0]!, { sourceId: 'default' }))!;
            const input = { source: await source(engine), completedAt: DONE, documents: await Promise.all(SLUGS.map(async slug =>
              ({ slug, digest: sha256(stableJson(await readPreservedFencePublication(engine, 'default', slug))) }))) };
            const row: WriteRequest = { ...template, slug: SLUGS[0]!, page_id: snapshot.page.id,
              intent: { kind: COMPLETE_PRESERVED_CYCLE_INTENT, expected_revision: snapshot.revision,
                source_incarnation: template.source_incarnation, completion: input } };
            const prepared = await preparePreservedCycleCompletion(engine, row);
            if (mutation === 'source') await engine.updateSourceConfig('default', { concurrent_edit: true });
            else await transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(mutation === 'page'
              ? "UPDATE pages SET compiled_truth='Concurrent external page' WHERE slug=$1"
              : "UPDATE facts SET source_session='concurrent-external' WHERE entity_slug=$1", [SLUGS[0]]),
              { requestId: null, principal: { kind: 'application', id: 'synthetic-concurrent-editor' } }));
            const independentlyEditedSource = await source(engine);
            await expect(transaction(async tx => { await prepared.validate!(tx); })).rejects.toThrow();
            await expect(transaction(tx => withCoordinatedWrite(tx, ['default'], () => prepared.apply(tx),
              { requestId: template.id, principal: { kind: 'application', id: 'synthetic-completion' } }))).rejects.toThrow();
            expect(await source(engine)).toEqual(independentlyEditedSource);
            expect(await raw(engine)).toEqual(beforeRaw);
            expect((await preservedFencePublicationState(engine, 'default', SLUGS[0]!)).state).toBe('drifted');
            return;
          }
          engine.transaction = async fn => {
            if (!injected) {
              injected = true;
              if (mutation === 'source') await engine.updateSourceConfig('default', { concurrent_edit: true });
              else {
                const mutate = (tx: BrainEngine) => tx.executeRaw(mutation === 'page'
                  ? "UPDATE pages SET compiled_truth='Concurrent external page' WHERE slug=$1"
                  : "UPDATE facts SET source_session='concurrent-external' WHERE entity_slug=$1", [SLUGS[0]]);
                if (managed) await transaction(tx => withCoordinatedWrite(tx, ['default'], () => mutate(tx),
                  { requestId: null, principal: { kind: 'application', id: 'synthetic-concurrent-editor' } }));
                else await mutate(engine);
              }
            }
            return transaction(fn);
          };
          try { await expect(completeSourceCycle(engine, 'default', DONE)).rejects.toThrow(); }
          finally { engine.transaction = transaction; }
          expect(injected).toBe(true);
          expect((await source(engine)).config).not.toHaveProperty('last_source_cycle_at');
          expect(await raw(engine)).toEqual(beforeRaw);
          expect((await preservedFencePublicationState(engine, 'default', SLUGS[0]!)).state).toBe('drifted');
          // The independent edit remains committed; rollback is scoped to completion.
          if (mutation === 'source') expect((await source(engine)).config).toMatchObject({ concurrent_edit: true });
          if (mutation === 'page') expect((await originals(engine, root)).pages.find(row => row.slug === SLUGS[0])!.compiled_truth).toBe('Concurrent external page');
          if (mutation === 'fact') expect((await originals(engine, root)).facts.filter(row => row.entity_slug === SLUGS[0]).every(row => row.source_session === 'concurrent-external')).toBe(true);
        });
      }, 120_000);
    }

    test(`${label}: explicit supersede is propagated only when requested, with current originals retained`, async () => {
      await brain(async (engine, root) => {
        await publish(engine);
        await engine.updateSourceConfig('default', { external_generation: 2 });
        const before = await originals(engine, root), beforeRaw = await raw(engine);
        await expect(publishPreservedFencePublication(engine, 'default', SLUGS[0]!)).rejects.toThrow(/stored_publication_drifted/);
        expect(await raw(engine)).toEqual(beforeRaw);
        const receipt = await publishPreservedFencePublication(engine, 'default', SLUGS[0]!, { allowSupersede: true });
        expect(receipt).toMatchObject({ published: true, supersededStoredPublication: true, path: managed ? 'managed' : 'unmanaged' });
        expect((await preservedFencePublicationState(engine, 'default', SLUGS[0]!)).state).toBe('current');
        expect(await originals(engine, root)).toEqual(before);
        if (managed) {
          const requests = await engine.executeRaw<{ intent: Record<string, unknown> }>('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [receipt.requestId]);
          expect(requests[0]!.intent.supersede).toBe(true);
        }
      });
    }, 120_000);

    test(`${label}: a post-stamp failure rolls source, derived documents and original-row changes back together`, async () => {
      await brain(async (engine, root) => {
        await publish(engine);
        const beforeSource = await source(engine), beforeRaw = await raw(engine), beforeOriginals = await originals(engine, root);
        await engine.executeRaw(`CREATE FUNCTION refuse_completion() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.source = '${PRESERVED_FENCE_SOURCE}' THEN RAISE EXCEPTION 'injected completion storage failure'; END IF; RETURN NEW; END $$`);
        await engine.executeRaw('CREATE TRIGGER refuse_completion BEFORE UPDATE ON raw_data FOR EACH ROW EXECUTE FUNCTION refuse_completion()');
        try {
          await expect(completeSourceCycle(engine, 'default', DONE)).rejects.toThrow();
          const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['orphans'] });
          expect(report.reason).toBe('stamp_write_failed');
          expect(report.status).toBe('partial');
          // Managed receipts deliberately sanitize database messages, retaining
          // SQLSTATE + function attribution instead of raw backend text.
          expect(report.stamp_write_failed?.error).toContain(managed ? 'P0001 in refuse_completion' : 'injected completion storage failure');
        }
        finally {
          await engine.executeRaw('DROP TRIGGER refuse_completion ON raw_data');
          await engine.executeRaw('DROP FUNCTION refuse_completion()');
        }
        expect(await source(engine)).toEqual(beforeSource);
        expect(await raw(engine)).toEqual(beforeRaw);
        expect(await originals(engine, root)).toEqual(beforeOriginals);
      });
    }, 120_000);

    test(`${label}: dry-run and last-phase abort do not advance completion or rebind publications`, async () => {
      await brain(async (engine, root) => {
        await publish(engine);
        const beforeSource = await source(engine), beforeRaw = await raw(engine);
        await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'], dryRun: true });
        expect(await source(engine)).toEqual(beforeSource);
        expect(await raw(engine)).toEqual(beforeRaw);
        const abort = new AbortController();
        const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'],
          signal: abort.signal, yieldBetweenPhases: async () => { abort.abort(); } });
        expect(report.reason).toBe('aborted');
        expect(await source(engine)).toEqual(beforeSource);
        expect(await raw(engine)).toEqual(beforeRaw);
      });
    }, 120_000);
  }
}
