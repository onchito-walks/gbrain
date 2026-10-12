import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { findMisroutedPages } from '../../src/core/multi-source-drift.ts';
import { checkMultiSourceDrift } from '../../src/commands/doctor/multi-source-drift-check.ts';

let engine: PostgresEngine; let repo: string; let scope: string;
describe.skipIf(!hasDatabase())('multi-source drift PostgreSQL parity', () => {
  beforeAll(async () => {
    engine = await setupDB(); repo = mkdtempSync(join(tmpdir(), 'drift-postgres-')); scope = join(repo, 'Readwise');
    mkdirSync(join(scope, 'Books'), { recursive: true }); execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(scope, 'Books', 'Parity Note.md'), '# Parity');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('readwise','Readwise',$1,$2::text::jsonb)",
      [scope, '{"slug_root_mode":"git-root"}']);
  });
  afterAll(async () => { await teardownDB(); if (repo) rmSync(repo, { recursive: true, force: true }); });
  test('Git prefix finds default-only row; no source pin mutation', async () => {
    await engine.putPage('readwise/books/parity-note', { type: 'note', title: 'Parity', compiled_truth: '# Parity' });
    const before = await engine.executeRaw("SELECT config FROM sources WHERE id='readwise'");
    const result = await findMisroutedPages(engine, [{ id: 'readwise', local_path: scope }]);
    expect(result).toMatchObject({ count: 1, verification_complete: true, checked_sources: ['readwise'] });
    expect(result.sample[0].slug).toBe('readwise/books/parity-note');
    expect(await engine.executeRaw("SELECT config FROM sources WHERE id='readwise'")).toEqual(before);
  });
  test('same slug at intended source is clean, not a misroute', async () => {
    await engine.putPage('readwise/books/parity-note', { type: 'note', title: 'Parity', compiled_truth: '# Parity' }, { sourceId: 'readwise' });
    expect(await findMisroutedPages(engine, [{ id: 'readwise', local_path: scope }])).toMatchObject({ count: 0, verification_complete: true });
  });
  test('missing root is unknown even when another source is verified', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('missing','Missing',$1::text::jsonb)", ['{"slug_root_mode":"source-root"}']);
    const result = await findMisroutedPages(engine, [{ id: 'readwise', local_path: scope }, { id: 'missing', local_path: join(repo, 'absent') }]);
    expect(result.verification_complete).toBe(false); expect(result.checked_sources).toEqual(['readwise']);
  });
  test('server statement cancellation becomes explicit unknown coverage', async () => {
    const wrapped = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return async (sql: string, args: unknown[]) => {
        if (sql.includes('WITH candidates')) {
          await target.withReservedConnection(async connection => {
            await connection.executeRaw("SET statement_timeout='50ms'");
            try { await connection.executeRaw('SELECT pg_sleep(2)'); }
            finally { await connection.executeRaw('RESET statement_timeout'); }
          });
        }
        return target.executeRaw(sql, args);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await findMisroutedPages(wrapped, [{ id: 'readwise', local_path: scope }]);
    expect(result.verification_complete).toBe(false);
    expect(result.coverage_issues).toContainEqual({ source_id: 'readwise', reason: 'database' });
    expect(result.candidates_checked).toBe(0);
  });
  test('unauthorized comparison scope remains unknown rather than reading excluded source', async () => {
    const check = await checkMultiSourceDrift(engine, { sourceIds: ['readwise'], remote: true });
    expect(check?.status).toBe('warn'); expect(check?.message).toContain('not authorized');
  });
});
