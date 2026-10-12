# codegraph-probe — local-only disposable-brain code-graph probe

Reusable, **local-only** probe that builds the native GBrain tree-sitter call
graph for a checkout's source tree inside a **throwaway PGLite brain** and then
exercises the native code-intel operations (`code_callers`, `code_blast`) plus a
raw multi-hop caller expansion with file-level provenance.

It exists so that transitive caller/callee questions can be answered from the
*real* tree-sitter graph (edge tables `code_edges_symbol` / `code_edges_chunk`)
rather than by regex, without touching the live brain or weakening the
agent-facing (remote) read suspension.

## Safety

- Reads only files under `CG_ROOT` inside this worktree.
- Writes only to the PGLite data dir named by `CG_DB` — point it at a disposable
  dir and delete it when done. **Never** point it at the live brain.
- No network, no embeddings (`noEmbed: true`), no live-source imports, no entity
  extraction.
- Invokes ops with `remote: false` (the trusted local CLI-equivalent context).
  The agent-facing code-read suspension in `src/core/ops/code-intel.ts` is left
  intact — no auth/security policy is modified.

## Usage

```bash
export SCRATCH=/path/to/disposable
# 1. disposable brain (offline, no embeddings):
GBRAIN_HOME="$SCRATCH/home" bun src/cli.ts init --pglite --no-embedding --json

# 2. build the graph into it (indexes CG_ROOT, resolves edges):
CG_DB="$SCRATCH/home/.gbrain/brain.pglite" CG_ROOT=src \
  CG_OUT="$SCRATCH/build.json" bun tools/codegraph-probe.ts build

# 3. query it (op handlers + raw transitive expansion with from_slug):
CG_DB="$SCRATCH/home/.gbrain/brain.pglite" \
  CG_OUT="$SCRATCH/query.json" bun tools/codegraph-probe.ts query findMisroutedPages

# 4. native CLI over the SAME disposable brain:
GBRAIN_HOME="$SCRATCH/home" bun src/cli.ts code-callers findMisroutedPages --all-sources --json
GBRAIN_HOME="$SCRATCH/home" bun src/cli.ts call code_blast '{"symbol":"findMisroutedPages","depth":8,"source_id":"default"}'
```

Env: `CG_DB` (required), `CG_ROOT` (default `src`), `CG_SOURCE` (default
`default`), `CG_OUT`, `CG_DEPTH` (default 6).

## What the graph covers, and its honest gaps

- **Edges** are extracted by `src/core/chunkers/edge-extractor.ts` at import
  time. A `calls` edge is keyed on the **bare callee token** unless the v0.34
  receiver-type resolver lands a qualified name (`module::fn` / `Class::method`).
- The second pass (`src/core/chunkers/symbol-resolver.ts`) only resolves edges
  **within the same file** and stamps `content_chunks.edges_backfilled_at`; it
  does **not** rewrite `to_symbol_qualified`, so cross-file callers are matched
  by the bare name in `getCallersOf`/`getCalleesOf`.
- **Consequence — bare-name collisions.** Two unrelated symbols with the same
  name (e.g. `runDoctor` exists in `src/commands/doctor.ts`,
  `src/core/skillpack/doctor.ts`, and `src/commands/skillpack-check.ts`) are
  conflated into one graph node, producing **false-positive** transitive
  callers. The probe therefore also reports `from_slug` (the owning page of each
  caller edge) so callers can be attributed to the right definition.
- **Consequence — chain breaks at nested/method symbols.** A caller edge's
  `from_symbol_qualified` is the enclosing chunk's qualified name; if downstream
  code calls that symbol by a different spelling than the qualified name, the
  next hop misses. Method-to-method cross-file calls (receiver unresolved →
  bare token vs. qualified `Class::method`) frequently break the walk.
