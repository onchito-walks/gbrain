/**
 * Operator quarantine-set — first-class, fail-closed metadata-only repair lane
 * for the wrong-root DB-only sync incident.
 *
 * WHY THIS EXISTS
 * ---------------
 * A wrong-root `gbrain sync --repo <parent>` inserted thousands of DB-only
 * pages (source_id `default`) whose recorded `source_path` resolves to NO
 * file under the canonical source root. They are junk that must be hidden
 * from search, but they are NOT in the git-managed worktree, so the ordinary
 * content-repair surfaces all misbehave:
 *   - a bulk `gbrain import` / source cycle BYPASSES the git-managed source
 *     owner gate and can rewrite content/aliases/chunks — rejected;
 *   - a generic page write goes through the owner/coordinator mutation path
 *     (`submitPageMutation`) which is `owner_unavailable` here — unusable;
 *   - declaring the wrong-root namespaces `storage.db_only` would falsely
 *     legitimize the import and mask the doctor warning — rejected.
 *
 * This module is the narrow, opt-in alternative: it applies ONLY the existing
 * `frontmatter.quarantine` marker (the marker the search filter already
 * honours) to an EXACT, immutable manifest of (id, slug, source_id,
 * content_hash, source_path) rows — no content, no file, no alias, no chunk
 * rewrite. The marker write:
 *   - leaves `content_hash` byte-for-byte unchanged (the marker key is in
 *     HASH_EPHEMERAL_FRONTMATTER_KEYS, and we never touch the column at all);
 *   - leaves `content_chunks`, `page_aliases`, `extract_atoms_page_state`
 *     untouched;
 *   - advances the per-row `pages.generation` AND the global
 *     `page_generation_clock` via the existing triggers, so query caches
 *     invalidate without a schema change;
 *   - removes the `page_projection_jobs` row its own frontmatter write
 *     queues, so the marker leaves NO collateral work behind.
 *
 * FAIL-CLOSED CONTRACT
 * --------------------
 * The whole manifest is the unit of work. Any parse error, any duplicate id,
 * any row that does not match the DB on id+slug+source_id+content_hash+
 * source_path, any canonical-file-backed page, any row whose source has no
 * resolvable root, any pending projection job, or a batch over the hard cap
 * aborts the ENTIRE run — nothing is applied and nothing is rolled back
 * implicitly.
 *
 * SCOPE / TRUST
 * -------------
 * Operator-only, trusted-local, host-bound. The CLI (`gbrain quarantine set`)
 * refuses the thin-client MCP path and requires `--reason` from a fixed
 * allowlist plus `--yes`. This is a deliberate, incident-scoped operator
 * action — NOT a generic bypass of the owner gate.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import { resolveSourceLocalFilePath } from './markdown.ts';
import { QUARANTINE_KEY } from './quarantine.ts';
import { executeRawJsonb } from './sql-query.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';

/** Closed allowlist of operator reasons. Adding one is a deliberate change. */
export const OPERATOR_QUARANTINE_REASONS = ['wrong-root-sync'] as const;
export type OperatorQuarantineReason = (typeof OPERATOR_QUARANTINE_REASONS)[number];

/** Hard upper bound on a single manifest. Bigger sets must be split. */
export const QUARANTINE_SET_HARD_CAP = 10_000;

/** Bounded lock/statement waits for the single atomic operator transaction.
 *  A metadata lane must never pin a row (or a whole table) behind an
 *  unbounded wait if a writer holds it. */
export const OPERATOR_TX_LOCK_TIMEOUT = '5s';
export const OPERATOR_TX_STATEMENT_TIMEOUT = '120s';

export class OperatorQuarantineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OperatorQuarantineError';
  }
}

/** One immutable manifest row. JSONL, one object per line. */
export interface OperatorManifestRecord {
  id: number;
  slug: string;
  source_id: string;
  /** Expected sha256 of the page at manifest capture time. */
  content_hash: string;
  /** Recorded source path (may contain commas/spaces — never CSV). */
  source_path: string;
}

export interface OperatorQuarantineMarker {
  reason: string;
  detail: string;
  assessed_at: string;
  /** Provenance discriminator: distinguishes an operator incident hold from
   *  a content-quality-gate junk marker, so rollback can be bound to THIS
   *  write and never clear a legitimately gate-set marker. */
  operator: true;
  incident: string;
  manifest_sha256: string;
}

export interface OperatorPlanRow extends OperatorManifestRecord {
  generation: number;
  updated_at: string;
}

export interface OperatorPlanRejection {
  id: number;
  slug: string;
  reason: string;
  detail?: string;
}

export interface OperatorQuarantinePlan {
  source_id: string;
  source_root: string | null;
  manifest_sha256: string;
  eligible: OperatorPlanRow[];
  /** Rows already carrying a quarantine marker (idempotent skip, not error). */
  already: OperatorManifestRecord[];
  rejections: OperatorPlanRejection[];
}

export interface OperatorSnapshotRow extends OperatorPlanRow {
  marker: OperatorQuarantineMarker;
}

export interface OperatorQuarantineSnapshot {
  schema_version: 1;
  reason: string;
  incident: string;
  source_id: string;
  manifest_sha256: string;
  created_at: string;
  rows: OperatorSnapshotRow[];
  /** Path to the archived raw manifest JSONL (written 0600 next to the
   *  snapshot). Optional so a hand-authored snapshot stays loadable; when
   *  present, rollback re-verifies the archive's sha256 before clearing. */
  manifest_path?: string;
}

export interface OperatorQuarantineOptions {
  sourceId?: string;
  reason: OperatorQuarantineReason | string;
  incident: string;
  manifestSha256: string;
  now?: Date;
}

const HEX64 = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Marker
// ---------------------------------------------------------------------------

export function buildOperatorQuarantineMarker(
  reason: string,
  opts: { incident: string; manifestSha256: string; detail?: string; now?: Date },
): OperatorQuarantineMarker {
  return {
    reason,
    detail: opts.detail ?? `incident:${opts.incident}`,
    assessed_at: (opts.now ?? new Date()).toISOString(),
    operator: true,
    incident: opts.incident,
    manifest_sha256: opts.manifestSha256,
  };
}

// ---------------------------------------------------------------------------
// Manifest parsing (fail-closed)
// ---------------------------------------------------------------------------

/** Parse a JSONL manifest. Throws OperatorQuarantineError on ANY malformed
 *  line, missing/invalid field, duplicate id, or an empty manifest — the
 *  whole set is rejected, never a partial parse. */
export function parseOperatorManifest(text: string): { records: OperatorManifestRecord[]; sha256: string } {
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const records: OperatorManifestRecord[] = [];
  const seenId = new Set<number>();
  const seenKey = new Set<string>();
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    lineNo++;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new OperatorQuarantineError('manifest_parse', `manifest line ${lineNo}: not valid JSON`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new OperatorQuarantineError('manifest_parse', `manifest line ${lineNo}: expected a JSON object`);
    }
    const r = obj as Record<string, unknown>;
    const id = typeof r.id === 'number' ? r.id : Number(r.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new OperatorQuarantineError('manifest_parse', `manifest line ${lineNo}: id must be a positive integer`);
    }
    const slug = typeof r.slug === 'string' ? r.slug : '';
    if (!slug.trim() || slug !== slug.trim() || slug.includes('\0')) {
      throw new OperatorQuarantineError('manifest_parse', `manifest line ${lineNo}: slug must be a trimmed non-empty string`);
    }
    const sourceIdRaw = r.source_id;
    const source_id = sourceIdRaw === undefined ? 'default' : (typeof sourceIdRaw === 'string' ? sourceIdRaw.trim() : '');
    if (!source_id) {
      throw new OperatorQuarantineError('manifest_parse', `manifest line ${lineNo}: source_id must be a non-empty string`);
    }
    const content_hash = typeof r.content_hash === 'string' ? r.content_hash.trim().toLowerCase() : '';
    if (!HEX64.test(content_hash)) {
      throw new OperatorQuarantineError('manifest_parse', `manifest line ${lineNo}: content_hash must be a 64-hex sha256`);
    }
    const source_path = typeof r.source_path === 'string' ? r.source_path : '';
    if (!source_path.trim() || source_path.includes('\0')) {
      throw new OperatorQuarantineError('manifest_parse', `manifest line ${lineNo}: source_path must be a non-empty string`);
    }
    if (seenId.has(id)) throw new OperatorQuarantineError('manifest_duplicate', `manifest line ${lineNo}: duplicate id ${id}`);
    const key = `${source_id}\0${slug}`;
    if (seenKey.has(key)) throw new OperatorQuarantineError('manifest_duplicate', `manifest line ${lineNo}: duplicate (source_id, slug) ${source_id}/${slug}`);
    seenId.add(id);
    seenKey.add(key);
    records.push({ id, slug, source_id, content_hash, source_path });
  }
  if (records.length === 0) {
    throw new OperatorQuarantineError('manifest_empty', 'manifest has no records');
  }
  if (records.length > QUARANTINE_SET_HARD_CAP) {
    throw new OperatorQuarantineError(
      'manifest_too_large',
      `manifest has ${records.length} records (hard cap ${QUARANTINE_SET_HARD_CAP}); split it`,
    );
  }
  return { records, sha256 };
}

// ---------------------------------------------------------------------------
// Verification (read-only)
// ---------------------------------------------------------------------------

interface PageRow {
  id: number;
  slug: string;
  source_id: string;
  content_hash: string | null;
  source_path: string | null;
  page_kind: string;
  frontmatter: Record<string, unknown> | null;
  generation: number;
  updated_at: unknown;
}

function intList(ids: readonly number[]): string {
  // ids are validated positive integers (manifest parse) — safe to inline.
  return ids.join(',');
}

async function resolveSourceRoot(
  engine: BrainEngine,
  sourceId: string,
): Promise<{ root: string | null; archived: boolean; exists: boolean }> {
  const rows = await engine.executeRaw<{ local_path: string | null; archived: boolean }>(
    `SELECT local_path, archived FROM sources WHERE id=$1`,
    [sourceId],
  );
  if (!rows.length) return { root: null, archived: false, exists: false };
  let root = rows[0]!.local_path ?? null;
  if (!root) root = await engine.getConfig('sync.repo_path');
  return { root, archived: !!rows[0]!.archived, exists: true };
}

/** Read-only verification of the exact manifest against the live DB. Shared
 *  by the dry-run plan and the transactional apply (which re-runs it inside
 *  the transaction to close the plan→apply TOCTOU window). */
async function verifyRecords(
  engine: BrainEngine,
  records: readonly OperatorManifestRecord[],
  sourceId: string,
  sourceRoot: string | null,
  opts: { forUpdate?: boolean } = {},
): Promise<OperatorQuarantinePlan> {
  const ids = records.map((r) => r.id);
  const rows = await engine.executeRaw<PageRow>(
    `SELECT id, slug, source_id, content_hash, source_path, page_kind, frontmatter, generation, updated_at
       FROM pages WHERE id IN (${intList(ids)})${opts.forUpdate ? ' FOR UPDATE' : ''}`,
  );
  const byId = new Map<number, PageRow>(rows.map((r) => [Number(r.id), r]));

  const eligible: OperatorPlanRow[] = [];
  const already: OperatorManifestRecord[] = [];
  const rejections: OperatorPlanRejection[] = [];
  const reject = (r: OperatorManifestRecord, reason: string, detail?: string) =>
    rejections.push({ id: r.id, slug: r.slug, reason, ...(detail ? { detail } : {}) });

  for (const r of records) {
    const row = byId.get(r.id);
    if (!row) { reject(r, 'missing_page'); continue; }
    if (row.source_id !== sourceId || r.source_id !== sourceId) {
      reject(r, 'source_mismatch', `expected ${sourceId}`); continue;
    }
    if (row.slug !== r.slug) { reject(r, 'slug_mismatch', `db=${row.slug}`); continue; }
    if (!row.content_hash || row.content_hash !== r.content_hash) {
      reject(r, 'content_hash_mismatch'); continue;
    }
    if (!row.source_path || row.source_path !== r.source_path) {
      reject(r, 'source_path_mismatch'); continue;
    }
    if (row.page_kind !== 'markdown') { reject(r, 'non_markdown_page', row.page_kind); continue; }
    const fm = row.frontmatter ?? {};
    const prior = (fm as Record<string, unknown>)[QUARANTINE_KEY];
    if (prior !== undefined && prior !== null) {
      already.push(r);
      continue;
    }
    if (!sourceRoot) { reject(r, 'no_source_root'); continue; }
    const resolved = resolveSourceLocalFilePath(sourceRoot, row.source_path, r.slug);
    if (resolved && existsSync(resolved)) {
      reject(r, 'canonical_file_backed', resolved);
      continue;
    }
    eligible.push({
      ...r,
      generation: Number(row.generation),
      updated_at: row.updated_at == null ? '' : String(row.updated_at),
    });
  }

  return { source_id: sourceId, source_root: sourceRoot, manifest_sha256: '', eligible, already, rejections };
}

function rejectionSummary(plan: OperatorQuarantinePlan): string {
  const counts = new Map<string, number>();
  for (const r of plan.rejections) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const parts = [...counts.entries()].map(([reason, n]) => `${reason}(${n})`);
  const first = plan.rejections.slice(0, 5).map((r) => `${r.id}:${r.slug}:${r.reason}`).join(', ');
  return `${plan.rejections.length} row(s) rejected [${parts.join(' ')}]${first ? ` — ${first}` : ''}`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export async function planOperatorQuarantine(
  engine: BrainEngine,
  records: readonly OperatorManifestRecord[],
  opts: { sourceId?: string; incident: string; manifestSha256: string },
): Promise<OperatorQuarantinePlan> {
  const sourceId = opts.sourceId ?? 'default';
  const src = await resolveSourceRoot(engine, sourceId);
  if (!src.exists) throw new OperatorQuarantineError('source_not_found', `source '${sourceId}' is not registered`);
  if (src.archived) throw new OperatorQuarantineError('source_archived', `source '${sourceId}' is archived`);
  const plan = await verifyRecords(engine, records, sourceId, src.root);
  plan.manifest_sha256 = opts.manifestSha256;
  return plan;
}

// ---------------------------------------------------------------------------
// Apply (single transaction, atomic)
// ---------------------------------------------------------------------------

interface CapturedJob {
  id: number;
  source_incarnation: string;
  slug: string;
  revision: string | null;
  reason: string | null;
  existed: boolean;
  /** Was the page's text projection sealed (text_projection_revision =
   *  knowledge_revision) BEFORE the write? Only such rows are re-sealed. */
  sealed: boolean;
}

/** Snapshot the exact `page_projection_jobs` state for the target pages so a
 *  frontmatter write (which bumps knowledge_revision and re-queues a
 *  'canonical_change' job via the schema triggers) can be reverted to the
 *  pre-write state. The marker lane must leave NO new collateral queue work —
 *  it restores what was there and nothing more.
 *
 *  Also captures each row's prior projection-seal state: the frontmatter write
 *  NULLs `text_projection_revision` (the revision BEFORE trigger), so without
 *  re-sealing, the page is left `text_projection_revision IS DISTINCT FROM
 *  knowledge_revision` — permanently hidden from text search and reported
 *  projection_pending by doctor, even after a rollback removes the marker. */
async function captureProjectionJobs(engine: BrainEngine, ids: readonly number[]): Promise<CapturedJob[]> {
  const rows = await engine.executeRaw<{
    id: number;
    source_incarnation: string;
    slug: string;
    revision: string | null;
    reason: string | null;
    sealed: boolean;
  }>(
    `SELECT p.id AS id, s.incarnation AS source_incarnation, p.slug AS slug, j.revision AS revision, j.reason AS reason,
            (p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision) AS sealed
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       LEFT JOIN page_projection_jobs j ON j.source_incarnation = s.incarnation AND j.slug = p.slug
      WHERE p.id IN (${intList(ids)})
      FOR UPDATE OF p`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    source_incarnation: String(r.source_incarnation),
    slug: String(r.slug),
    revision: r.revision == null ? null : String(r.revision),
    reason: r.reason == null ? null : String(r.reason),
    existed: r.revision != null,
    sealed: r.sealed === true,
  }));
}

/** Re-seal the text projection for rows that were sealed before the write.
 *
 *  The marker write bumps knowledge_revision, which the BEFORE trigger uses to
 *  NULL text_projection_revision. Re-setting it to the (new) knowledge_revision
 *  in the SAME transaction both (a) keeps the page projection-ready — the
 *  search `currentTextProjectionFilter` and doctor's readiness probe require
 *  `text_projection_revision = knowledge_revision` — and (b) makes the AFTER
 *  projection-queue trigger DELETE the job the write just queued, since a
 *  sealed revision needs no work. Rows that were NOT sealed before stay
 *  pending (their restored job is preserved). Exact affected ids only. */
async function resealProjections(tx: BrainEngine, captured: readonly CapturedJob[]): Promise<void> {
  const sealedIds = captured.filter((c) => c.sealed).map((c) => c.id);
  if (sealedIds.length === 0) return;
  await tx.executeRaw(
    `UPDATE pages SET text_projection_revision = knowledge_revision
      WHERE id IN (${intList(sealedIds)}) AND deleted_at IS NULL
        AND text_projection_revision IS DISTINCT FROM knowledge_revision`,
    [],
  );
}

/** Final post-condition sweep: after the marker write and job restore, every
 *  affected row must be either projection-ready (sealed) or have a pending
 *  projection job that will make it so. A row that is neither is permanently
 *  hidden from text search and reported projection_pending forever (no worker
 *  will ever repair it). That state can arise from a snapshot written by the
 *  pre-fix prototype (which nulled text_projection_revision and deleted the
 *  queued job) or any lost job. Because this lane never touches content, the
 *  last-known projection for such a row is still its correct one, so sealing
 *  it restores search. Rows with a genuine pending job are left pending. */
async function sealUnrecoverable(tx: BrainEngine, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.executeRaw(
    `UPDATE pages p SET text_projection_revision = p.knowledge_revision
      WHERE p.id IN (${intList(ids)}) AND p.deleted_at IS NULL
        AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
        AND NOT EXISTS (
          SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation = j.source_incarnation
           WHERE s.id = p.source_id AND j.slug = p.slug
        )`,
    [],
  );
}

/** Restore the captured projection-job state, set-based (one jsonb param). */
async function restoreProjectionJobs(tx: BrainEngine, captured: readonly CapturedJob[]): Promise<void> {
  if (captured.length === 0) return;
  // Raw JS object bound through executeRawJsonb ($1::jsonb) — NOT
  // JSON.stringify. A pre-stringified string bound to `$N::jsonb` via
  // postgres.js `.unsafe()` is re-serialized into a jsonb *string scalar*
  // (#2339); PGLite hides it, real Postgres fails `jsonb_array_elements`.
  // The array is wrapped in `{ rows }` because executeRawJsonb rejects a
  // top-level array bind (postgres.js would bind it as a Postgres ARRAY).
  const payload = {
    rows: captured.map((c) => ({
      id: c.id,
      source_incarnation: c.source_incarnation,
      slug: c.slug,
      revision: c.revision,
      reason: c.reason,
      existed: c.existed,
    })),
  };
  const CTE = `WITH captured AS (
    SELECT (e->>'id')::int AS id,
           e->>'source_incarnation' AS inc,
           e->>'slug' AS slug,
           NULLIF(e->>'revision','')::uuid AS revision,
           e->>'reason' AS reason,
           (e->>'existed')::boolean AS existed
      FROM jsonb_array_elements(($1::jsonb)->'rows') e
  )`;
  // Drop the job the marker write caused for pages that had none before.
  await executeRawJsonb(
    tx,
    `${CTE}
     DELETE FROM page_projection_jobs j USING captured c
      WHERE j.source_incarnation = c.inc::uuid AND j.slug = c.slug AND NOT c.existed`,
    [],
    [payload],
  );
  // Put back the exact prior revision/reason for pages that already had one.
  await executeRawJsonb(
    tx,
    `${CTE}
     INSERT INTO page_projection_jobs(source_incarnation, slug, revision, reason)
       SELECT c.inc::uuid, c.slug, c.revision, COALESCE(c.reason, 'canonical_change') FROM captured c WHERE c.existed
     ON CONFLICT(source_incarnation, slug) DO UPDATE SET revision=EXCLUDED.revision, reason=EXCLUDED.reason, updated_at=now()`,
    [],
    [payload],
  );
}

/** Apply the marker (or clear it), re-seal the projections that were sealed
 *  before, and restore the projection-job state — all in one atomic
 *  transaction, so the net effect is marker + generation + projection state. */
async function withProjectionJobRestore<T>(
  engine: BrainEngine,
  ids: readonly number[],
  fn: (tx: BrainEngine) => Promise<T>,
): Promise<T> {
  return engine.transaction(async (tx) => {
    // Bound the wait: never pin a row/table behind an unbounded writer. SET
    // LOCAL is transaction-scoped and rolls back with it. No params, so this
    // is safe on prepared-statement engines (PGLite + postgres-js).
    await tx.executeRaw(`SET LOCAL lock_timeout = '${OPERATOR_TX_LOCK_TIMEOUT}'`);
    await tx.executeRaw(`SET LOCAL statement_timeout = '${OPERATOR_TX_STATEMENT_TIMEOUT}'`);
    const captured = await captureProjectionJobs(tx, ids);
    const result = await fn(tx);
    // Restore the captured job state first, then re-seal: the re-seal UPDATE
    // makes the projection-queue trigger DELETE the job for any sealed row
    // (including a restored stale job), so a sealed page never keeps queue
    // work. Finally, sweep any row left unsealed with no job — the permanent-
    // unsearchable state the pre-fix prototype could leave behind.
    await restoreProjectionJobs(tx, captured);
    await resealProjections(tx, captured);
    await sealUnrecoverable(tx, ids);
    return result;
  });
}

/** This lane performs a DIRECT pages UPDATE. On a brain whose managed
 *  persistence is active, every pages write must go through the writer
 *  coordinator (the `managed_writer_guard` trigger blocks the raw update), so
 *  refuse up front with a clear code instead of relying on a trigger error
 *  mid-transaction. The check reads the brain's persistence mode through the
 *  official reader, so a malformed/unknown mode (`persistence_brain` missing,
 *  duplicated, or a non-boolean `enabled`) refuses here too rather than
 *  writing around the owner. */
async function assertOperatorLaneUnmanaged(engine: BrainEngine, operation: string): Promise<void> {
  if (!await managedPersistenceEnabled(engine)) return;
  throw new OperatorQuarantineError(
    'persistence_enabled',
    `refusing: persistence_brain.enabled=true — this brain is managed, so every pages write must go through its writer coordinator (the managed_writer_guard trigger blocks a direct UPDATE); ${operation} performs a direct metadata UPDATE outside that owner — nothing was written.`,
  );
}

export async function applyOperatorQuarantine(
  engine: BrainEngine,
  records: readonly OperatorManifestRecord[],
  opts: OperatorQuarantineOptions,
): Promise<{ applied: number; snapshot: OperatorQuarantineSnapshot; plan: OperatorQuarantinePlan }> {
  const sourceId = opts.sourceId ?? 'default';
  await assertOperatorLaneUnmanaged(engine, 'quarantine set');
  const src = await resolveSourceRoot(engine, sourceId);
  if (!src.exists) throw new OperatorQuarantineError('source_not_found', `source '${sourceId}' is not registered`);
  if (src.archived) throw new OperatorQuarantineError('source_archived', `source '${sourceId}' is archived`);

  return withProjectionJobRestore(engine, records.map((r) => r.id), async (tx) => {
    // Re-verify inside the transaction AND lock the exact rows (FOR UPDATE) so
    // a concurrent writer cannot change content_hash/source_path between this
    // verification and the marker UPDATE below.
    const plan = await verifyRecords(tx, records, sourceId, src.root, { forUpdate: true });
    plan.manifest_sha256 = opts.manifestSha256;
    if (plan.rejections.length > 0) {
      throw new OperatorQuarantineError('rejected_rows', `refusing to apply: ${rejectionSummary(plan)}`);
    }
    if (plan.eligible.length === 0) {
      throw new OperatorQuarantineError('nothing_to_apply', 'no eligible rows (all already quarantined?)');
    }

    const now = opts.now ?? new Date();
    const marker = buildOperatorQuarantineMarker(opts.reason, {
      incident: opts.incident,
      manifestSha256: opts.manifestSha256,
      now,
    });

    // Exact-row guarded UPDATE: the WHERE predicate re-asserts id + source_id
    // + slug + content_hash + source_path per row (bound as one jsonb param),
    // so even if the FOR UPDATE lock were bypassed, a drifted row cannot be
    // marked — the count check below turns any drift into a hard failure.
    //
    // Both jsonb params are passed as RAW JS values through executeRawJsonb
    // (an object for the marker, `{ rows }` for the array) — JSON.stringify +
    // `$N::jsonb` double-encodes under postgres.js (#2339): PGLite masks it,
    // real Postgres fails `jsonb_array_elements` with "cannot extract elements
    // from a scalar". The array is wrapped because executeRawJsonb rejects a
    // top-level array bind.
    const guard = {
      rows: plan.eligible.map((r) => ({
        id: r.id, source_id: r.source_id, slug: r.slug, content_hash: r.content_hash, source_path: r.source_path,
      })),
    };
    const updated = await executeRawJsonb<{ id: number }>(
      tx,
      `UPDATE pages p
          SET frontmatter = COALESCE(p.frontmatter, '{}'::jsonb) || jsonb_build_object(${quoteKey(QUARANTINE_KEY)}, $2::jsonb)
         FROM jsonb_array_elements(($1::jsonb)->'rows') e
        WHERE p.id = (e->>'id')::int
          AND p.source_id = e->>'source_id'
          AND p.slug = e->>'slug'
          AND p.content_hash = e->>'content_hash'
          AND p.source_path = e->>'source_path'
          AND p.deleted_at IS NULL
        RETURNING p.id`,
      [],
      [guard, marker],
    );
    if (updated.length !== plan.eligible.length) {
      throw new OperatorQuarantineError(
        'apply_count_mismatch',
        `updated ${updated.length} of ${plan.eligible.length} eligible rows`,
      );
    }

    const snapshot: OperatorQuarantineSnapshot = {
      schema_version: 1,
      reason: opts.reason,
      incident: opts.incident,
      source_id: sourceId,
      manifest_sha256: opts.manifestSha256,
      created_at: now.toISOString(),
      rows: plan.eligible.map((r) => ({ ...r, marker })),
    };
    return { applied: updated.length, snapshot, plan };
  });
}

// ---------------------------------------------------------------------------
// Rollback (single transaction, atomic, provenance-bound)
// ---------------------------------------------------------------------------

export async function rollbackOperatorQuarantine(
  engine: BrainEngine,
  snapshot: OperatorQuarantineSnapshot,
): Promise<{ rolledBack: number }> {
  if (!snapshot || snapshot.schema_version !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
    throw new OperatorQuarantineError('bad_snapshot', 'snapshot is missing or malformed');
  }
  const ids = snapshot.rows.map((r) => r.id);

  await assertOperatorLaneUnmanaged(engine, 'quarantine rollback');

  return withProjectionJobRestore(engine, ids, async (tx) => {
    // Lock the exact rows so a concurrent writer cannot clear/replace the
    // marker or change content_hash between this check and the UPDATE below.
    const rows = await tx.executeRaw<{ id: number; content_hash: string | null; generation: number; frontmatter: Record<string, unknown> | null }>(
      `SELECT id, content_hash, generation, frontmatter FROM pages WHERE id IN (${intList(ids)}) FOR UPDATE`,
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    for (const r of snapshot.rows) {
      const row = byId.get(r.id);
      if (!row) throw new OperatorQuarantineError('rollback_mismatch', `page id ${r.id} (${r.slug}) is missing`);
      if (row.content_hash !== r.content_hash) {
        throw new OperatorQuarantineError('rollback_mismatch', `page id ${r.id} (${r.slug}) content_hash changed since the snapshot`);
      }
      const fm = row.frontmatter ?? {};
      const live = (fm as Record<string, unknown>)[QUARANTINE_KEY] as Record<string, unknown> | undefined;
      if (!live || typeof live !== 'object' || live.operator !== true || live.incident !== snapshot.incident || live.manifest_sha256 !== snapshot.manifest_sha256) {
        throw new OperatorQuarantineError(
          'rollback_mismatch',
          `page id ${r.id} (${r.slug}) does not carry this operator marker (refusing to clear)`,
        );
      }
    }

    // Exact-row guarded clear: re-assert id + source_id + slug + content_hash
    // + source_path so a drifted row cannot be cleared by a stale snapshot.
    // RAW `{ rows }` object through executeRawJsonb — see applyOperatorQuarantine
    // for why JSON.stringify + `$N::jsonb` double-encodes under postgres.js.
    const guard = {
      rows: snapshot.rows.map((r) => ({
        id: r.id, source_id: r.source_id, slug: r.slug, content_hash: r.content_hash, source_path: r.source_path,
      })),
    };
    const updated = await executeRawJsonb<{ id: number }>(
      tx,
      `UPDATE pages p SET frontmatter = p.frontmatter - ${quoteKey(QUARANTINE_KEY)}
         FROM jsonb_array_elements(($1::jsonb)->'rows') e
        WHERE p.id = (e->>'id')::int
          AND p.source_id = e->>'source_id'
          AND p.slug = e->>'slug'
          AND p.content_hash = e->>'content_hash'
          AND p.source_path = e->>'source_path'
          AND p.deleted_at IS NULL
          AND p.frontmatter ? ${quoteKey(QUARANTINE_KEY)}
        RETURNING p.id`,
      [],
      [guard],
    );
    if (updated.length !== snapshot.rows.length) {
      throw new OperatorQuarantineError('apply_count_mismatch', `cleared ${updated.length} of ${snapshot.rows.length}`);
    }
    return { rolledBack: updated.length };
  });
}

/** The quarantine key is a compile-time constant; quote it for safety anyway. */
function quoteKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}
