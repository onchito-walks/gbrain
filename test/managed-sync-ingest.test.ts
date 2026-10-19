import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { INCOMPLETE_SYNC_RECEIPT_SQL } from '../src/core/persistence/checkpoint-validation.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-ingest-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) await fn(engine); });
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); return git(root, 'rev-parse', 'HEAD'); };
const content = (name: string, body: string) => `---\ntitle: ${name}\n---\n${body}\n`;
async function fixture(engine: BrainEngine, names = ['a', 'b']) {
  const id = `ingest-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of names) writeFileSync(join(root, `${name}.md`), content(name, `Observation ${name} for receipt testing.`));
  const target = commit(root);
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, target, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [] } };
}
const logs = (engine: BrainEngine, id: string) => engine.getIngestLog({ sourceIds: [id] });

/** Inject at the real checkpoint transaction, never synthesize an ingest row. */
function intercept(engine: BrainEngine, match: (sql: string) => boolean, failure: () => void): () => void {
  const transaction = engine.transaction;
  engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, tx => run(new Proxy(tx, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (match(sql)) failure();
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine)) as Promise<T>;
  } as BrainEngine['transaction'];
  return () => { engine.transaction = transaction; };
}

test('managed import logs exact source, published slugs and processed commit interval; retry does not inflate receipts or counters', async () => each(async engine => {
  const f = await fixture(engine);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', added: 2 });
  const first = await logs(engine, f.id);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ source_id: f.id, source_type: 'git_sync', pages_updated: ['a', 'b'], source_ref: `${f.root} @ (initial)..${f.target}` });
  const counters = await engine.executeRaw('SELECT key,outstanding_count,terminal_bytes FROM persistence_counters ORDER BY key');
  expect(await performManagedSync(engine, { ...f.opts, retryFailed: true })).toMatchObject({ status: 'up_to_date', added: 0, modified: 0 });
  expect(await logs(engine, f.id)).toEqual(first);
  expect(await engine.executeRaw('SELECT key,outstanding_count,terminal_bytes FROM persistence_counters ORDER BY key')).toEqual(counters);
  writeFileSync(join(f.root, 'a.md'), content('a', 'Changed observation for interval testing.'));
  const target = commit(f.root);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'synced', modified: 1 });
  const next = await logs(engine, f.id);
  expect(next).toHaveLength(2);
  expect(next[0]).toMatchObject({ source_ref: `${f.root} @ ${f.target}..${target}`, pages_updated: ['a'] });
}), 120_000);

test('no-op full import and metadata-only commit never fabricate nonempty receipts', async () => each(async engine => {
  const f = await fixture(engine);
  await performManagedSync(engine, f.opts);
  const before = await logs(engine, f.id);
  await performManagedSync(engine, { ...f.opts, full: true });
  expect(await logs(engine, f.id)).toEqual(before);
  writeFileSync(join(f.root, 'README.txt'), 'Not an imported page.'); commit(f.root);
  await performManagedSync(engine, f.opts);
  expect(await logs(engine, f.id)).toEqual(before);
}), 120_000);

test('failed checkpoint after committed pages writes no success receipt; retry does not credit already-published no-ops', async () => each(async engine => {
  const f = await fixture(engine);
  const restore = intercept(engine, sql => sql === INCOMPLETE_SYNC_RECEIPT_SQL, () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); });
  try { expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'blocked_by_failures' }); }
  finally { restore(); }
  expect(await engine.getPage('a', { sourceId: f.id })).not.toBeNull();
  expect(await logs(engine, f.id)).toEqual([]);
  expect(await performManagedSync(engine, { ...f.opts, retryFailed: true })).toMatchObject({ status: 'first_sync' });
  // Retry rediscovers the already-published bytes: it must not attribute those no-ops as new writes.
  expect(await logs(engine, f.id)).toEqual([]);
}), 120_000);

test('source isolation includes overlapping slugs and bulk committed cursor accounting', async () => each(async engine => {
  const a = await fixture(engine, ['shared', 'only-a']);
  const b = await fixture(engine, ['shared', 'only-b']);
  const bulk = { enabled: true, reason: null, size: 8, maxTxnMs: 1000 };
  await performManagedSync(engine, { ...a.opts, bulk });
  await performManagedSync(engine, { ...b.opts, bulk });
  const al = await logs(engine, a.id), bl = await logs(engine, b.id);
  expect(al).toHaveLength(1); expect(bl).toHaveLength(1);
  expect(al[0]).toMatchObject({ source_id: a.id, pages_updated: ['only-a', 'shared'], source_ref: `${a.root} @ (initial)..${a.target}` });
  expect(bl[0]).toMatchObject({ source_id: b.id, pages_updated: ['only-b', 'shared'], source_ref: `${b.root} @ (initial)..${b.target}` });
}), 120_000);

test('slice resume retains exact committed slugs without logging partial success', async () => each(async engine => {
  const f = await fixture(engine);
  expect(await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 60_000 })).toMatchObject({ status: 'partial', added: 1 });
  expect(await logs(engine, f.id)).toEqual([]);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', added: 2 });
  expect((await logs(engine, f.id))[0].pages_updated).toEqual(['a', 'b']);
}), 120_000);

test('failure after receipt insertion rolls back receipt and checkpoint; resume emits exactly one', async () => each(async engine => {
  const f = await fixture(engine);
  const transaction = engine.transaction;
  let inserted = 0;
  engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, tx => run(new Proxy(tx, { get(target, property) {
      if (property === 'logIngest') return async (entry: Parameters<BrainEngine['logIngest']>[0]) => {
        await target.logIngest(entry); inserted++;
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine)) as Promise<T>;
  } as BrainEngine['transaction'];
  try { await performManagedSync(engine, f.opts); }
  finally { engine.transaction = transaction; }
  expect(inserted).toBeGreaterThan(0);
  expect(await logs(engine, f.id)).toEqual([]);
  await performManagedSync(engine, f.opts);
  expect(await logs(engine, f.id)).toHaveLength(1);
}), 120_000);

test('a run whose committed receipts no longer prove the exact set finishes without an approximate receipt', async () => each(async engine => {
  const f = await fixture(engine);
  await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 60_000 });
  await disposePersistenceConsumer(engine);
  // Compact the first page's real receipt (the retention service does this after the
  // window): its intent is gone, so the run's changed set can no longer be proven.
  await engine.executeRaw("UPDATE persistence_requests SET intent=NULL,compacted=true WHERE source_id=$1 AND state='committed' AND slug='a'", [f.id]);
  expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'first_sync', added: 2 });
  expect(await engine.getPage('b', { sourceId: f.id })).not.toBeNull();
  expect(await logs(engine, f.id)).toEqual([]);
}), 120_000);

test('rename and deletion receipts report only the changed target slugs', async () => each(async engine => {
  const f = await fixture(engine);
  await performManagedSync(engine, f.opts);
  git(f.root, 'mv', 'a.md', 'renamed.md'); git(f.root, 'rm', 'b.md');
  const target = commit(f.root);
  const synced = await performManagedSync(engine, f.opts);
  expect(synced.status).toBe('synced');
  const entries = await logs(engine, f.id);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ pages_updated: ['b', 'renamed'], source_ref: `${f.root} @ ${f.target}..${target}` });
}), 120_000);
