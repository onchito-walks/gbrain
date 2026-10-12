/**
 * B02: put_page must never persist into a root the operator excluded from the
 * brain's indexing scope with `sync.exclude`. The sync and import walkers skip
 * those roots, so a direct write used to bypass the scope: the page landed, was
 * embedded, and left a file no later sync would ever read again.
 *
 * These are ACTUAL put_page operation tests (the op handler, not a helper):
 * every case drives the same entrypoint remote MCP and the local CLI use, and
 * the refusal cases compare the whole disk + 13-table database state before and
 * after, so a refusal that still journaled, embedded or wrote would fail here.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pagesOperations } from '../src/core/ops/pages.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { assertPutPageNotSyncExcluded } from '../src/core/persistence/put-page-exclude.ts';
import { withEnv } from './helpers/with-env.ts';
import { spawnSync } from '../src/core/spawn.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-put-exclude-'));
const root = join(home, 'vault');
const sourceId = 'exclude-test';
const put = pagesOperations.find(op => op.name === 'put_page')!;
const content = (slug: string) => `---\ntype: note\ntitle: Synthetic ${slug}\n---\nA synthetic fixture body for the indexing-scope guard of ${slug}.\n`;
let engine: PGLiteEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined };
const warns: string[] = [];
const ctx = (remote = false, dryRun = false): OperationContext => ({ engine, sourceId, remote, dryRun,
  config: { engine: 'pglite', embedding_disabled: true },
  logger: { info() {}, warn: (message: string) => { warns.push(message); }, error() {} } });
const write = (slug: string, options: Record<string, unknown> = {}, context = ctx()) =>
  withEnv(env, () => put.handler(context, { request_id: randomUUID(), slug, content: content(slug), ...options })) as Promise<Record<string, any>>;
const refusal = (slug: string, options: Record<string, unknown> = {}, context = ctx()) =>
  write(slug, options, context).then(() => null, (error: any) => error);
const setExclude = (patterns: string) => engine.setConfig('sync.exclude', patterns);

beforeAll(async () => withEnv(env, async () => {
  mkdirSync(root);
  // Bound discovery to this disposable checkout, never the ancestor Hermes repo.
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
}), 120_000);

afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

function files(path = home): Array<{ path: string; bytes: string; modified: number }> {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [{ path: relative(home, child), bytes: readFileSync(child).toString('base64'), modified: statSync(child).mtimeMs }];
  });
}
async function state() {
  // Settle the persistence consumer so committed effects are comparable.
  await withEnv(env, () => disposePersistenceConsumer(engine));
  const tables = ['pages', 'content_chunks', 'page_versions', 'page_links', 'facts', 'takes', 'timeline_entries',
    'persistence_requests', 'persistence_effects', 'persistence_local_writers', 'persistence_source_bindings', 'persistence_worktrees', 'persistence_host_bindings'];
  return { disk: files(), db: await Promise.all(tables.map(table => engine.executeRaw(`SELECT * FROM ${table} ORDER BY 1`))) };
}

test('an excluded root refuses through the actual op for local/remote and live/dry with zero effects', async () => {
  // A bare directory prefix excludes the whole subtree, exactly as sync widens it.
  await setExclude('private/');
  for (const remote of [false, true]) for (const dryRun of [false, true]) {
    const before = await state();
    const provider = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider must not run'));
    try {
      const error = await refusal('private/secret', {}, ctx(remote, dryRun));
      expect(error?.code).toBe('permission_denied');
      expect(String(error?.suggestion)).toContain('sync.exclude');
      expect(provider).not.toHaveBeenCalled();
      expect(await state()).toEqual(before);
    } finally { provider.mockRestore(); }
  }
});

test('a slug outside every excluded root still commits and persists its file', async () => {
  await setExclude('private/');
  const result = await write('notes/keep');
  expect(result.state).toBe('committed');
  expect(readFileSync(join(root, 'notes/keep.md'), 'utf8')).toContain('type: note');
  expect((await engine.readPageSnapshot('notes/keep', { sourceId }))!.page.type).toBe('note');
});

test('excluding a root never touches the existing page or file already in it', async () => {
  await setExclude('');
  const first = await write('private/legacy');
  expect(first.state).toBe('committed');
  const bytes = readFileSync(join(root, 'private/legacy.md'), 'utf8');
  await setExclude('private/');
  const before = await state();
  expect((await refusal('private/legacy', { expected_revision: first.revision }))?.code).toBe('permission_denied');
  expect(await state()).toEqual(before);
  expect(readFileSync(join(root, 'private/legacy.md'), 'utf8')).toBe(bytes);
  expect((await engine.readPageSnapshot('private/legacy', { sourceId }))!.revision).toBe(first.revision);
});

test('a terminal request_id replays its accepted write after the root is excluded', async () => {
  await setExclude('');
  const request_id = randomUUID();
  const first = await write('private/replay', { request_id });
  expect(first.state).toBe('committed');
  await setExclude('private/');
  const replay = await write('private/replay', { request_id });
  expect(replay.state).toBe('committed');
  expect(replay.revision).toBe(first.revision);
});

/**
 * The guard's own failure boundary, at the module seal rather than through the
 * op: a config read that fails must not break a write over a scope check — it
 * is named once in the log and the write goes through. Mocking the engine's
 * getConfig on a live put_page is not an option here, because the persistence
 * consumer reads config in the background and would fail the write for
 * unrelated reasons, which is exactly why this case is sealed at the module.
 */
test('an unreadable sync.exclude fails open and names the skipped check once', async () => {
  const logged: string[] = [];
  const unreadable = { getConfig: (key: string) => key === 'sync.exclude'
    ? Promise.reject(new Error('config store unavailable')) : Promise.resolve(null) };
  await assertPutPageNotSyncExcluded(unreadable, 'private/fail-open', { info() {}, warn: (message: string) => { logged.push(message); }, error() {} });
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain('sync.exclude unreadable');
});
