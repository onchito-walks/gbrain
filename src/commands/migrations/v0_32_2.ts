/**
 * v0.32.2 migration orchestrator — facts join the system-of-record invariant.
 *
 * Schema migration v51 (src/core/migrate.ts) added the two fence columns
 * (row_num, source_markdown_slug) and the partial UNIQUE index. The
 * orchestrator's job is the data half: walk every existing pre-v51 row
 * in the facts table (row_num IS NULL = "no fence yet") and append it
 * to its entity page's `## Facts` fence, atomically + idempotently.
 *
 * Phases:
 *   A. Schema       — assert migration v51 has run.
 *   B. Fence facts  — backfill DB facts → entity-page fences (dry-run
 *                     by default; explicit --write required). Covers both
 *                     unfenced shapes: rows with no position yet, and rows
 *                     whose position the markdown no longer carries (the
 *                     page body was replaced or reverted after the stamp).
 *                     STRICT PRESERVATION: no original row is stamped,
 *                     renumbered, rewritten or expired and no page body gains
 *                     a fence. Each page's adopted positions and
 *                     codec-normalized text are published as that page's
 *                     separate DERIVED document (one page-scoped raw_data row
 *                     with explicit original-fact-to-derived-position
 *                     bindings), through the same owner/journal path.
 *   C. Verify       — compare the two coordinate systems independently.
 *                     Original: re-parse each page's own fence (the canonical
 *                     file, or the database copy on a managed brain) and
 *                     compare its row numbers with the DB rows for that page,
 *                     excluding the rows a CURRENT derived document binds. A
 *                     duplicate active fence row may be absent from the index
 *                     (extract_facts indexes it once). Partial on mismatch.
 *                     Derived: every document must still be the plan of its
 *                     page's current originals, every original fence row must
 *                     survive in it unchanged, and every binding must be
 *                     addressable at its own derived position. A document that
 *                     is no longer that plan fails the phase by name. Nothing
 *                     on this path writes.
 *                     Conversation-miner (`cli:`) rows are not
 *                     fence-owned (extract-conversation-facts writes the
 *                     chat log as source of truth) and are excluded from
 *                     BOTH sides: the database side always filtered the
 *                     prefix, so a fence row the database attributes to a
 *                     `cli:` row, or that carries a `cli:` source label, is
 *                     skipped the same way — like is compared with like
 *                     instead of reporting a page whose file and database
 *                     agree. Drift that matches a NAMED, evidenced,
 *                     field-for-field exception in `./v0_32_2-drift-exceptions.ts`
 *                     (accepted pre-existing production data conditions) is
 *                     tolerated — but never suppressed: the phase prints every
 *                     tolerated exception by name and carries it in its detail,
 *                     and any observation not named there still fails exactly
 *                     as before. The tolerance path only re-classifies an
 *                     observation; it writes nothing.
 *   D. Record       — runner-owned ledger write (apply-migrations.ts).
 *
 * Idempotency: phase B is additive — it only appends rows the page's fence
 * does not carry, and a row it already published reads back identical, so it
 * is skipped. Re-runs after a partial completion pick up where the previous
 * run stopped.
 * Phase B is the shared core pass `src/core/facts/unfenced-facts.ts`, which
 * the extract_facts cycle phase also runs: managed brains publish each page
 * through the coordinator (`managed_maintenance_publish_preserved_fence`) and
 * verify from the database; unmanaged pages publish through one maintenance
 * transaction under the page lock. The migration adds a dirty-tree refusal
 * that mirrors src/core/dry-fix.ts so the user can review the diff before
 * committing.
 *
 * Facts with NULL entity_slug are structurally unfenceable (no page to
 * fence onto). They're skipped with a warning; the operator decides
 * whether to hand-curate or delete them. Their row_num stays NULL
 * forever; they live in the legacy keyspace permanently.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { parseFactsFence, type ParsedFact } from '../../core/facts-fence.ts';
import { duplicateActiveFenceRows } from '../../core/facts/extract-from-fence.ts';
import { resolvePageWriteTarget } from '../../core/write-through.ts';
import { serializePageToMarkdown } from '../../core/markdown.ts';
import { managedPersistenceEnabled } from '../../core/persistence/ownership.ts';
import { stableJson } from '../../core/persistence/digest.ts';
import { OperationError } from '../../core/ops/contract.ts';
import { fenceableRowCount, fenceUnfencedFacts, planUnfencedFacts, type UnfencedFactsOutcome } from '../../core/facts/unfenced-facts.ts';
import { PRESERVED_FENCE_SOURCE, preservedFencePublicationState } from '../../core/facts/preserved-fence-store.ts';
import type { PreservedFencePublication } from '../../core/facts/preserved-fence-publication.ts';
import {
  describeToleratedDrift,
  formatToleratedDriftReport,
  matchFenceDriftException,
  type FenceDriftException,
  type FenceDriftObservation,
} from './v0_32_2-drift-exceptions.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function getEngine(): Promise<BrainEngine | null> {
  if (testEngineOverride) return testEngineOverride;
  try {
    const cfg = loadConfig();
    if (!cfg) return null;
    const engineConfig = toEngineConfig(cfg);
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return engine;
  } catch {
    return null;
  }
}

// ── Phase A — Schema verify ────────────────────────────────

async function phaseASchema(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  if (!engine) {
    return { name: 'schema', status: 'skipped', detail: 'no_brain_configured' };
  }
  try {
    const versionStr = await engine.getConfig('version');
    const v = parseInt(versionStr || '0', 10);
    if (v < 51) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 51 (facts_fence_columns); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Quick post-condition: row_num + source_markdown_slug exist on facts.
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name IN ('row_num', 'source_markdown_slug')`,
    );
    if (rows.length < 2) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected columns row_num + source_markdown_slug on facts; found ${rows.map(r => r.column_name).join(', ') || 'none'}`,
      };
    }
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Fence facts ──────────────────────────────────

/**
 * Dirty-tree refusal: mirror src/core/dry-fix.ts behavior. Refuses to
 * write if any source's local_path has uncommitted changes. Dry-run
 * skips this check (no writes happen anyway).
 */
function isLocalPathDirty(localPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain', '--', '.'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo OR git not on PATH → treat as "not dirty" (the
    // user opted out of git tracking, which is allowed). The fence
    // writes are still atomic via .tmp + rename.
    return false;
  }
}

/**
 * Fence every unfenced row through the shared core pass
 * (`src/core/facts/unfenced-facts.ts`, also run by the extract_facts cycle
 * phase). The migration adds only its dirty-tree refusal on unmanaged
 * sources, so the user can review the diff before committing.
 */
async function phaseBFenceFacts(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (!engine) {
    return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
  }

  try {
    // `adoptStamped`: the backfill also publishes rows that already hold a
    // fence position the markdown lost, so this migration leaves every active
    // database fact present in the fence instead of dangling until the
    // reconcile walk retires it.
    const plan = await planUnfencedFacts(engine, { adoptStamped: true });
    const { outcome } = plan;

    if (opts.dryRun) {
      return {
        name: 'fence_facts', status: 'skipped',
        detail: `dry-run: would fence ${fenceableRowCount(plan)} rows; ${outcome.skipped_no_entity} unfenceable (NULL entity_slug); ` +
          `skipped_no_page=${outcome.skipped_no_page} skipped_no_local_path=${outcome.skipped_no_local_path}`,
      };
    }

    if (!plan.managed) {
      // Dirty-tree refusal: check ONLY the sources we are about to write
      // into. A dirty tree in an unrelated source (or zero fenceable rows
      // at all) must not block a no-op or a targeted backfill (#927).
      const targetSourceIds = new Set([...plan.groups.keys()].map(k => k.split('\0')[0]));
      for (const id of targetSourceIds) {
        const localPath = plan.localPathById.get(id);
        if (localPath && isLocalPathDirty(localPath)) {
          return {
            name: 'fence_facts',
            status: 'failed',
            detail: `source "${id}" has uncommitted changes in ${localPath}. Commit or stash, then re-run.`,
          };
        }
      }
    }

    // `allowSupersede`: this migration's job is to publish the CURRENT
    // originals into the page's derived representation. A document left by an
    // earlier run whose originals have moved on is therefore brought up to date
    // by replanning from the current originals — never by rewriting, expiring
    // or renumbering an original row, which stays byte-identical either way.
    try { await fenceUnfencedFacts(engine, plan, { allowSupersede: true }); }
    catch (error) {
      if (!(error instanceof OperationError) || error.code !== 'queue_capacity') throw error;
      return { name: 'fence_facts', status: 'failed', detail: `queue_capacity: ${error.message} ${error.suggestion ?? ''}`.trim() };
    }
    return fenceFactsResult(outcome);
  } catch (e) {
    return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

function fenceFactsResult(outcome: UnfencedFactsOutcome): OrchestratorPhaseResult {
  const detail = `scanned=${outcome.scanned} fenced=${outcome.fenced} ` +
    `pages=${outcome.pages_touched} skipped_no_entity=${outcome.skipped_no_entity} ` +
    `skipped_no_local_path=${outcome.skipped_no_local_path} skipped_no_page=${outcome.skipped_no_page}` +
    (outcome.skipped_archived > 0 ? ` skipped_archived=${outcome.skipped_archived}` : '') +
    (outcome.adopted_in_place ? ` adopted_in_place=${outcome.adopted_in_place}` : '') +
    (outcome.renumbered ? ` renumbered=${outcome.renumbered}` : '') +
    (outcome.failed_pages.length > 0 ? ` failed=${outcome.failed_pages.length}` : '');
  if (outcome.failed_pages.length > 0) {
    // The same `FACTS_FENCE_FAILED: <slug> (<reason>)` token the extract_facts
    // cycle phase prints, so an unadoptable row reads the same in both outputs.
    const failed = outcome.failed_pages.map(page => `FACTS_FENCE_FAILED: ${page}`);
    return {
      name: 'fence_facts',
      status: 'failed',
      detail: `${detail} :: ${failed.slice(0, 3).join(' | ')}${failed.length > 3 ? '...' : ''}`,
    };
  }
  return { name: 'fence_facts', status: 'complete', detail };
}

interface SourceLookup {
  id: string;
  local_path: string | null;
}

// ── Phase C — Verify ────────────────────────────────────────

/** Row numbers a drift detail names per side before it summarizes the rest. */
const DRIFT_ROWS_SHOWN = 5;

function listDriftRows(rows: number[]): string {
  const shown = rows.slice(0, DRIFT_ROWS_SHOWN).join(', ');
  return rows.length > DRIFT_ROWS_SHOWN ? `${shown}, +${rows.length - DRIFT_ROWS_SHOWN} more` : shown;
}

/** The `cli:` source prefix of the conversation miner (`extract-conversation-facts`). */
const CONVERSATION_MINER_PREFIX = 'cli:';

/**
 * A fence row that belongs to the conversation-miner domain: the database
 * attributes its position to a `cli:` row, or the cell carries the `cli:`
 * label the renderer projected from that row. The database side of the
 * comparison filters the same prefix, so skipping these on the file side
 * compares like with like — without it every page whose fence legitimately
 * carries conversation facts is reported as drifted.
 */
function isConversationMinerFenceRow(fact: ParsedFact, cliRowNums: ReadonlySet<number>): boolean {
  return cliRowNums.has(fact.rowNum) || (fact.source ?? '').startsWith(CONVERSATION_MINER_PREFIX);
}

/**
 * The derived coordinate system, verified independently of the replan: every
 * CLAIM the ORIGINAL fence carries must survive in the derived document as an
 * active row with the same source (its position may move — that is exactly what
 * a position the index already holds forces, and the derived document is where
 * the move is recorded), and every binding the document publishes must be
 * addressable in it at its own derived position with its own derived claim.
 * Returns the mismatch, or null when the two agree.
 */
function derivedCoordinateMismatch(publication: PreservedFencePublication, originalFence: ParsedFact[],
  cliRowNums: ReadonlySet<number>): string | null {
  const derived = parseFactsFence(publication.derived_body);
  if (derived.warnings.length > 0) return `the derived document does not parse (${derived.warnings.join('; ')})`;
  const byPosition = new Map(derived.facts.map(row => [row.rowNum, row]));
  const carried = new Set(derived.facts.filter(row => row.active).map(row => `${row.claim}\u0000${row.source ?? ''}`));
  for (const row of originalFence) {
    if (isConversationMinerFenceRow(row, cliRowNums)) continue;
    const at = byPosition.get(row.rowNum);
    const unchanged = at !== undefined && at.active === row.active && at.claim === row.claim && (at.source ?? '') === (row.source ?? '');
    if (unchanged) continue;
    if (carried.has(`${row.claim}\u0000${row.source ?? ''}`)) continue;
    return `original fence row ${row.rowNum} (${row.claim}) is not carried by the derived document`;
  }
  for (const binding of publication.bindings) {
    const row = byPosition.get(binding.derived_row_num);
    if (!row || !row.active || row.claim !== binding.derived_claim) {
      return `binding for original fact ${binding.original_fact_id} is not addressable at derived position ${binding.derived_row_num}`;
    }
  }
  return null;
}

async function phaseCVerify(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'verify', status: 'skipped', detail: 'no_brain_configured' };

  try {
    // Per touched page (= any page with a fenced row in the DB), re-parse
    // the fence (the canonical file, or the database copy on a managed
    // brain) and compare its row numbers to the DB's.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    // Conversation-miner rows stamp row_num without a ## Facts fence
    // (chat-log shape is the source of truth). Same cli: exclusion as
    // extract_facts reconciliation. Counting them here fails every brain
    // that ran extract-conversation-facts. Both arrays come from the same
    // read so the file side can skip exactly the positions the database
    // attributes to that domain (see isConversationMinerFenceRow).
    const groups = await engine.executeRaw<{ source_id: string; source_markdown_slug: string; ids: number[] | null; row_nums: number[] | null; cli_row_nums: number[] | null }>(
      `SELECT source_id, source_markdown_slug,
              array_agg(id ORDER BY row_num) FILTER (WHERE COALESCE(source, '') NOT LIKE 'cli:%') AS ids,
              array_agg(row_num ORDER BY row_num) FILTER (WHERE COALESCE(source, '') NOT LIKE 'cli:%') AS row_nums,
              array_agg(row_num ORDER BY row_num) FILTER (WHERE COALESCE(source, '') LIKE 'cli:%') AS cli_row_nums
         FROM facts
        WHERE row_num IS NOT NULL
        GROUP BY source_id, source_markdown_slug`,
    );

    const mismatches: string[] = [];
    /** Pages already compared by the group walk below, so none is counted twice. */
    const covered = new Set<string>();
    // Named, evidenced, field-for-field exceptions (accepted pre-existing data
    // conditions). Tolerated observations are reported by name below — never
    // dropped, never suppressed, and nothing is written on this path.
    const tolerated: FenceDriftException[] = [];
    let pagesChecked = 0;
    // Managed brains publish the fence through the coordinator, which writes
    // the canonical file in the same publication; the database copy is the
    // one every managed page has, database-only pages included.
    const managed = await managedPersistenceEnabled(engine);

    /**
     * Route one observation: an exact match on the named exception list is
     * tolerated and reported; everything else is drift and fails the phase.
     * The list is consulted, never applied by category — see
     * `./v0_32_2-drift-exceptions.ts` for the matching rules.
     */
    const classify = (observed: FenceDriftObservation, mismatch: string): void => {
      const exception = matchFenceDriftException(observed);
      if (exception) {
        if (!tolerated.includes(exception)) tolerated.push(exception);
        return;
      }
      mismatches.push(mismatch);
    };

    for (const g of groups) {
      const positions = (g.row_nums ?? []).map(Number);
      const ids = (g.ids ?? []).map(String);
      const key = `${g.source_id}\u0000${g.source_markdown_slug}`;
      // Strict preservation: a row a CURRENT derived document binds is compared
      // against its DERIVED coordinate, not against the fence. A stored document
      // that is no longer the plan of the page's current originals is drift and
      // fails this phase by name; nothing is written on this path.
      const derived = await preservedFencePublicationState(engine, g.source_id, g.source_markdown_slug);
      if (derived.state === 'drifted') {
        mismatches.push(`${g.source_markdown_slug} (derived document is not the plan of its current originals: ${derived.reason})`);
        pagesChecked += 1;
        covered.add(key);
        continue;
      }
      if (positions.length === 0 && derived.state === 'none') continue;
      const cliRowNums = new Set((g.cli_row_nums ?? []).map(Number));
      const allRows = [...new Set(positions)].sort((a, b) => a - b);
      let body: string;
      if (managed) {
        const snapshot = await engine.readPageSnapshot(g.source_markdown_slug, { sourceId: g.source_id });
        if (!snapshot) {
          classify(
            { kind: 'page_missing', sourceId: g.source_id, slug: g.source_markdown_slug, surface: 'page', rows: allRows },
            `${g.source_markdown_slug} (page missing)`,
          );
          covered.add(key);
          continue;
        }
        body = serializePageToMarkdown(snapshot.page, snapshot.tags);
      } else {
        const localPath = localPathById.get(g.source_id);
        if (!localPath) continue;
        const target = await resolvePageWriteTarget(engine, g.source_markdown_slug, g.source_id);
        if (!target.ok || !existsSync(target.filePath)) {
          classify(
            { kind: 'page_missing', sourceId: g.source_id, slug: g.source_markdown_slug, surface: 'file', rows: allRows },
            `${g.source_markdown_slug} (file missing)`,
          );
          covered.add(key);
          continue;
        }
        body = readFileSync(target.filePath, 'utf-8');
      }
      const parsed = parseFactsFence(body);
      // A bound row is compared at its DERIVED coordinate: when the page's fence
      // carries that position, the row is one of the fence's own rows and is
      // compared here as before; when it does not (an adopted row, a position
      // the markdown lost, a collision the document resolves), it is verified on
      // the derived side instead and is never counted as fence drift.
      // A bound row is exempt exactly when the page's own fence does not carry
      // its original position: that is the shape this comparison would
      // otherwise report as a row the fence lacks, and its representation is
      // verified on the derived side instead. A bound row AT a fence position
      // is one of the fence's own rows and is compared here as before.
      const bound = derived.state === 'current' ? derived.boundFactIds : null;
      const fencePositions = new Set(parsed.facts.map(row => row.rowNum));
      const indexed = new Set<number>();
      for (let i = 0; i < positions.length; i++) {
        if (bound?.has(ids[i]!) && !fencePositions.has(positions[i]!)) continue;
        indexed.add(positions[i]!);
      }
      // A preserved NULL-position import can already match an original fence
      // cell. Its verified derived binding is the index entry; stamping the
      // original just to make this comparison pass would violate preservation.
      // Count only a bound cell that is literally the same parsed original row,
      // never every row carried by the derived document (some are unindexed).
      if (derived.state === 'current') {
        const originalAt = new Map(parsed.facts.map(row => [row.rowNum, row]));
        const derivedAt = new Map(parseFactsFence(derived.publication.derived_body).facts.map(row => [row.rowNum, row]));
        for (const binding of derived.publication.bindings) {
          const original = originalAt.get(binding.derived_row_num);
          const cell = derivedAt.get(binding.derived_row_num);
          if (original && cell && stableJson(original) === stableJson(cell)) indexed.add(binding.derived_row_num);
        }
      }
      if (indexed.size === 0 && derived.state === 'none') continue;
      const fenced = new Set(parsed.facts.filter(f => !isConversationMinerFenceRow(f, cliRowNums)).map(f => f.rowNum));
      // #5814: a duplicate active row may be absent from the index.
      // extract_facts indexes it once (#1781) while the managed publication
      // projection indexes every fence row, so both states are in sync.
      const duplicates = duplicateActiveFenceRows(parsed.facts);
      const notIndexed = [...fenced].filter(n => !indexed.has(n) && !duplicates.has(n)).sort((a, b) => a - b);
      const notInFence = [...indexed].filter(n => !fenced.has(n)).sort((a, b) => a - b);
      if (notIndexed.length > 0 || notInFence.length > 0) {
        const missing = [
          notIndexed.length > 0 ? `not indexed: ${listDriftRows(notIndexed)}` : '',
          notInFence.length > 0 ? `not in fence: ${listDriftRows(notInFence)}` : '',
        ].filter(Boolean).join('; ');
        classify(
          {
            kind: 'fence_divergence', sourceId: g.source_id, slug: g.source_markdown_slug,
            surface: managed ? 'page' : 'file',
            fence: parsed.facts.length, db: indexed.size, notIndexed, notInFence,
          },
          `${g.source_markdown_slug} (fence=${parsed.facts.length}, db=${indexed.size}; ${missing})`,
        );
      } else if (derived.state === 'current') {
        // The other coordinate system, verified independently: the document is
        // the plan of the current originals (replanned above), and every row the
        // original fence carries must survive in it unchanged while every
        // binding it publishes must be addressable in it.
        const derivedMismatch = derivedCoordinateMismatch(derived.publication, parsed.facts, cliRowNums);
        if (derivedMismatch) mismatches.push(`${g.source_markdown_slug} (derived: ${derivedMismatch})`);
      }
      pagesChecked += 1;
      covered.add(key);
    }

    // A page whose adopted rows hold no position at all appears in no group
    // above. Every stored document is verified here anyway, so a page the
    // backfill published is never left unchecked.
    const published = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT p.source_id, p.slug FROM raw_data rd JOIN pages p ON p.id = rd.page_id
        WHERE rd.source = $1 AND p.deleted_at IS NULL ORDER BY p.source_id, p.slug`,
      [PRESERVED_FENCE_SOURCE],
    );
    for (const page of published) {
      if (covered.has(`${page.source_id}\u0000${page.slug}`)) continue;
      const derived = await preservedFencePublicationState(engine, page.source_id, page.slug);
      if (derived.state === 'none') continue;
      pagesChecked += 1;
      if (derived.state === 'drifted') {
        mismatches.push(`${page.slug} (derived document is not the plan of its current originals: ${derived.reason})`);
        continue;
      }
      let body: string | null = null;
      if (managed) {
        const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
        if (snapshot) body = serializePageToMarkdown(snapshot.page, snapshot.tags);
      } else {
        const target = await resolvePageWriteTarget(engine, page.slug, page.source_id);
        if (target.ok && existsSync(target.filePath)) body = readFileSync(target.filePath, 'utf-8');
      }
      if (body === null) continue;
      const mismatch = derivedCoordinateMismatch(derived.publication, parseFactsFence(body).facts, new Set());
      if (mismatch) mismatches.push(`${page.slug} (derived: ${mismatch})`);
    }

    // An accepted condition is still an observed one: say so by name, on every
    // run that sees it, whether or not the phase ends complete.
    if (tolerated.length > 0) console.log(formatToleratedDriftReport(tolerated));

    if (mismatches.length > 0) {
      const toleratedNote = tolerated.length > 0
        ? `; tolerated ${tolerated.length} named pre-existing exception(s): ${tolerated.map(e => e.slug).join(', ')}`
        : '';
      return {
        name: 'verify',
        status: 'failed',
        detail: `${mismatches.length} pages drifted: ${mismatches.slice(0, 3).join(' | ')}${mismatches.length > 3 ? '...' : ''}${toleratedNote}`,
      };
    }
    // The detail stays exactly `pages_checked=N` when nothing was tolerated,
    // so an unchanged run reads unchanged; tolerated exceptions are named in
    // full, never summarized away.
    const toleratedNote = tolerated.length > 0
      ? `; tolerated ${tolerated.length} named pre-existing-drift exception(s): ${tolerated
          .map(e => `${e.slug} (${describeToleratedDrift(e)})`).join(' | ')}`
      : '';
    return { name: 'verify', status: 'complete', detail: `pages_checked=${pagesChecked}${toleratedNote}` };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.32.2 — facts join the system-of-record invariant ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const engine = await getEngine();
  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(engine, opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const b = await phaseBFenceFacts(engine, opts);
  phases.push(b);
  if (b.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const c = await phaseCVerify(engine, opts);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus, engine);
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
  engine: BrainEngine | null,
): OrchestratorResult {
  // Best-effort disconnect of the engine we created. testEngineOverride
  // is owned by the test, never disconnected here.
  if (engine && !testEngineOverride) {
    engine.disconnect().catch(() => { /* best-effort */ });
  }
  return {
    version: '0.32.2',
    status,
    phases,
  };
}

export const v0_32_2: Migration = {
  version: '0.32.2',
  fresh_install_noop: true,
  featurePitch: {
    headline: 'Facts join the system-of-record — your hot memory now lives in markdown, indexed by the DB',
    description:
      'v0.31 added hot-memory facts but they lived only in the database. v0.32.2 makes the ' +
      'fenced `## Facts` table on each entity page canonical: every new fact writes to markdown ' +
      'first, then stamps the DB index. Existing v0.31 facts are backfilled to fences on this ' +
      'migration. `gbrain rebuild` (v0.32.3) becomes a one-line disaster-recovery flow because ' +
      'the DB is now fully derivable from the repo. Migration is dry-run by default; pass ' +
      '`--write` to apply.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBFenceFacts,
  phaseCVerify,
  isLocalPathDirty,
};
