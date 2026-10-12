/**
 * codegraph-probe.ts — LOCAL-ONLY, disposable-brain code-graph probe.
 *
 * Purpose: build the native GBrain tree-sitter call graph for a checkout's
 * source tree inside a throwaway PGLite brain (never the live brain), then
 * exercise the native code-intel operations (code_callers / code_blast) and a
 * raw multi-hop caller expansion against that graph.
 *
 * Safety: reads only files under CG_ROOT inside this worktree; writes only to
 * the PGLite data dir named by CG_DB. No network, no embeddings (noEmbed:true),
 * no live-source imports, no extraction. Safe to delete the CG_DB dir.
 *
 * Usage:
 *   CG_DB=<pglite data dir> [CG_ROOT=src] [CG_SOURCE=default] [CG_OUT=out.json] \
 *     bun tools/codegraph-probe.ts build
 *   ... bun tools/codegraph-probe.ts query <symbol>
 *   ... bun tools/codegraph-probe.ts all   <symbol>
 *
 * Env:
 *   CG_DB      PGLite data dir (e.g. $GBRAIN_HOME/.gbrain/brain.pglite). Required.
 *   CG_ROOT    dir to index, relative to worktree root. Default 'src'.
 *   CG_SOURCE  source id to index/query. Default 'default'.
 *   CG_OUT     path to write the JSON result. Optional.
 *   CG_DEPTH   transitive hop cap for the raw expansion. Default 6.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../src/core/chunkers/symbol-resolver.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const DB = process.env.CG_DB;
if (!DB) { console.error('CG_DB (PGLite data dir) is required'); process.exit(2); }
const ROOT = process.env.CG_ROOT ?? 'src';
const SOURCE = process.env.CG_SOURCE ?? 'default';
const OUT = process.env.CG_OUT;
const DEPTH = parseInt(process.env.CG_DEPTH ?? '6', 10);
const WORKTREE = process.cwd();

const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

function walkCodeFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      if (e === 'node_modules' || e === 'dist' || e === 'build') continue;
      const full = join(d, e);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (isDir) { stack.push(full); continue; }
      if (CODE_EXT.some((x) => e.endsWith(x))) out.push(full);
    }
  }
  return out.sort();
}

function ctxOf(engine: any, overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: false,          // trusted local CLI-equivalent caller
    transport: 'cli',
    sourceId: SOURCE,
    ...overrides,
  } as OperationContext;
}

async function connect(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: DB } as any);
  return engine;
}

async function build(engine: PGLiteEngine): Promise<any> {
  await engine.initSchema();
  const files = walkCodeFiles(ROOT);
  const summary = { root: ROOT, files: files.length, imported: 0, skipped: 0, failed: 0, chunks: 0, failures: [] as any[] };
  const t0 = Date.now();
  let i = 0;
  for (const abs of files) {
    const rel = relative(WORKTREE, abs);
    let content: string;
    try { content = readFileSync(abs, 'utf8'); } catch (e) { summary.failed++; summary.failures.push({ rel, error: String(e) }); continue; }
    try {
      const r = await importCodeFile(engine, rel, content, { noEmbed: true });
      if (r.status === 'imported') { summary.imported++; summary.chunks += r.chunks ?? 0; }
      else if (r.status === 'skipped') summary.skipped++;
      else { summary.failed++; summary.failures.push({ rel, error: r.error ?? r.status }); }
    } catch (e) {
      summary.failed++;
      summary.failures.push({ rel, error: e instanceof Error ? e.message : String(e) });
    }
    if (++i % 100 === 0) console.error(`[build] ${i}/${files.length} (${Date.now() - t0}ms)`);
  }
  console.error(`[build] imported ${summary.imported} files, ${summary.chunks} chunks in ${Date.now() - t0}ms; resolving edges...`);
  const t1 = Date.now();
  const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: SOURCE, maxChunks: 1_000_000 });
  summary.edgeResolve = stats;
  summary.buildMs = Date.now() - t0;
  summary.resolveMs = Date.now() - t1;
  return summary;
}

/** Raw multi-hop caller expansion over the engine's own edge tables. */
async function transitiveCallers(engine: any, seed: string, maxDepth: number) {
  const visited = new Set<string>([seed]);
  const edges: any[] = [];
  let frontier = [seed];
  for (let d = 1; d <= maxDepth; d++) {
    const next: string[] = [];
    for (const sym of frontier) {
      const rows = await engine.getCallersOf(sym, { sourceId: SOURCE, limit: 1000 });
      for (const e of rows) {
        const from = e.from_symbol_qualified;
        if (!from) continue;
        edges.push({ depth: d, query_symbol: sym, from_symbol: from, to_symbol: e.to_symbol_qualified, edge_type: e.edge_type, resolved: e.resolved, from_chunk_id: e.from_chunk_id });
        if (!visited.has(from)) { visited.add(from); next.push(from); }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  // File-level provenance: bare-name edge keying can conflate same-named
  // symbols across files, so attribute each caller edge to its owning page.
  const chunkIds = Array.from(new Set(edges.map((e) => e.from_chunk_id).filter((x) => typeof x === 'number')));
  if (chunkIds.length > 0) {
    const rows = await engine.executeRaw<{ id: number; slug: string }>(
      `SELECT cc.id, p.slug FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE cc.id = ANY($1::int[])`,
      [chunkIds],
    );
    const byId = new Map(rows.map((r) => [r.id, r.slug]));
    for (const e of edges) e.from_slug = byId.get(e.from_chunk_id) ?? null;
  }
  return edges;
}

async function query(engine: PGLiteEngine, symbol: string): Promise<any> {
  const ctx = ctxOf(engine);
  const callers = await operationsByName.code_callers.handler(ctx, { symbol, all_sources: true });
  const blast = await operationsByName.code_blast.handler(ctx, { symbol, depth: 8, max_nodes: 200, source_id: SOURCE });
  const raw = await transitiveCallers(engine, symbol, DEPTH);
  // sanity counts from the edge tables
  const counts = await engine.executeRaw(
    `SELECT
       (SELECT COUNT(*)::int FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.page_kind='code' AND p.source_id=$1) AS code_chunks,
       (SELECT COUNT(*)::int FROM code_edges_symbol WHERE source_id=$1) AS symbol_edges,
       (SELECT COUNT(*)::int FROM code_edges_chunk WHERE source_id=$1) AS chunk_edges,
       (SELECT COUNT(*)::int FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.page_kind='code' AND p.source_id=$1 AND cc.symbol_name_qualified IS NOT NULL) AS qualified_chunks`,
    [SOURCE],
  );
  return { symbol, source: SOURCE, counts: counts[0], op_code_callers: callers, op_code_blast: blast, raw_transitive_callers: raw };
}

async function main() {
  const mode = process.argv[2] ?? 'all';
  const symbol = process.argv[3];
  const engine = await connect();
  try {
    if (mode === 'build') {
      const s = await build(engine);
      const out = { mode: 'build', summary: s };
      if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
      console.log(JSON.stringify(out, null, 2));
    } else if (mode === 'query') {
      if (!symbol) { console.error('query requires <symbol>'); process.exit(2); }
      const out = { mode: 'query', ...(await query(engine, symbol)) };
      if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
      console.log(JSON.stringify(out, null, 2));
    } else if (mode === 'all') {
      const buildSummary = await build(engine);
      const q = symbol ? await query(engine, symbol) : null;
      const out = { mode: 'all', summary: buildSummary, query: q };
      if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.error(`unknown mode ${mode}`);
      process.exit(2);
    }
  } finally {
    await engine.disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
