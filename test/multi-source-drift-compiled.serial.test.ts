/** Real compiled CLI, persistent isolated PGLite brain; never the operator database. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const binary = process.env.GBRAIN_TEST_DRIFT_BINARY;
describe.skipIf(!binary)('compiled multi_source_drift doctor', () => {
  test('prefixed drift, clean mapping and missing-root unknown survive CLI process reopen without page/source mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-compiled-'));
    const home = join(root, 'brain-home'); const database = join(root, 'database');
    const repo = join(root, 'repo'); const scope = join(repo, 'Readwise');
    mkdirSync(join(home, '.gbrain'), { recursive: true }); mkdirSync(join(scope, 'Books'), { recursive: true });
    const git = Bun.spawnSync(['git', 'init', '-q', repo]); expect(git.exitCode).toBe(0);
    writeFileSync(join(scope, 'Books', 'Compiled Note.md'), '# Compiled Note');
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: database, embedding_dimensions: 1536,
      embedding_model: 'text-embedding-3-small', brain_repo: join(root, 'canonical') }));
    const config = { engine: 'pglite' as const, database_path: database };
    let engine = new PGLiteEngine(); await engine.connect(config); await engine.initSchema();
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('readwise','Readwise',$1,$2::text::jsonb)",
      [scope, '{"slug_root_mode":"git-root"}']);
    await engine.putPage('readwise/books/compiled-note', { type: 'note', title: 'Fixture', compiled_truth: '# Fixture' });
    const state = async () => ({
      pages: await engine.executeRaw('SELECT source_id,slug,compiled_truth,source_path,deleted_at FROM pages ORDER BY source_id,slug'),
      sources: await engine.executeRaw('SELECT id,local_path,config,last_commit FROM sources ORDER BY id'),
    });
    const cli = async () => {
      const proc = Bun.spawn([binary!, 'doctor', '--no-migrate', '--json'], { cwd: root, stdout: 'pipe', stderr: 'pipe',
        env: { HOME: root, GBRAIN_HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() } });
      const timeout = setTimeout(() => proc.kill(), 60_000);
      try {
        const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        expect(exit).not.toBe(137);
        let report: { checks: {name: string; status: string; message: string}[] };
        try { report = JSON.parse(stdout); } catch { throw new Error(`Compiled doctor invalid JSON (exit=${exit}): ${stderr}\n${stdout}`); }
        const check = report.checks.find(c => c.name === 'multi_source_drift');
        expect(check).toBeDefined(); return check!;
      } finally { clearTimeout(timeout); }
    };
    try {
      const before = await state(); await engine.disconnect();
      const drift = await cli(); expect(drift.status).toBe('warn'); expect(drift.message).toContain('readwise/books/compiled-note');
      engine = new PGLiteEngine(); await engine.connect(config); expect(await state()).toEqual(before);
      await engine.putPage('readwise/books/compiled-note', { type: 'note', title: 'Fixture', compiled_truth: '# Fixture' }, { sourceId: 'readwise' });
      const cleanBefore = await state(); await engine.disconnect();
      const clean = await cli(); expect(clean.status).toBe('ok');
      engine = new PGLiteEngine(); await engine.connect(config); expect(await state()).toEqual(cleanBefore);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='readwise'", [join(root, 'missing-source')]);
      const missingBefore = await state(); await engine.disconnect();
      const unknown = await cli(); expect(unknown.status).toBe('warn'); expect(unknown.message).toContain('unknown');
      engine = new PGLiteEngine(); await engine.connect(config); expect(await state()).toEqual(missingBefore);
    } finally { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); }
  }, 180_000);
});
