/**
 * Fence unfenced fact rows (#5299): append every active fact row the page's
 * fence does not carry to that entity page's `## Facts` fence, so the fence
 * reconciler owns it. Two row shapes are unfenced:
 *   - `row_num IS NULL` — a row no fence ever took; it is appended under a
 *     new row number above every occupied one and stamped with it.
 *   - `row_num` set, but the page's fence does not carry it — the fence owns
 *     the position while the markdown lost the row (a page body replaced or
 *     reverted after the stamp, a fence section dropped by a hand edit). This
 *     shape is OPT-IN (`adoptStamped`), because the v0.32.2 backfill is where
 *     "publish the database facts into the fence" belongs: the `extract_facts`
 *     reconcile runs its own walk over fence-owned rows the page no longer
 *     lists and decides there whether such a row is retired. When adopted, the
 *     row is appended under its OWN number, so fence identity is preserved; a
 *     number another fence row already occupies takes the next free position
 *     instead, and the row is re-stamped to it. Nothing is deleted and no
 *     claim text is rewritten beyond the codec's own normalization.
 *
 * Shared by the v0.32.2 migration's Phase B and the `extract_facts` cycle
 * phase. The inline writer's DB-only fallback keeps producing such rows (a
 * write from a host without the source checkout, `sync.write_through=off`),
 * so the cycle fences them on every run instead of waiting for a manual
 * migration retry.
 *
 * Ontology observations (`dimension IS NOT NULL`, written by
 * `mergeOntologyFact`) are never candidates (#6264): they belong to the
 * entity's ontology, keyed by their own provenance in `source_markdown_slug`,
 * and have no row on any page's Facts table. Fencing one rewrote its
 * provenance to the page and handed it to the fence reconciler, which retired
 * it on the next page write that did not list it.
 *
 * Eligibility (`planUnfencedFacts`): the row names an `entity_slug`, its page
 * is live in the row's source, and either the brain is managed (the
 * coordinator publishes database-only pages too; archived sources are
 * skipped) or the source has a `local_path` and the page's canonical file
 * exists on this host. Everything else is counted and left alone: a NULL
 * entity slug, a missing page or file, or a source without a checkout here.
 *
 * Adoption oracle (#6278, `adoptableClaim`): the fence codec trims a claim,
 * folds CRLF/CR to LF, reads `~~x~~` as a struck row and `<br>` as a line
 * break, so a legacy claim is adopted only when `parseFactsFence(
 * renderFactsTable([row]))` hands it back active, non-empty, with the same
 * kind, visibility, validity and source, differing from the stored text by
 * whitespace and line endings alone. That parsed text is what the derived
 * representation projects; it is written ONLY into the derived document's
 * binding, never back into `facts.fact`. A row the codec would change further,
 * or whose normalized claim, source and visibility another active fence row or
 * planned row
 * already carries (the reconciler indexes a duplicate once and would retire
 * the second),
 * stays a legacy row exactly as it is: never deleted or expired, recorded as
 * an `UnadoptableFactRecord` (source, page, fact id, reason class; never the
 * claim text) and named in `failed_pages` with the stable token
 * `<slug> (fence_unrenderable: N row(s), <class>)`. The other rows of the
 * page still adopt; a page with no adoptable row submits nothing.
 *
 * Write discipline (`fenceUnfencedFacts`) — strict preservation: every original
 * fact row keeps its identity, position (including NULL), claim text and
 * provenance, and the canonical page body is never rewritten. What the page's
 * fence would have gained is published as that page's separate derived document
 * (one row in the page-scoped `raw_data` store with explicit
 * original-fact-to-derived-position bindings), through the SAME owner path:
 * - Managed: one `managed_maintenance_publish_preserved_fence` request per page
 *   through the coordinator, admitted against the page revision and replanned
 *   under the page key.
 * - Unmanaged: one maintenance transaction, under the page lock.
 * A page that fails is reported in `failed_pages`; the others still publish.
 */
import { existsSync, readFileSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { formatFenceDate, normalizeClaimWhitespace, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../facts-fence.ts';
import { FENCE_SOURCE_DEFAULT } from './extract-from-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { withPageLock } from '../page-lock.ts';
import { assertLifetimeIdHeadroom } from '../persistence/journal.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { resolvePageWriteTarget } from '../write-through.ts';

export interface UnfencedFactRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
  visibility: 'private' | 'world';
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  source: string;
  confidence: number;
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
  /** The fence position the row already holds, or null when it holds none. */
  row_num: number | null;
  page_exists: boolean;
}

export interface UnfencedFactsOutcome {
  scanned: number;
  fenced: number;
  skipped_no_entity: number;
  skipped_no_local_path: number;
  skipped_no_page: number;
  skipped_archived: number;
  pages_touched: number;
  /** `<slug> (<reason>)` per page whose fence write failed; its rows stay unfenced. */
  failed_pages: string[];
  /** Slugs whose fence this run wrote. */
  fenced_slugs: string[];
  /** Unmanaged: `<slug> (<reason>)` per live page whose canonical file is not on this host (counted in skipped_no_page). */
  missing_files: string[];
  /** Legacy rows this run left as they are because the fence codec would change them or the page already carries the claim (#6278). */
  unadoptable_rows: UnadoptableFactRecord[];
  /** Rows that already held a fence position the markdown had lost, re-published under that same position. */
  adopted_in_place?: number;
  /** Adopted rows whose own position was occupied in the fence and took the next free one instead. */
  renumbered?: number;
}

/**
 * What the fence codec would change about a legacy claim, by column or
 * character class: `empty` (whitespace-only), `struck` (`~~x~~` reads back
 * inactive), `line_break_markup` (a literal `<br>` reads back as a newline),
 * `claim` (any other change to the text), `kind` / `visibility` /
 * `validity` / `source` (another column reads back different), `parse` (the
 * single-row fence does not parse at all).
 */
export type UnrenderableClass = 'empty' | 'struck' | 'line_break_markup' | 'claim' | 'kind' | 'visibility' | 'validity' | 'source' | 'parse';

/** One legacy row left unadopted, by location only: the claim text is never copied into a diagnostic. */
export interface UnadoptableFactRecord {
  source_id: string;
  slug: string;
  fact_id: number;
  reason: 'fence_unrenderable' | 'duplicate_claim';
  class: UnrenderableClass | 'duplicate_claim';
}

function fenceRowOf(row: UnfencedFactRow, rowNum: number, claim: string): ParsedFact {
  // Full timestamps survive the fence (date-only at midnight UTC), so the
  // canonical projection writes back the value the row already holds.
  const validFromStr = formatFenceDate(row.valid_from instanceof Date ? row.valid_from : new Date(row.valid_from));
  const validUntilStr = row.valid_until
    ? formatFenceDate(row.valid_until instanceof Date ? row.valid_until : new Date(row.valid_until))
    : undefined;
  return {
    rowNum,
    active: true,
    claim,
    kind:       row.kind,
    confidence: Number(row.confidence),
    visibility: row.visibility,
    notability: row.notability,
    validFrom:  validFromStr,
    validUntil: validUntilStr,
    source:     row.source,
    context:    row.context ?? undefined,
    ...(row.claim_metric ? { claimMetric: row.claim_metric } : {}),
    ...(row.claim_value != null ? { claimValue: Number(row.claim_value) } : {}),
    ...(row.claim_unit ? { claimUnit: row.claim_unit } : {}),
    ...(row.claim_period ? { claimPeriod: row.claim_period } : {}),
  };
}

/**
 * The parser as the oracle (#6278): render the row as a one-row fence, parse
 * it back, and accept the parsed claim only when it is active, non-empty,
 * keeps the row's kind, visibility, validity and source, differs from the
 * stored text by whitespace and line endings alone, and survives a second
 * round trip unchanged (it is the text written back into `facts.fact`).
 */
export function adoptableClaim(row: Pick<UnfencedFactRow, 'fact' | 'kind' | 'visibility' | 'notability' | 'confidence' | 'context'
  | 'valid_from' | 'valid_until' | 'source' | 'claim_metric' | 'claim_value' | 'claim_unit' | 'claim_period'>): { claim: string } | { rejected: UnrenderableClass } {
  const desired = fenceRowOf(row as UnfencedFactRow, 1, row.fact);
  const once = parseFactsFence(renderFactsTable([desired]));
  const back = once.facts[0];
  if (once.warnings.length > 0 || once.facts.length !== 1 || !back) return { rejected: 'parse' };
  if (!back.active) return { rejected: 'struck' };
  if (back.claim === '') return { rejected: 'empty' };
  if (normalizeClaimWhitespace(back.claim) !== normalizeClaimWhitespace(row.fact)) {
    return { rejected: /<br\s*\/?>/i.test(row.fact) ? 'line_break_markup' : 'claim' };
  }
  if (back.kind !== desired.kind) return { rejected: 'kind' };
  if (back.visibility !== desired.visibility) return { rejected: 'visibility' };
  if ((back.validFrom ?? '') !== (desired.validFrom ?? '') || (back.validUntil ?? '') !== (desired.validUntil ?? '')) return { rejected: 'validity' };
  if ((back.source ?? '') !== (desired.source ?? '')) return { rejected: 'source' };
  const twice = parseFactsFence(renderFactsTable([{ ...desired, claim: back.claim }])).facts[0];
  if (!twice?.active || twice.claim !== back.claim) return { rejected: 'claim' };
  return { claim: back.claim };
}

/** The `failed_pages` entry for a page with unadoptable rows: `<slug> (fence_unrenderable: N row(s), <class>; duplicate_claim: N row(s))`. */
export function unadoptableRowsToken(slug: string, records: UnadoptableFactRecord[]): string {
  const parts: string[] = [];
  const unrenderable = records.filter(r => r.reason === 'fence_unrenderable');
  if (unrenderable.length) parts.push(`fence_unrenderable: ${unrenderable.length} row(s), ${[...new Set(unrenderable.map(r => r.class))].sort().join(', ')}`);
  const duplicates = records.filter(r => r.reason === 'duplicate_claim');
  if (duplicates.length) parts.push(`duplicate_claim: ${duplicates.length} row(s)`);
  return `${slug} (${parts.join('; ')})`;
}

export interface UnfencedFactsPlan {
  managed: boolean;
  /** Fenceable rows grouped per page, keyed `<source_id>\0<entity_slug>`. */
  groups: Map<string, UnfencedFactRow[]>;
  /** Unmanaged: the canonical file per group key. */
  filePaths: Map<string, string>;
  localPathById: Map<string, string | null>;
  outcome: UnfencedFactsOutcome;
}

/** Rows in the fenceable groups. */
export function fenceableRowCount(plan: UnfencedFactsPlan): number {
  return [...plan.groups.values()].reduce((n, group) => n + group.length, 0);
}

/** Read the unfenced active rows of one source (or every source) and group the fenceable ones per page. */
export async function planUnfencedFacts(engine: BrainEngine, opts: { sourceId?: string; adoptStamped?: boolean } = {}): Promise<UnfencedFactsPlan> {
  const managed = await managedPersistenceEnabled(engine);
  const sources = await engine.executeRaw<{ id: string; local_path: string | null; archived?: boolean }>(
    'SELECT id, local_path, archived FROM sources',
  );
  const localPathById = new Map(sources.map(s => [s.id, s.local_path] as const));
  const archived = new Set(sources.filter(s => s.archived).map(s => s.id));
  // Both unfenced shapes: no position yet, or (opt-in, `adoptStamped`) a
  // position the markdown lost. The v0.32.2 backfill wants the second shape —
  // its whole job is publishing database facts into fences — while the
  // extract_facts reconcile keeps its own walk over fence-owned rows the page
  // no longer lists (that walk decides whether such a row is retired).
  // Conversation-miner (`cli:`) rows are never adopted in the second shape:
  // the extract-conversation-facts chat log is their source of truth and the
  // verify phase excludes the same prefix. A `cli:` row with no position is
  // still selected (the first shape) exactly as before.
  const stampedClause = opts.adoptStamped ? "OR COALESCE(source, '') NOT LIKE 'cli:%'" : '';
  const rows = await engine.executeRaw<UnfencedFactRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
            context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, row_num,
            EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id
              AND p.slug = f.entity_slug AND p.deleted_at IS NULL) AS page_exists
       FROM facts f
      WHERE expired_at IS NULL AND dimension IS NULL
        AND (row_num IS NULL ${stampedClause})
        ${opts.sourceId !== undefined ? 'AND source_id = $1' : ''}
      ORDER BY source_id, entity_slug, id`,
    opts.sourceId !== undefined ? [opts.sourceId] : [],
  );
  const outcome: UnfencedFactsOutcome = {
    scanned: rows.length, fenced: 0, skipped_no_entity: 0, skipped_no_local_path: 0, skipped_no_page: 0,
    skipped_archived: 0, pages_touched: 0, failed_pages: [], fenced_slugs: [], missing_files: [], unadoptable_rows: [],
    adopted_in_place: 0, renumbered: 0,
  };
  const groups = new Map<string, UnfencedFactRow[]>();
  for (const row of rows) {
    if (row.entity_slug === null) { outcome.skipped_no_entity += 1; continue; }
    // A managed brain publishes through the source's maintenance authority,
    // which an archived source does not grant; it never blocks the others.
    if (managed && archived.has(row.source_id)) { outcome.skipped_archived += 1; continue; }
    if (!localPathById.get(row.source_id) && !managed) { outcome.skipped_no_local_path += 1; continue; }
    if (!row.page_exists) { outcome.skipped_no_page += 1; continue; }
    const key = `${row.source_id}\0${row.entity_slug}`;
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const filePaths = new Map<string, string>();
  for (const [key, group] of managed ? [] : [...groups]) {
    const [sourceId, entitySlug] = key.split('\0');
    const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
    if (!target.ok || !existsSync(target.filePath)) {
      outcome.skipped_no_page += group.length;
      outcome.missing_files.push(`${entitySlug} (${target.ok ? `canonical file ${target.filePath} does not exist on this host` : `no canonical file: ${target.skipped}`})`);
      groups.delete(key);
      continue;
    }
    filePaths.set(key, target.filePath);
  }
  return { managed, groups, filePaths, localPathById, outcome };
}

/**
 * Append a page's adoptable unfenced rows to its facts fence. Row numbering
 * starts above every occupied `row_num` on the page, conversation-extractor
 * rows included, so no fence row can take an extractor row's position. A
 * fence row left by a partial earlier run with the same claim and source and
 * no database owner is reused instead of appended again. Each assignment
 * carries the parsed claim the fence projects, to be written back into
 * `facts.fact` with the row number. Rows the codec would change further, and
 * a second row whose normalized claim and source the page already carries,
 * are returned in `rejected` and left alone.
 */
export interface FenceAssignment {
  id: string;
  row_num: number;
  fact: string;
  /**
   * The position the row held before this plan (null when it held none).
   * The stamp re-checks it, so a row re-numbered by another writer between
   * planning and publication is left alone instead of being overwritten.
   */
  prev_row_num: number | null;
  /** True when the row already held `row_num` and the markdown had lost it. */
  adopted_in_place: boolean;
}

/**
 * Append a page's adoptable unfenced rows to its facts fence. Row numbering
 * starts above every occupied `row_num` on the page, conversation-extractor
 * rows included, so no fence row can take an extractor row's position. A row
 * that already holds a fence position the markdown lost keeps that position
 * (identity preserved) unless the fence occupies it, in which case it takes
 * the next free number and is re-stamped — a row is never dropped. A fence
 * row left by a partial earlier run with the same claim and source and no
 * database owner is reused instead of appended again. Each assignment
 * carries the parsed claim the fence projects, to be written back into
 * `facts.fact` with the row number. Rows the codec would change further, and
 * a second row whose normalized claim and source the page already carries,
 * are returned in `rejected` and left alone.
 */
export interface OccupiedFactPosition { id: string; row_num: number; fact: string; source: string | null }

export async function planFence(engine: BrainEngine, sourceId: string, entitySlug: string, body: string, group: UnfencedFactRow[]):
  Promise<{ body: string; assignments: FenceAssignment[]; rejected: UnadoptableFactRecord[] } | { warnings: string[] }> {
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length > 0) return { warnings: parsed.warnings };
  const occupiedRows = await engine.executeRaw<OccupiedFactPosition>(
    `SELECT id, row_num, fact, source FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`,
    [sourceId, entitySlug],
  );
  return planFenceWithOccupiedRows(sourceId, entitySlug, body, group, occupiedRows);
}

/** Pure codec plan. Its assignments are derived coordinates, not authority to change original rows. */
export function planFenceWithOccupiedRows(sourceId: string, entitySlug: string, body: string,
  group: UnfencedFactRow[], occupiedRows: OccupiedFactPosition[]):
  { body: string; assignments: FenceAssignment[]; rejected: UnadoptableFactRecord[] } | { warnings: string[] } {
  const existingFence = parseFactsFence(body);
  if (existingFence.warnings.length > 0) return { warnings: existingFence.warnings };
  const occupied = new Map(occupiedRows.map(row => [Number(row.row_num), row]));
  const fenceRowAt = new Map(existingFence.facts.map(f => [f.rowNum, f] as const));
  let nextRowNum = Math.max(0, ...occupied.keys(), ...existingFence.facts.map(f => f.rowNum)) + 1;
  const claimed = new Set<number>();
  const assignments: FenceAssignment[] = [];
  const rejected: UnadoptableFactRecord[] = [];
  // The reconciler indexes active rows with one claim and source once (#1781)
  // and retires the later copy, so a claim the page already carries with the
  // same source and visibility (the projection's identity), or that an
  // earlier row of this group plans, is not adopted a second time. A private
  // and a world row with one text are two facts and both adopt, as before.
  const dupKey = (claim: string, source: string | undefined, visibility: string) => `${claim}\u0000${source || FENCE_SOURCE_DEFAULT}\u0000${visibility}`;
  const planned = new Set<string>();
  const ownedKeys = new Set(existingFence.facts.filter(f => {
    const owner = occupied.get(f.rowNum);
    return f.active && owner !== undefined && owner.fact === f.claim && (owner.source ?? '') === (f.source ?? '');
  }).map(f => dupKey(f.claim, f.source, f.visibility)));
  const heldRowNum = (row: UnfencedFactRow): number | null =>
    row.row_num === null || row.row_num === undefined ? null : Number(row.row_num);
  const appendRow = (row: UnfencedFactRow, rowNum: number, claim: string, held: number | null, inPlace: boolean): void => {
    const fenceRow = fenceRowOf(row, rowNum, claim);
    existingFence.facts.push(fenceRow);
    fenceRowAt.set(rowNum, fenceRow);
    claimed.add(rowNum);
    assignments.push({ id: row.id, row_num: rowNum, fact: claim, prev_row_num: held, adopted_in_place: inPlace });
  };
  for (const row of group) {
    const held = heldRowNum(row);
    const oracle = adoptableClaim(row);
    // The row already owns its position and the markdown carries it back
    // (the codec's own projection of the claim, so whitespace is not drift):
    // there is nothing to publish for it, and the position is spoken for.
    if (held !== null && !('rejected' in oracle)) {
      const at = fenceRowAt.get(held);
      const owner = occupied.get(held);
      if (at && owner && String(owner.id) === String(row.id)
        && at.claim === oracle.claim && (at.source ?? '') === (row.source ?? '')) {
        claimed.add(held);
        continue;
      }
    }
    if ('rejected' in oracle) {
      rejected.push({ source_id: sourceId, slug: entitySlug, fact_id: Number(row.id), reason: 'fence_unrenderable', class: oracle.rejected });
      continue;
    }
    const key = dupKey(oracle.claim, row.source, row.visibility);
    if (planned.has(key) || ownedKeys.has(key)) {
      rejected.push({ source_id: sourceId, slug: entitySlug, fact_id: Number(row.id), reason: 'duplicate_claim', class: 'duplicate_claim' });
      continue;
    }
    planned.add(key);
    const existing = existingFence.facts.find(f => {
      const owner = occupied.get(f.rowNum);
      return f.active && !claimed.has(f.rowNum) && f.claim === oracle.claim &&
        (f.source ?? '') === (row.source ?? '') &&
        (!owner || owner.fact !== f.claim || (owner.source ?? '') !== (f.source ?? ''));
    });
    if (existing) {
      if (occupied.has(existing.rowNum)) {
        fenceRowAt.delete(existing.rowNum);
        existing.rowNum = nextRowNum++;
      }
      fenceRowAt.set(existing.rowNum, existing);
      claimed.add(existing.rowNum);
      assignments.push({ id: row.id, row_num: existing.rowNum, fact: oracle.claim, prev_row_num: held, adopted_in_place: false });
      continue;
    }
    if (held !== null) {
      // The markdown lost a row that already holds a position: publish it back
      // under that same position, unless the fence occupies the number — then
      // the row moves to the next free one and is re-stamped. Never dropped.
      const taken = claimed.has(held) || fenceRowAt.has(held);
      appendRow(row, taken ? nextRowNum++ : held, oracle.claim, held, !taken);
      continue;
    }
    appendRow(row, nextRowNum++, oracle.claim, null, false);
  }
  return { body: replaceOrInsertFactsFence(body, renderFactsTable(existingFence.facts)), assignments, rejected };
}

/**
 * Name one page once in `failed_pages`. A page already named by class (the
 * unadoptable-row token) is not named a second time by the refusal that
 * followed it; the message is trimmed, never dropped.
 */
function noteFailure(outcome: UnfencedFactsOutcome, slug: string, reason: string): void {
  if (outcome.failed_pages.some(entry => entry.startsWith(`${slug} (`))) return;
  outcome.failed_pages.push(`${slug} (${reason.slice(0, 300)})`);
}

/** Keep the typed records and name the page once in `failed_pages` with the stable token; the rows stay as they are. */
function recordUnadoptable(outcome: UnfencedFactsOutcome, slug: string, records: UnadoptableFactRecord[]): void {
  if (records.length === 0) return;
  outcome.unadoptable_rows.push(...records);
  outcome.failed_pages.push(unadoptableRowsToken(slug, records));
}

/**
 * Managed brains (#5728 class): the managed writer guard refuses direct fence
 * writes into the canonical worktree and any raw `UPDATE facts`. Each page
 * publishes its rendered fence through the coordinator as one
 * `managed_maintenance_adopt_fact_fence` request that adopts the rows in
 * place. The page body comes from the database, so database-only pages are
 * included. Preflight and capacity refusals throw before any page publishes.
 */
async function fenceManaged(engine: BrainEngine, plan: UnfencedFactsPlan, allowSupersede = false): Promise<void> {
  const { groups, outcome } = plan;
  const authorities = new Map<string, MaintenanceAuthority>();
  for (const key of groups.keys()) {
    const sourceId = key.split('\0')[0];
    if (!authorities.has(sourceId)) authorities.set(sourceId, (await maintenancePreflight(engine, sourceId))!);
  }
  // One admission per page: refuse up front, before any page publishes,
  // when the permanent request-ID caps cannot cover them all.
  const [first] = authorities.values();
  if (first) await assertLifetimeIdHeadroom(engine, first.writer.principal, groups.size);
  for (const [key, group] of groups) {
    const [sourceId, entitySlug] = key.split('\0');
    try {
      const authority = authorities.get(sourceId)!;
      const snapshot = await engine.readPageSnapshot(entitySlug, { sourceId });
      if (!snapshot) { outcome.skipped_no_page += group.length; continue; }
      const fence = await planFence(engine, sourceId, entitySlug, serializePageToMarkdown(snapshot.page, snapshot.tags), group);
      if ('warnings' in fence) {
        outcome.failed_pages.push(`${entitySlug} (${fence.warnings.join('; ')})`);
        continue;
      }
      recordUnadoptable(outcome, entitySlug, fence.rejected);
      if (fence.assignments.length === 0) continue;
      // Strict preservation: the originals are never stamped, restamped or
      // rewritten. The adopted positions and the codec-normalized text live in
      // the page's separate derived document, published through the SAME
      // coordinator path (one `managed_maintenance_publish_preserved_fence`
      // request), and every original row keeps its id, position and text.
      const { publishPreservedFencePublication } = await import('./preserved-fence-store.ts');
      const receipt = await publishPreservedFencePublication(engine, sourceId, entitySlug, { authority, allowSupersede });
      outcome.fenced += receipt.bindings;
      outcome.adopted_in_place = (outcome.adopted_in_place ?? 0) + fence.assignments.filter(a => a.adopted_in_place).length;
      outcome.renumbered = (outcome.renumbered ?? 0) + fence.assignments.filter(a => a.prev_row_num !== null && !a.adopted_in_place).length;
      outcome.pages_touched += 1;
      outcome.fenced_slugs.push(entitySlug);
    } catch (err) {
      noteFailure(outcome, entitySlug, err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * One unmanaged page: the derived document is published through the existing
 * owner path. The canonical file and every original fact row are left exactly
 * as they are — the adopted positions and codec-normalized text exist only in
 * the derived document, so there is no file write and nothing to commit back.
 */
async function fenceFilePage(engine: BrainEngine, sourceId: string, entitySlug: string, filePath: string,
  group: UnfencedFactRow[], outcome: UnfencedFactsOutcome, lockRoot?: string, allowSupersede = false): Promise<void> {
  const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
  if (!target.ok) { outcome.skipped_no_page += group.length; return; }
  const write = () => withPageLock(entitySlug, async () => {
    const fence = await planFence(engine, sourceId, entitySlug, readFileSync(filePath, 'utf-8'), group);
    if ('warnings' in fence) {
      outcome.failed_pages.push(`${entitySlug} (${fence.warnings.join('; ')})`);
      return;
    }
    recordUnadoptable(outcome, entitySlug, fence.rejected);
    if (fence.assignments.length === 0) return;
    // Strict preservation: the canonical file and every original fact row are
    // left exactly as they are. The adopted positions and the codec-normalized
    // text live ONLY in the page's separate derived document, published
    // through the existing owner path (one maintenance transaction here).
    // Nothing is written to the file, so there is nothing to commit back.
    const { publishPreservedFencePublication } = await import('./preserved-fence-store.ts');
    const receipt = await publishPreservedFencePublication(engine, sourceId, entitySlug, { allowSupersede });
    outcome.fenced += receipt.bindings;
    outcome.adopted_in_place = (outcome.adopted_in_place ?? 0) + fence.assignments.filter(a => a.adopted_in_place).length;
    outcome.renumbered = (outcome.renumbered ?? 0) + fence.assignments.filter(a => a.prev_row_num !== null && !a.adopted_in_place).length;
    outcome.pages_touched += 1;
    outcome.fenced_slugs.push(entitySlug);
  }, { timeoutMs: 5_000, ...(lockRoot ? { lockRoot } : {}) });
  try {
    await write();
  } catch (err) {
    noteFailure(outcome, entitySlug, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read-only (#6278): the rows of a plan the fence step would leave unadopted
 * and why, by location only, for doctor `fence_integrity`. Each page's body
 * is read the way the write path reads it (the database snapshot on a managed
 * brain, the canonical file otherwise) and planned without writing. A plan
 * the deadline cut short reports `complete: false`.
 */
export async function auditUnadoptableFacts(engine: BrainEngine, plan: UnfencedFactsPlan, opts: { deadline?: number } = {}):
  Promise<{ records: UnadoptableFactRecord[]; complete: boolean }> {
  const records: UnadoptableFactRecord[] = [];
  for (const [key, group] of plan.groups) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) return { records, complete: false };
    const [sourceId, entitySlug] = key.split('\0');
    let body: string;
    if (plan.managed) {
      const snapshot = await engine.readPageSnapshot(entitySlug, { sourceId });
      if (!snapshot) continue;
      body = serializePageToMarkdown(snapshot.page, snapshot.tags);
    } else {
      const filePath = plan.filePaths.get(key);
      if (!filePath || !existsSync(filePath)) continue;
      body = readFileSync(filePath, 'utf-8');
    }
    const fence = await planFence(engine, sourceId, entitySlug, body, group);
    if (!('warnings' in fence)) records.push(...fence.rejected);
  }
  return { records, complete: true };
}

/**
 * Fence every group of the plan through the brain's write path; fills
 * `plan.outcome`. A managed preflight or capacity refusal throws before any
 * page publishes; a per-page failure lands in `failed_pages`.
 *
 * `allowSupersede` defaults to TRUE: the derived document is a projection
 * maintained by the tool, always recomputed from the page's CURRENT originals,
 * so a document left behind by an earlier state of the originals (a page edit,
 * a provenance change) is brought up to date instead of freezing the page's
 * fence step forever. No original row or page body is touched either way — the
 * option only decides whether a stale DERIVED row may be replaced.
 */
export async function fenceUnfencedFacts(engine: BrainEngine, plan: UnfencedFactsPlan, opts: { pageLockRoot?: string; allowSupersede?: boolean } = {}): Promise<UnfencedFactsOutcome> {
  const allowSupersede = opts.allowSupersede !== false;
  if (plan.managed) {
    await fenceManaged(engine, plan, allowSupersede);
    return plan.outcome;
  }
  for (const [key, group] of plan.groups) {
    const [sourceId, entitySlug] = key.split('\0');
    await fenceFilePage(engine, sourceId, entitySlug, plan.filePaths.get(key)!, group, plan.outcome, opts.pageLockRoot, allowSupersede);
  }
  return plan.outcome;
}
