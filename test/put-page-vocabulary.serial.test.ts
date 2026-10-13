import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pagesOperations } from '../src/core/ops/pages.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import { spawnSync } from '../src/core/spawn.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-put-vocabulary-'));
const root = join(home, 'vault');
const sourceId = 'vocabulary-test';
const put = pagesOperations.find(op => op.name === 'put_page')!;
let engine: PGLiteEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined };
const ctx = (remote = false, dryRun = false): OperationContext => ({ engine, sourceId, remote, dryRun,
  config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } });
const content = (type: string) => `---\ntype: ${type}\ntitle: Synthetic example\n---\nA synthetic admission fixture describes a harmless example.\n`;
const write = (slug: string, text: string, options: Record<string, unknown> = {}, context = ctx()) =>
  withEnv(env, () => put.handler(context, { request_id: randomUUID(), slug, content: text, ...options })) as Promise<Record<string, any>>;

beforeAll(async () => withEnv(env, async () => {
  mkdirSync(root);
  // Bound discovery to this disposable checkout, never the ancestor Hermes repo.
  expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
  const packRoot = join(home, '.gbrain', 'schema-packs', 'admission-test');
  mkdirSync(packRoot, { recursive: true });
  writeFileSync(join(packRoot, 'pack.json'), JSON.stringify({ api_version: 'gbrain-schema-pack-v1',
    name: 'admission-test', version: '1.0.0', extends: 'gbrain-base-v2',
    page_types: [{ name: 'initiative', primitive: 'entity', path_prefixes: ['initiatives/'], aliases: ['project-card'] }] }));
  for (const [name, page_types] of [
    ['relation-only-test', []],
    ['no-note-test', [{ name: 'initiative', primitive: 'entity', path_prefixes: ['initiatives/'] }]],
  ] as const) {
    const dir = join(home, '.gbrain', 'schema-packs', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({ api_version: 'gbrain-schema-pack-v1',
      name, version: '1.0.0', extends: null, page_types, link_types: [], frontmatter_links: [] }));
  }
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  await engine.setConfig(`schema_pack.source.${sourceId}`, 'admission-test');
}), 120_000);
afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  _resetPackCacheForTests(); rmSync(home, { recursive: true, force: true });
});

function files(path = home): Array<{ path: string; bytes: string; modified: number }> {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [{ path: relative(home, child), bytes: readFileSync(child).toString('base64'), modified: statSync(child).mtimeMs }];
  });
}
async function state() {
  // Settle prior valid controls before comparing every row, including effects.
  await withEnv(env, () => disposePersistenceConsumer(engine));
  const tables = ['pages', 'content_chunks', 'page_versions', 'page_links', 'facts', 'takes', 'timeline_entries',
    'persistence_requests', 'persistence_effects', 'persistence_local_writers', 'persistence_source_bindings', 'persistence_worktrees', 'persistence_host_bindings'];
  return { disk: files(), db: await Promise.all(tables.map(table => engine.executeRaw(`SELECT * FROM ${table} ORDER BY 1`))) };
}

for (const remote of [false, true]) for (const dryRun of [false, true]) {
  test(`undeclared actual put_page refuses with zero journal/DB/disk/provider effects remote=${remote} dry=${dryRun}`, async () => {
    const before = await state();
    const provider = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider must not run'));
    try {
      await expect(write(`notes/rejected-${remote}-${dryRun}`, content('undeclared-card'), {}, ctx(remote, dryRun)))
        .rejects.toMatchObject({ code: 'invalid_params' });
      expect(provider).not.toHaveBeenCalled();
      expect(await state()).toEqual(before);
    } finally { provider.mockRestore(); }
  });
}

test('source override canonical vocabulary and alias persist through the native writer and replay', async () => {
  for (const type of ['initiative', 'project-card']) {
    const slug = `initiatives/${type}`;
    const request_id = randomUUID();
    const result = await write(slug, content(type), { request_id });
    expect(result.state).toBe('committed');
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(snapshot.page.type).toBe('initiative');
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('type: initiative');
    expect(result.type_warning).toBeUndefined();
    const before = await state();
    // A terminal UUID replays its original normalized intent even if vocabulary changes.
    await engine.setConfig(`schema_pack.source.${sourceId}`, 'gbrain-base-v2');
    try { expect((await write(slug, content(type), { request_id })).revision).toBe(result.revision); }
    finally { await engine.setConfig(`schema_pack.source.${sourceId}`, 'admission-test'); }
    expect(await state()).toEqual(before);
  }
});

test('undeclared replacement preserves existing page revision, versions, file and chunks', async () => {
  await write('notes/existing', content('note'));
  const snapshot = (await engine.readPageSnapshot('notes/existing', { sourceId }))!;
  const before = await state();
  await expect(write('notes/existing', content('banana'), { expected_revision: snapshot.revision })).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await state()).toEqual(before);
});

test('implicit type on existing page preserves the curated canonical type', async () => {
  const slug = 'initiatives/implicit';
  await write(slug, content('initiative'));
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  expect((await write(slug, '# Revised synthetic example\nChanged prose.', { expected_revision: snapshot.revision })).state).toBe('committed');
  expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.type).toBe('initiative');
});

test('unresolvable source pack retains best-effort verbatim writes', async () => {
  await engine.setConfig(`schema_pack.source.${sourceId}`, 'missing-admission-pack');
  try {
    expect((await write('notes/unresolved', content('legacy-custom'))).state).toBe('committed');
    expect((await engine.readPageSnapshot('notes/unresolved', { sourceId }))!.page.type).toBe('legacy-custom');
  } finally { await engine.setConfig(`schema_pack.source.${sourceId}`, 'admission-test'); }
});

test('client-supplied subagent/scope fields cannot manufacture generated-write authority', async () => {
  const before = await state();
  await expect(write('notes/forged-scope', content('pattern'), {
    viaSubagent: true, allowedSlugPrefixes: ['notes/*'], subagentId: 42,
  }, ctx(true))).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await state()).toEqual(before);
});

test('resolved empty vocabulary and missing declared note refuse without effects, including generated scope', async () => {
  for (const pack of ['relation-only-test', 'no-note-test']) {
    await engine.setConfig(`schema_pack.source.${sourceId}`, pack);
    try {
      for (const generated of [false, true]) {
        const context = { ...ctx(), ...(generated ? { viaSubagent: true, subagentId: 42, allowedSlugPrefixes: ['notes/*'] } : {}) };
        const before = await state();
        await expect(write(`notes/no-note-${pack}-${generated}`, content('pattern'), {}, context))
          .rejects.toMatchObject({ code: 'invalid_params' });
        expect(await state()).toEqual(before);
      }
    } finally { await engine.setConfig(`schema_pack.source.${sourceId}`, 'admission-test'); }
  }
});

test('generated normalization binds the actual source pack and preserves fields/body/timeline in frozen replay', async () => {
  const slug = 'notes/scoped-source';
  const request_id = randomUUID();
  const context = { ...ctx(), viaSubagent: true, subagentId: 42, allowedSlugPrefixes: ['notes/*'] };
  const text = '---\ntype: pattern\ntitle: Scoped source\ncustom_field: retained\n---\n\nOriginal prose.\n\n## Timeline\n\n- **2026-01-01** | note — Original observation\n';
  const first = await write(slug, text, { request_id }, context);
  expect(first.state).toBe('committed');
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  expect(snapshot.page.type).toBe('note');
  expect(snapshot.page.frontmatter).toMatchObject({ legacy_type: 'pattern', custom_field: 'retained' });
  expect(snapshot.page.compiled_truth).toBe('Original prose.');
  expect(snapshot.page.timeline).toContain('Original observation');
  expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('legacy_type: pattern');
  await engine.setConfig(`schema_pack.source.${sourceId}`, 'no-note-test');
  try {
    const before = await state();
    expect((await write(slug, text, { request_id }, context)).revision).toBe(first.revision);
    expect(await state()).toEqual(before);
  } finally { await engine.setConfig(`schema_pack.source.${sourceId}`, 'admission-test'); }
});
