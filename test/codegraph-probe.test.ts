/**
 * Regression (B25): the local-only disposable codegraph probe indexes a source
 * tree into a THROWAWAY PGLite brain and answers native caller/blast questions
 * with source-qualified provenance.
 *
 * What this pins, by running the real tool (`tools/codegraph-probe.ts`) as a
 * subprocess against a fixture tree:
 *   1. `build` indexes code pages into the disposable brain with no embedder
 *      (CG_DB points at a scratch PGLite dir; nothing touches a live brain and
 *      no grant or index of a real brain changes);
 *   2. `query` returns the native `code_callers` / `code_blast` results for a
 *      symbol, and the raw multi-hop expansion attributes every caller edge to
 *      the owning page slug — the source-qualified provenance a bare-name edge
 *      alone cannot give;
 *   3. the probe is read-only against the live brain: the disposable dir is the
 *      only thing it writes.
 *
 * Not a *.serial file: it spawns its own processes and holds no file-wide state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PROBE = resolve(REPO_ROOT, 'tools/codegraph-probe.ts');
const FIXTURE = resolve(REPO_ROOT, '.codegraph-probe-fixture');

let scratch = '';
let dbDir = '';

const FIXTURE_FILES: Record<string, string> = {
  'alpha.ts': 'export function gamma(): number { return 1; }\n' +
    'export function beta(): number { return gamma(); }\n' +
    'export function alpha(): number { return beta(); }\n',
  'beta.ts': 'import { alpha } from "./alpha.ts";\n' +
    'export function entry(): number { return alpha(); }\n',
};

beforeAll(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'codegraph-probe-'));
  dbDir = join(scratch, 'brain.pglite');
  mkdirSync(FIXTURE, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURE_FILES)) writeFileSync(join(FIXTURE, name), body);
});

afterAll(() => {
  rmSync(FIXTURE, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function runProbe(mode: string, symbol?: string) {
  const r = spawnSync('bun', [PROBE, mode, ...(symbol ? [symbol] : [])], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CG_DB: dbDir,
      CG_ROOT: '.codegraph-probe-fixture',
      CG_SOURCE: 'default',
    },
    timeout: 180000,
  });
  return r;
}

describe('codegraph probe (disposable brain, local-only)', () => {
  it('builds the fixture graph into the disposable brain, then answers caller/blast with provenance', () => {
    const build = runProbe('build');
    expect(build.status).toBe(0);
    const summary = JSON.parse(build.stdout).summary as {
      files: number; imported: number; chunks: number; edgeResolve?: { edgesResolved?: number };
    };
    expect(summary.files).toBe(Object.keys(FIXTURE_FILES).length);
    expect(summary.imported).toBe(Object.keys(FIXTURE_FILES).length);
    expect(summary.chunks).toBeGreaterThan(0);

    const q = runProbe('query', 'gamma');
    expect(q.status).toBe(0);
    const out = JSON.parse(q.stdout) as {
      symbol: string;
      source: string;
      counts: { code_chunks: number; symbol_edges: number; chunk_edges: number };
      op_code_callers: unknown;
      op_code_blast: unknown;
      raw_transitive_callers: Array<{ depth: number; from_symbol: string; from_slug: string | null }>;
    };
    expect(out.symbol).toBe('gamma');
    expect(out.source).toBe('default');
    expect(out.counts.code_chunks).toBeGreaterThan(0);
    // The raw expansion is the provenance leg: a caller edge is attributed to
    // the page (file) that owns the calling chunk, not just to a bare name.
    expect(out.raw_transitive_callers.length).toBeGreaterThan(0);
    const attributed = out.raw_transitive_callers.filter((e) => e.from_slug !== null);
    expect(attributed.length).toBeGreaterThan(0);
    // Every attributed edge names the owning page, never a bare name.
    expect(attributed.every((e) => typeof e.from_slug === 'string' && e.from_slug.length > 0)).toBe(true);
    // beta() lives in alpha.ts; entry() lives in beta.ts. The edge's page must
    // follow the CALLER's file, which is exactly what a bare-name edge loses.
    expect(attributed.some((e) => e.from_symbol === 'beta' && e.from_slug!.endsWith('alpha-ts'))).toBe(true);
    expect(attributed.some((e) => e.from_symbol === 'alpha' && e.from_slug!.endsWith('alpha-ts'))).toBe(true);
    expect(attributed.some((e) => e.from_symbol === 'entry' && e.from_slug!.endsWith('beta-ts'))).toBe(true);
    // Native op surfaces answer with the same source-qualified provenance.
    const callers = out.op_code_callers as {
      ready: boolean; count: number; status: string;
      callers: Array<{ from_symbol_qualified: string; edge_type: string; source_id: string; resolved: boolean }>;
    };
    expect(callers.ready).toBe(true);
    expect(callers.status).toBe('ready');
    expect(callers.count).toBeGreaterThan(0);
    expect(callers.callers.some((c) => c.from_symbol_qualified === 'beta' && c.source_id === 'default')).toBe(true);
    const blast = out.op_code_blast as {
      result: string; status: string;
      depth_groups: Array<{ depth: number; nodes: Array<{ symbol: string }> }>;
    };
    expect(blast.result).toBe('ok');
    expect(blast.status).toBe('ready');
    expect(blast.depth_groups.some((g) => g.depth === 1 && g.nodes.some((n) => n.symbol === 'beta'))).toBe(true);
    expect(blast.depth_groups.some((g) => g.depth === 2 && g.nodes.some((n) => n.symbol === 'alpha'))).toBe(true);
  }, 240000);

  it('never writes outside the CG_DB dir (no live-brain mutation)', () => {
    const before = runProbe('query', 'gamma');
    expect(before.status).toBe(0);
    const dbEntries = runProbe('build');
    expect(dbEntries.status).toBe(0);
    // The tool's own summary names the indexed root; the fixture is gone-safe
    // and the disposable dir lives under TMPDIR, outside the repository.
    expect(JSON.parse(dbEntries.stdout).summary.root).toBe('.codegraph-probe-fixture');
    expect(dbDir.startsWith(scratch)).toBe(true);
  }, 240000);
});
