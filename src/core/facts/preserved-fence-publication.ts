/**
 * A derived fence publication is NOT a replacement for its original page or
 * facts. This pure boundary plans and validates the separate representation;
 * it grants no filesystem, SQL, owner or publication authority.
 *
 * Original positions (including NULL), text and every supplied provenance
 * column are pinned literally. Codec-normalized text and newly allocated row
 * numbers live only in the explicitly derived bindings. Consumers must retain
 * that distinction; applying a binding as an UPDATE to facts is invalid.
 */
import { digest, sha256, stableJson } from '../persistence/digest.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { adoptableClaim, planFenceWithOccupiedRows, type UnfencedFactRow } from './unfenced-facts.ts';

export type OriginalRecord = Record<string, unknown>;

/**
 * Page columns the write that publishes a document refreshes itself: derivative
 * index bookkeeping (the text-projection and chunker revisions the maintenance
 * path re-stamps), never original content, identity or provenance. They are
 * named here and normalized in the page digest below so a document captured
 * before its own publication still validates afterwards — a difference in ANY
 * other page column still refuses.
 */
export const MAINTENANCE_REFRESHED_PAGE_COLUMNS = ['text_projection_revision', 'chunker_version'] as const;

/** The page row's digest, with the maintenance-refreshed index columns held constant. */
export function preservedPageDigest(row: OriginalRecord): string {
  const normalized: OriginalRecord = { ...row };
  for (const column of MAINTENANCE_REFRESHED_PAGE_COLUMNS) if (column in normalized) normalized[column] = null;
  return digest(normalized);
}

export interface PreservedFenceInputs {
  sourceId: string;
  entitySlug: string;
  /** Complete rows, not selected identity/text projections. */
  source: OriginalRecord;
  page: OriginalRecord;
  facts: OriginalRecord[];
  /** Column discovery is the caller's responsibility; omission never means NULL. */
  columns: { source: string[]; page: string[]; facts: string[] };
  /** Literal canonical file, or literal serialized page on a managed source. */
  body: string;
  candidateIds: string[];
}
export interface PreservedFenceBinding {
  original_fact_id: string;
  original_row_num: number | null;
  original_sha256: string;
  derived_row_num: number;
  derived_claim: string;
}
export interface PreservedFencePublication {
  schema: 'gbrain.preserved-fence-publication.v1';
  source_id: string;
  entity_slug: string;
  original_source_sha256: string;
  original_page_sha256: string;
  original_body_sha256: string;
  original_facts: Array<{ id: string; sha256: string }>;
  columns: PreservedFenceInputs['columns'];
  /** Separate derived document. Never install this over the original body. */
  derived_body: string;
  bindings: PreservedFenceBinding[];
}

function refuse(reason: string): never { throw new Error(`preserved_fence_refused: ${reason}`); }
function identity(value: unknown): string {
  // Do not coerce an unsafe JS number or repair a malformed identifier.
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) return refuse('invalid_fact_identity');
  // postgres.js returns BIGSERIAL as bigint; keep its exact decimal identity
  // in the derived binding without converting or rewriting the original row.
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return refuse('invalid_fact_identity');
  const id = String(value);
  if (!/^[1-9][0-9]*$/.test(id)) return refuse('invalid_fact_identity');
  return id;
}
function position(value: unknown): number | null {
  if (value === null) return null;
  // Noncandidate domains (for example conversation rows) can legitimately
  // retain zero/negative legacy coordinates. They are original evidence, not
  // fence positions to normalize. Only a candidate must be codec-addressable.
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return refuse('invalid_original_position');
  return value;
}
function checkedRecord(row: OriginalRecord, columns: string[], required: string[]): OriginalRecord {
  if (!columns.length || new Set(columns).size !== columns.length || required.some(c => !columns.includes(c))) refuse('incomplete_column_manifest');
  const actual = Object.keys(row).sort();
  if (stableJson(actual) !== stableJson([...columns].sort()) || actual.some(k => row[k] === undefined)) refuse('incomplete_original_record');
  // Stable JSON orders column names only. It never trims or normalizes values.
  stableJson(row);
  return row;
}
function fenceInput(row: OriginalRecord): UnfencedFactRow {
  const validFrom = new Date(String(row.valid_from));
  const validUntil = row.valid_until === null ? null : new Date(String(row.valid_until));
  if (!Number.isFinite(validFrom.getTime()) || (validUntil && !Number.isFinite(validUntil.getTime()))) refuse('invalid_original_date');
  return { ...row, id: identity(row.id), row_num: position(row.row_num),
    valid_from: validFrom, valid_until: validUntil, page_exists: true } as unknown as UnfencedFactRow;
}

/** All-or-refuse: no partial publication when a candidate is ambiguous or unrenderable. */
export function planPreservedFencePublication(input: PreservedFenceInputs): PreservedFencePublication {
  const { sourceId, entitySlug, body, columns } = input;
  checkedRecord(input.source, columns.source, ['id']);
  checkedRecord(input.page, columns.page, ['id', 'source_id', 'slug', 'compiled_truth', 'timeline']);
  if (input.source.id !== sourceId || input.page.source_id !== sourceId || input.page.slug !== entitySlug) refuse('source_or_page_mismatch');
  if (input.page.deleted_at != null || input.source.archived === true) refuse('inactive_original_owner');
  const ids = new Set<string>();
  const occupied = new Set<number>();
  const rows = [...input.facts].sort((a, b) => {
    const x = identity(a.id), y = identity(b.id);
    return x.length - y.length || x.localeCompare(y);
  });
  for (const row of rows) {
    checkedRecord(row, columns.facts, ['id', 'source_id', 'entity_slug', 'source_markdown_slug', 'row_num',
      'fact', 'source', 'expired_at', 'dimension', 'valid_from', 'valid_until']);
    const id = identity(row.id);
    if (ids.has(id)) refuse('duplicate_original_identity');
    ids.add(id);
    if (row.source_id !== sourceId || (row.entity_slug !== entitySlug && row.source_markdown_slug !== entitySlug)) refuse('out_of_scope_original');
    const held = position(row.row_num);
    if (row.source_markdown_slug === entitySlug && held !== null) {
      if (occupied.has(held)) refuse('ambiguous_original_position');
      occupied.add(held);
    }
  }
  if (new Set(input.candidateIds).size !== input.candidateIds.length) refuse('duplicate_candidate_identity');
  for (const id of input.candidateIds) {
    if (identity(id) !== id || !ids.has(id)) refuse('missing_candidate_identity');
  }
  const candidateSet = new Set(input.candidateIds);
  const candidates = rows.filter(row => candidateSet.has(identity(row.id)));
  for (const row of candidates) {
    if (row.entity_slug !== entitySlug || row.expired_at !== null || row.dimension !== null) refuse('ineligible_candidate');
    if (row.row_num !== null && Number(row.row_num) < 1) refuse('invalid_original_position');
  }
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length) refuse('invalid_original_fence');
  if (new Set(parsed.facts.map(f => f.rowNum)).size !== parsed.facts.length) refuse('ambiguous_original_fence_position');
  const plan = planFenceWithOccupiedRows(sourceId, entitySlug, body, candidates.map(fenceInput), rows
    .filter(row => row.source_markdown_slug === entitySlug && row.row_num !== null)
    .map(row => ({ id: identity(row.id), row_num: position(row.row_num)!, fact: String(row.fact), source: row.source as string | null })));
  if ('warnings' in plan) refuse('invalid_derived_fence');
  if (plan.rejected.length) refuse(`unadoptable_candidates:${[...new Set(plan.rejected.map(r => r.class))].sort().join(',')}`);
  const derived = parseFactsFence(plan.body);
  if (derived.warnings.length || new Set(derived.facts.map(f => f.rowNum)).size !== derived.facts.length) refuse('ambiguous_derived_fence');
  const assigned = new Map(plan.assignments.map(a => [String(a.id), a]));
  const boundPositions = new Set<number>();
  const bindings = candidates.map(row => {
    const id = identity(row.id), originalPosition = position(row.row_num);
    const oracle = adoptableClaim(fenceInput(row));
    if ('rejected' in oracle) return refuse(`unadoptable_candidate:${oracle.rejected}`);
    // An already-paired candidate needs a binding too, not a fabricated adoption.
    const derivedPosition = assigned.get(id)?.row_num ?? originalPosition;
    const cell = derived.facts.find(f => f.rowNum === derivedPosition);
    if (!cell?.active || cell.claim !== oracle.claim || (cell.source ?? '') !== (row.source ?? '')
      || cell.visibility !== row.visibility || derivedPosition === null) return refuse('unbound_candidate');
    if (boundPositions.has(derivedPosition)) return refuse('ambiguous_candidate_mapping');
    boundPositions.add(derivedPosition);
    return { original_fact_id: id, original_row_num: originalPosition, original_sha256: digest(row),
      derived_row_num: derivedPosition, derived_claim: cell.claim };
  });
  return { schema: 'gbrain.preserved-fence-publication.v1', source_id: sourceId, entity_slug: entitySlug,
    original_source_sha256: digest(input.source), original_page_sha256: preservedPageDigest(input.page), original_body_sha256: sha256(body),
    original_facts: rows.map(row => ({ id: identity(row.id), sha256: digest(row) })),
    columns: structuredClone(columns), derived_body: plan.body, bindings };
}

/** Replan from current complete originals, not from the publication's asserted prestate. */
export function validatePreservedFencePublication(publication: PreservedFencePublication, current: PreservedFenceInputs): void {
  const expected = planPreservedFencePublication(current);
  if (stableJson(publication) !== stableJson(expected)) refuse('original_or_derived_drift');
}
