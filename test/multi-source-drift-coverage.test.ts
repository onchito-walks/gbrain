import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { findMisroutedPages } from '../src/core/multi-source-drift.ts';
import { checkMultiSourceDrift, multiSourceDriftCheck } from '../src/commands/doctor/multi-source-drift-check.ts';
import { buildChecks, doctorReportRemote } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

// A cold PGLite schema build and a full local doctor run can exceed bun's
// default 5s per-test budget on a loaded host.
setDefaultTimeout(60_000);
let engine: PGLiteEngine;
const roots: string[] = [];
let sequence = 0;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); for (const root of roots) rmSync(root, { force: true, recursive: true }); });
async function fixture(files: Record<string, string> = { 'page.md': '# Page' }) {
  const root = mkdtempSync(join(tmpdir(), 'drift-coverage-')); roots.push(root);
  const id = `coverage-${++sequence}`;
  await engine.executeRaw('INSERT INTO sources (id, name, config) VALUES ($1,$1,$2::text::jsonb)', [id, '{"slug_root_mode":"source-root"}']);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
  }
  return { id, local_path: root };
}
const page = { type: 'note' as const, title: 'Fixture', compiled_truth: '# Fixture' };
function proxy(failOn: string): BrainEngine {
  return new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, args: unknown[]) => {
      if (sql.includes(failOn)) throw new Error('private-connection-secret');
      return target.executeRaw(sql, args);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe('multi-source drift coverage honesty', () => {
  test('DB-down local doctor explicitly reports unknown drift coverage', async () => {
    const checks = await buildChecks(null, []);
    expect(checks.find(c => c.name === 'multi_source_drift')).toMatchObject({
      status: 'warn', details: { code: 'not_verified', verification_complete: false },
    });
  });
  test('invalid environment and caller time budgets never start roster verification', async () => {
    let reads = 0;
    const unread = { executeRaw: async () => { reads++; return []; } } as unknown as BrainEngine;
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await checkMultiSourceDrift(unread, { timeoutMs })).toMatchObject({ status: 'warn' });
    }
    for (const value of ['', 'invalid', '0', '-1', '1.5']) {
      expect(await withEnv({ GBRAIN_DRIFT_TIMEOUT_MS: value }, () => checkMultiSourceDrift(unread))).toMatchObject({ status: 'warn' });
      const source = await fixture();
      const result = await withEnv({ GBRAIN_DRIFT_LIMIT: value }, () => findMisroutedPages(engine, [source]));
      expect(result.verification_complete).toBe(false);
    }
    expect(reads).toBe(0);
  });
  test('roster, config and managed-policy failure stay unknown with no private error disclosure', async () => {
    const source = await fixture();
    await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [source.id, source.local_path]);
    for (const remote of [false, true]) {
      const check = await checkMultiSourceDrift(proxy('SELECT id, local_path, config FROM sources'), { remote });
      expect(check).toMatchObject({ status: 'warn', details: { verified: false } });
      expect(check?.message).not.toContain('private-connection-secret');
    }
    const failedConfig = new Proxy(engine, { get(target, key) {
      if (key === 'getConfig') return async () => { throw new Error('private-connection-secret'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await findMisroutedPages(failedConfig, [source])).coverage_issues).toContainEqual({ source_id: source.id, reason: 'configuration' });
    expect(await checkMultiSourceDrift(failedConfig)).toMatchObject({ status: 'warn', details: { verified: false } });
  });
  test('managed-policy read is inside the same doctor deadline', async () => {
    const source = await fixture();
    const stuck = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return (sql: string) => sql.startsWith('SELECT id, local_path, config FROM sources')
        ? Promise.resolve([source]) : new Promise(() => {});
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const started = Date.now();
    expect(await checkMultiSourceDrift(stuck, { timeoutMs: 100 })).toMatchObject({ status: 'warn', details: { verified: false } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(Date.now() - started).toBeLessThan(1500);
  });
  test('environment timeout is inherited and an explicit timeout still overrides it', async () => {
    const source = await fixture({});
    await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [source.id, source.local_path]);
    const check = await withEnv({ GBRAIN_DRIFT_TIMEOUT_MS: '30000' }, () => checkMultiSourceDrift(engine));
    expect(check?.status).toBe('ok');
    expect(Number(check?.details?.timeout_ms)).toBeGreaterThan(25000);
    expect(await withEnv({ GBRAIN_DRIFT_TIMEOUT_MS: 'invalid' }, () => checkMultiSourceDrift(engine, { timeoutMs: 1000 }))).toMatchObject({ status: 'ok' });
  });
  test('missing root is unknown, never verified clean', async () => {
    const source = await fixture(); source.local_path += '/missing';
    const result = await findMisroutedPages(engine, [source]);
    expect(result.verification_complete).toBe(false);
    expect(result.coverage_issues).toContainEqual({ source_id: source.id, reason: 'filesystem' });
    expect(multiSourceDriftCheck(result, 1, 'local').status).toBe('warn');
    expect(result.checked_sources).toEqual([]);
  });
  test('a regular file used as local_path is a coverage error', async () => {
    const source = await fixture(); source.local_path += '/page.md';
    expect((await findMisroutedPages(engine, [source])).verification_complete).toBe(false);
  });
  test('an actually unreadable root records native filesystem failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-unreadable-')); roots.push(root); chmodSync(root, 0);
    const url = new URL('../src/core/multi-source-drift-walk.ts', import.meta.url).href;
    const script = `import {walkDriftMarkdown} from ${JSON.stringify(url)};
      if (process.getuid?.() === 0) process.setuid(65534);
      console.log(JSON.stringify(await walkDriftMarkdown(${JSON.stringify(root)},10,Date.now()+1000,{strategy:'markdown'})));`;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
    chmodSync(root, 0o755);
    expect(JSON.parse(out).errors).toBeGreaterThan(0);
  });
  test.skipIf(process.getuid?.() === 0)('an unreadable nested directory does not disappear behind a clean sibling', async () => {
    const source = await fixture({ 'good.md': '# Good', 'closed/bad.md': '# Bad' });
    const closed = join(source.local_path, 'closed'); chmodSync(closed, 0);
    try {

      const result = await findMisroutedPages(engine, [source]);
      expect(result.verification_complete).toBe(false); expect(result.candidates_checked).toBe(1);
      expect(result.coverage_issues).toContainEqual({ source_id: source.id, reason: 'filesystem' });
    } finally { chmodSync(closed, 0o755); }
  });
  test('invalid YAML, unsupported strategy and slug collisions cannot be certified clean', async () => {
    const broken = await fixture({ 'page.md': '---\nslug: [broken\n---\n# Page' });
    expect((await findMisroutedPages(engine, [broken])).verification_complete).toBe(false);
    const code = { ...await fixture(), config: { strategy: 'code' } };
    expect((await findMisroutedPages(engine, [code])).coverage_issues).toContainEqual({ source_id: code.id, reason: 'unsupported_strategy' });
    const collision = await fixture({ 'Page Name.md': '# One', 'page-name.md': '# Two' });
    expect((await findMisroutedPages(engine, [collision])).coverage_issues).toContainEqual({ source_id: collision.id, reason: 'identity' });
  });
  test('clean accessible empty directory is verified, not a missing root', async () => {
    const source = await fixture({}); const result = await findMisroutedPages(engine, [source]);
    expect(result).toMatchObject({ verification_complete: true, checked_sources: [source.id], candidates_checked: 0 });
    expect(multiSourceDriftCheck(result, 1, 'local').status).toBe('ok');
  });
  test('partial Git skip alongside clean source remains WARN locally and remotely', async () => {
    const broken = await fixture();
    writeFileSync(join(broken.local_path, '.git'), 'gitdir: /nonexistent/drift-fixture\n');
    await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [broken.id, '{"slug_root_mode":"git-root"}']);
    const clean = await fixture();
    const result = await findMisroutedPages(engine, [broken, clean]);
    expect(result.checked_sources).toEqual([clean.id]);
    expect(result.git_root_skipped).toEqual([broken.id]);
    for (const remote of [false, true]) expect(multiSourceDriftCheck(result, 2, remote ? 'remote' : 'local').status).toBe('warn');
  });
  test('persisted source_path database failure is unknown in the real doctor paths', async () => {
    // Persist local_path so the check is actually eligible to run here; the
    // failure is in the verifier's own per-source DB read, not the roster.
    const source = await fixture();
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [source.local_path, source.id]);
    const broken = proxy('source_path = ANY');
    const direct = await checkMultiSourceDrift(broken, {});
    expect(direct?.status).toBe('warn');
    expect(direct?.message).toContain('unknown');
    expect(direct?.message).not.toContain('private-connection-secret');
    const local = await buildChecks(broken, []);
    const localCheck = local.find(c => c.name === 'multi_source_drift');
    expect(localCheck?.status).toBe('warn'); expect(localCheck?.message).toContain('unknown');
    expect(localCheck?.message).not.toContain('private-connection-secret');
    const remote = await doctorReportRemote(broken);
    const remoteCheck = remote.checks.find(c => c.name === 'multi_source_drift');
    expect(remoteCheck?.status).toBe('warn'); expect(remoteCheck?.message).toContain('unknown');
    expect(remoteCheck?.message).not.toContain('private-connection-secret');
  });
  test('source pin read errors are unknown rather than an omitted check', async () => {
    const source = await fixture();
    const result = await findMisroutedPages(proxy('slug_root_mode'), [source]);
    expect(result.verification_complete).toBe(false);
    expect(result.coverage_issues).toContainEqual({ source_id: source.id, reason: 'database' });
  });
  test('candidate-query errors retain the failure reason', async () => {
    const source = await fixture();
    const result = await findMisroutedPages(proxy('WITH candidates'), [source]);
    expect(result.verification_complete).toBe(false);
    expect(result.candidates_checked).toBe(0);
  });
  test('one globally shared file budget accounts for unvisited sources', async () => {
    const first = await fixture(); const second = await fixture();
    const result = await findMisroutedPages(engine, [first, second], { limit: 1 });
    expect(result.candidates_checked).toBe(1);
    expect(result.coverage_issues).toContainEqual({ source_id: second.id, reason: 'limit' });
    expect(result.verification_complete).toBe(false);
  });
  test('exact limit on the final source does not falsely claim truncation', async () => {
    const source = await fixture();
    expect((await findMisroutedPages(engine, [source], { limit: 1 })).verification_complete).toBe(true);
  });
  test('invalid budgets never claim a clean verification', async () => {
    const source = await fixture();
    for (const opts of [{ limit: 0 }, { timeoutMs: 0 }, { limit: Number.NaN }]) {
      expect((await findMisroutedPages(engine, [source], opts)).verification_complete).toBe(false);
    }
  });
  test('a stuck database read returns deadline/unknown, not a clean zero', async () => {
    const source = await fixture(); const stuck = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return () => new Promise(() => {});
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const started = Date.now();
    const result = await findMisroutedPages(stuck, [source], { timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.coverage_issues).toContainEqual({ source_id: source.id, reason: 'deadline' });
  });
  test('configured doctor budget survives real IO above five seconds while short deadlines remain fail-closed', async () => {
    const source = await fixture({});
    const delayed = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return async (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT id, local_path, config FROM sources')) {
          await Bun.sleep(5_100);
          return [source];
        }
        return target.executeRaw(sql, args);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    for (const remote of [false, true]) {
      const check = await checkMultiSourceDrift(delayed, { remote, timeoutMs: 30_000 });
      expect(check?.status).toBe('ok');
      expect(check?.details?.verification_complete).toBe(true);
      expect(check?.details?.checked_sources).toEqual([source.id]);
    }
    const started = Date.now();
    const bounded = await checkMultiSourceDrift(delayed, { timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(bounded?.status).toBe('warn');
    expect(bounded?.message).toContain('unknown');
  }, 20_000);
  test('a caller without the comparison grant does not query default pages', async () => {
    const source = await fixture(); await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [source.id, source.local_path]);
    let queries = 0; const scoped = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return (sql: string, args: unknown[]) => {
        queries++; expect(sql).toContain('WHERE id = ANY'); return target.executeRaw(sql, args);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const check = await checkMultiSourceDrift(scoped, { sourceIds: [source.id], remote: true });
    expect(check?.status).toBe('warn'); expect(queries).toBe(1);
  });
});

describe('sync identity and eligibility parity', () => {
  test('malformed path and ambiguous identity use native import admission, never false drift advice', async () => {
    // Native isSyncable excludes malformed paths before import admission.
    const excluded = await fixture({ 'note [draft].md': '# Note' });
    expect(await findMisroutedPages(engine, [excluded])).toMatchObject({
      count: 0, verification_complete: true, candidates_checked: 0,
    });
    const ambiguous = await fixture({ 'page.md': '---\nslug: page\nslug: other\n---\n# Page' });
    const result = await findMisroutedPages(engine, [ambiguous]);
    expect(result.count).toBe(0);
    expect(result.coverage_issues).toContainEqual({ source_id: ambiguous.id, reason: 'identity' });
  });
  test('normalization-equivalent frontmatter restores exact imported slug', async () => {
    const source = await fixture({ 'Legacy Note.md': '---\nslug: Legacy Note\n---\n# Legacy' });
    await engine.putPage('Legacy Note', page);
    const result = await findMisroutedPages(engine, [source]);
    expect(result.verification_complete).toBe(true); expect(result.sample[0]?.slug).toBe('legacy note');
  });
  test('frontmatter cannot spoof another path-authoritative page', async () => {
    const source = await fixture({ 'page.md': '---\nslug: other-page\n---\n# Page' });
    await engine.putPage('other-page', page);
    const result = await findMisroutedPages(engine, [source]);
    expect(result.count).toBe(0); expect(result.verification_complete).toBe(false);
    expect(result.coverage_issues).toContainEqual({ source_id: source.id, reason: 'identity' });
  });
  test('empty path-derived identity uses the importer frontmatter fallback', async () => {
    const source = await fixture({ '😀.md': '---\nslug: emoji-note\n---\n# Emoji' });
    await engine.putPage('emoji-note', page);
    const result = await findMisroutedPages(engine, [source]);
    expect(result.verification_complete).toBe(true); expect(result.sample[0]?.slug).toBe('emoji-note');
  });
  test('stored source_path resolves legacy slugs and prevents filename collision advice', async () => {
    const source = await fixture();
    await engine.putPage('stored-exact-key', page, { sourceId: source.id });
    await engine.executeRaw('UPDATE pages SET source_path=$2 WHERE source_id=$1 AND slug=$3', [source.id, 'page.md', 'stored-exact-key']);
    await engine.putPage('page', page);
    const result = await findMisroutedPages(engine, [source]);
    expect(result.verification_complete).toBe(true); expect(result.count).toBe(0);
  });
  test('a legacy default-side source_path identity is detectable', async () => {
    const source = await fixture({ 'legacy-path.md': '# Page' });
    await engine.putPage('different-stored-key', page);
    await engine.executeRaw("UPDATE pages SET source_path='legacy-path.md' WHERE source_id='default' AND slug='different-stored-key'");
    const result = await findMisroutedPages(engine, [source]);
    expect(result.sample[0]?.slug).toBe('different-stored-key');
  });
  test('duplicate active source_path is unknown, not first-row-wins', async () => {
    const source = await fixture();
    for (const slug of ['duplicate-a', 'duplicate-b']) {
      await engine.putPage(slug, page, { sourceId: source.id });
      await engine.executeRaw('UPDATE pages SET source_path=$2 WHERE source_id=$1 AND slug=$3', [source.id, 'page.md', slug]);
    }
    expect((await findMisroutedPages(engine, [source])).verification_complete).toBe(false);
  });
  test('persisted exclude, hidden waiver, underscore files and canonical metafiles match sync', async () => {
    const source = await fixture({ '_page.md': '# Under', 'README.md': '# Meta', 'excluded/page.md': '# Excluded', '.hidden/page.md': '# Hidden' });
    for (const slug of ['_page', 'readme', 'excluded/page', '.hidden/page']) await engine.putPage(slug, page);
    await engine.setConfig('sync.exclude', 'excluded/'); await engine.setConfig('sync.include_hidden', '.hidden/**');
    try {
      const result = await findMisroutedPages(engine, [source]);
      expect(result.verification_complete).toBe(true);
      expect(result.sample.map(sample => sample.slug).sort()).toEqual(['.hidden/page', '_page']);
    } finally { await engine.setConfig('sync.exclude', ''); await engine.setConfig('sync.include_hidden', ''); }
  });
});
