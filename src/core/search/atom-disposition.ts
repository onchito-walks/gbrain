/**
 * Read-time atom DISPOSITION enrichment — READ-ONLY.
 *
 * WHY THIS EXISTS
 * ---------------
 * A finite, historical evidence-repair pass assessed a set of atoms and recorded
 * each verdict on a SEPARATE canonical companion page (never on the atom
 * itself, so the atom's own body / contentHash / sync authority are untouched).
 * This module reads those companion assessments back at READ time and surfaces
 * a single, validated `atom_disposition` on `search` results and on `get_page`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is NOT a reconciliation, a repair, or a re-bind. It NEVER writes the
 * atom, its frontmatter, `source_hash`, `content_hash`, or any companion page.
 * It makes NO model calls. A disposition is a HISTORICAL assessment, explicitly
 * flagged `historical: true` / `certified: false` and always carrying a warning:
 * it is informational evidence about the atom, never a certification that the
 * atom is correct or that its binding was restored.
 *
 * SOURCE OF TRUTH
 * ---------------
 * Companion pages are canonical vault pages: `type: 'note'`, slug prefix
 * `operations/atom-evidence-repair-20261011/assessments-`, each carrying a
 * frontmatter `atom_assessments` array of records:
 *
 *   { atom_id:number, atom_slug:string, source_id:string,
 *     frozen_source_hash:string, frozen_source_slug:string, body_sha256:string,
 *     status:string, explanation:string,
 *     evidence_slug?:string, successor_slug?:string, assessed_at:string }
 *
 * ISOLATION + GUARDS (fail closed, no model calls)
 * ------------------------------------------------
 *   - same source only: a companion page in a DIFFERENT source than the atom is
 *     never consulted (source_id isolation);
 *   - visibility only: the companion page (and any referenced slug) must be a
 *     live, non-deleted, non-quarantined page — plus non-private when the caller
 *     is untrusted (`excludePrivate`);
 *   - exact binding: a record only counts when atom_id, atom_slug, source_id,
 *     frozen_source_hash, frozen_source_slug AND body_sha256 ALL match the live
 *     atom row exactly;
 *   - absent / malformed / conflicting / stale markers FAIL CLOSED: no trusted
 *     status is emitted, only a warning disposition (`status: 'untrusted'`);
 *   - references are sanitized: only well-formed canonical slugs that resolve to
 *     a live, visible page in the SAME source are exposed — never a local
 *     filesystem path, a `~`/absolute path, or a private evidence path.
 *
 * The covered-atom retrieval policy is unchanged by this module; it stamps
 * metadata only and never affects coverage, filtering, or ranking.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PageReadPolicy, SearchResult } from '../types.ts';
import { pageReadFilter } from './read-policy-sql.ts';

/** Companion-page slug prefix. Stable contract with the evidence-repair pass. */
export const ATOM_ASSESSMENT_SLUG_PREFIX = 'operations/atom-evidence-repair-20261011/assessments-';

/** Frontmatter key holding the assessment record array. Stable contract. */
export const ATOM_ASSESSMENTS_KEY = 'atom_assessments';

/** The fail-closed status sentinel (never a value taken from a record). */
export const ATOM_DISPOSITION_UNTRUSTED = 'untrusted';

export type AtomDispositionWarningCode =
  | 'historical_not_certified'
  | 'assessment_stale'
  | 'assessment_conflict'
  | 'assessment_untrusted';

export interface AtomDispositionWarning {
  code: AtomDispositionWarningCode;
  message: string;
}

/**
 * The top-level enrichment surfaced on an atom search result / get_page. Every
 * field is derived from a validated companion record, except `historical`,
 * `certified` and `warning` which are always the module's own honest framing.
 */
export interface AtomDisposition {
  /** Verbatim assessment status, or `'untrusted'` for a fail-closed marker. */
  status: string;
  /** Human-readable explanation from the assessment record. */
  explanation: string;
  /** ISO timestamp the assessment was recorded. */
  assessed_at: string;
  /** The canonical companion page slug the record was read from (same source). */
  assessment_slug: string;
  /** The source_id the disposition is scoped to (== the atom's own source). */
  source_id: string;
  /** Always true — a historical assessment, not a live certification. */
  historical: true;
  /** Always false — never a certification of the atom's correctness. */
  certified: false;
  /** Always present — the honest framing / fail-closed reason. */
  warning: AtomDispositionWarning;
  /** Safe same-source canonical reference, only when it resolves to a live page. */
  evidence_slug?: string;
  /** Safe same-source canonical reference, only when it resolves to a live page. */
  successor_slug?: string;
}

/** One `atom_assessments[]` record (loosely typed on read — validated per atom). */
export interface AtomAssessmentRecord {
  atom_id: number;
  atom_slug: string;
  source_id: string;
  frozen_source_hash: string;
  frozen_source_slug: string;
  body_sha256: string;
  status: string;
  explanation: string;
  evidence_slug?: string;
  successor_slug?: string;
  assessed_at: string;
}

/** The live atom row an assessment is validated against (the "original"). */
export interface AtomDispositionInput {
  id: number;
  slug: string;
  source_id: string;
  source_hash: string | null;
  source_slug: string | null;
  /** sha256 hex of the atom's `compiled_truth` (see computeAtomBodySha256). */
  body_sha256: string;
}

/**
 * The ONE body-hash definition shared with the evidence-repair pass: sha256 hex
 * over the atom page's `compiled_truth` EXACTLY as stored (UTF-8, no trim, no
 * normalization). Exported so the producer and this reader cannot drift.
 */
export function computeAtomBodySha256(compiledTruth: string | null | undefined): string {
  return createHash('sha256').update(compiledTruth ?? '', 'utf8').digest('hex');
}

const HISTORICAL_WARNING: AtomDispositionWarning = {
  code: 'historical_not_certified',
  message:
    'Historical evidence-repair assessment — informational only, NOT a certification of the atom. ' +
    'Verify against the live source before relying on it.',
};

const STALE_MESSAGE =
  'An assessment exists for this atom but its frozen binding (source hash/slug or body hash) no longer ' +
  'matches the live atom — the atom changed since it was assessed. Disposition withheld (fail-closed).';

const CONFLICT_MESSAGE =
  'Multiple assessment records for this atom disagree on status. Disposition withheld (fail-closed).';

const UNTRUSTED_MESSAGE =
  'An assessment record for this atom is malformed and cannot be validated. Disposition withheld (fail-closed).';

interface RawCandidate {
  record: AtomAssessmentRecord;
  assessment_slug: string;
}

/** Coerce a JSONB value that may arrive parsed (object/array) or as a JSON string. */
function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Lenient atom_id extraction for candidate selection (numeric or numeric string). */
function candidateAtomId(rec: unknown): number | null {
  if (!rec || typeof rec !== 'object') return null;
  const v = (rec as Record<string, unknown>).atom_id;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v);
  return null;
}

function isRecordWellFormed(value: unknown): value is AtomAssessmentRecord {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.atom_id === 'number' && Number.isFinite(o.atom_id) &&
    typeof o.atom_slug === 'string' &&
    typeof o.source_id === 'string' &&
    typeof o.frozen_source_hash === 'string' &&
    typeof o.frozen_source_slug === 'string' &&
    typeof o.body_sha256 === 'string' &&
    typeof o.status === 'string' &&
    typeof o.explanation === 'string' &&
    typeof o.assessed_at === 'string' &&
    (o.evidence_slug === undefined || typeof o.evidence_slug === 'string') &&
    (o.successor_slug === undefined || typeof o.successor_slug === 'string')
  );
}

/** Exact binding: every frozen field must match the live atom row. */
function bindingMatches(a: AtomDispositionInput, r: AtomAssessmentRecord): boolean {
  return (
    r.atom_id === a.id &&
    r.atom_slug === a.slug &&
    r.source_id === a.source_id &&
    r.frozen_source_hash === a.source_hash &&
    r.frozen_source_slug === a.source_slug &&
    r.body_sha256 === a.body_sha256
  );
}

/** Reject anything that is not a well-formed canonical slug (paths, schemes, traversal). */
export function isSafeSlugShape(value: string): boolean {
  const s = value.trim();
  if (s.length === 0 || s.length > 512) return false;
  if (s !== value) return false; // leading/trailing whitespace — not a canonical slug
  if (s.startsWith('/') || s.startsWith('~')) return false;
  if (s.includes('\\')) return false;
  if (s.includes('://')) return false;
  if (/^[a-zA-Z]:/.test(s)) return false; // Windows drive / scheme-ish prefix
  if (/[\u0000-\u001f\u007f]/.test(s)) return false; // control chars
  if (/\s/.test(s)) return false;
  if (s.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return true;
}

function safeReference(value: unknown, safeSlugs: ReadonlySet<string>): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!isSafeSlugShape(value)) return undefined;
  return safeSlugs.has(value) ? value : undefined;
}

function latestAssessedAt(candidates: readonly RawCandidate[]): string {
  let best = '';
  for (const c of candidates) {
    const t = typeof c.record.assessed_at === 'string' ? c.record.assessed_at : '';
    if (t > best) best = t;
  }
  return best;
}

function pickLatest(candidates: readonly RawCandidate[]): RawCandidate {
  let best = candidates[0];
  for (const c of candidates) {
    const a = typeof c.record.assessed_at === 'string' ? c.record.assessed_at : '';
    const b = typeof best.record.assessed_at === 'string' ? best.record.assessed_at : '';
    if (a > b || (a === b && c.assessment_slug > best.assessment_slug)) best = c;
  }
  return best;
}

function dispositionFrom(a: AtomDispositionInput, c: RawCandidate, safeSlugs: ReadonlySet<string>): AtomDisposition {
  const r = c.record;
  const d: AtomDisposition = {
    status: r.status,
    explanation: r.explanation,
    assessed_at: r.assessed_at,
    assessment_slug: c.assessment_slug,
    source_id: a.source_id,
    historical: true,
    certified: false,
    warning: { ...HISTORICAL_WARNING },
  };
  const evidence = safeReference(r.evidence_slug, safeSlugs);
  if (evidence) d.evidence_slug = evidence;
  const successor = safeReference(r.successor_slug, safeSlugs);
  if (successor) d.successor_slug = successor;
  return d;
}

function failClosed(
  a: AtomDispositionInput,
  code: Exclude<AtomDispositionWarningCode, 'historical_not_certified'>,
  assessmentSlug: string,
  assessedAt: string,
): AtomDisposition {
  const message = code === 'assessment_stale'
    ? STALE_MESSAGE
    : code === 'assessment_conflict'
      ? CONFLICT_MESSAGE
      : UNTRUSTED_MESSAGE;
  return {
    status: ATOM_DISPOSITION_UNTRUSTED,
    explanation: message,
    assessed_at: assessedAt,
    assessment_slug: assessmentSlug,
    source_id: a.source_id,
    historical: true,
    certified: false,
    warning: { code, message },
  };
}

/**
 * Pure per-atom decision over already-loaded candidates (same source, visible).
 * Absent (no candidate with this atom_id) → undefined. Everything else fails
 * closed rather than presenting an unverifiable status.
 */
export function resolveAtomDisposition(
  a: AtomDispositionInput,
  candidates: readonly RawCandidate[],
  safeSlugs: ReadonlySet<string>,
): AtomDisposition | undefined {
  const mine = candidates.filter((c) => candidateAtomId(c.record) === a.id);
  if (mine.length === 0) return undefined;

  const malformed: RawCandidate[] = [];
  const stale: RawCandidate[] = [];
  const valid: RawCandidate[] = [];
  for (const c of mine) {
    if (!isRecordWellFormed(c.record)) malformed.push(c);
    else if (!bindingMatches(a, c.record)) stale.push(c);
    else valid.push(c);
  }

  if (valid.length > 0) {
    const statuses = new Set(valid.map((c) => c.record.status));
    if (statuses.size > 1) {
      return failClosed(a, 'assessment_conflict', pickLatest(valid).assessment_slug, latestAssessedAt(valid));
    }
    return dispositionFrom(a, pickLatest(valid), safeSlugs);
  }
  if (stale.length > 0) {
    return failClosed(a, 'assessment_stale', stale[0].assessment_slug, latestAssessedAt(stale));
  }
  return failClosed(a, 'assessment_untrusted', malformed[0].assessment_slug, latestAssessedAt(malformed));
}

export interface LoadAtomDispositionsOptions {
  /** When true, `visibility: private` companion/reference pages are hidden. */
  excludePrivate?: boolean;
}

/**
 * Batched, read-only load. Groups atoms by their own source and reads only the
 * companion pages in that SAME source that carry a record for one of the atom
 * ids. Best-effort callers (search/get_page) should wrap this and never let it
 * break retrieval.
 */
export async function loadAtomDispositions(
  engine: BrainEngine,
  atoms: readonly AtomDispositionInput[],
  opts: LoadAtomDispositionsOptions = {},
): Promise<Map<number, AtomDisposition>> {
  const out = new Map<number, AtomDisposition>();
  if (atoms.length === 0) return out;

  const bySource = new Map<string, AtomDispositionInput[]>();
  for (const a of atoms) {
    const list = bySource.get(a.source_id) ?? [];
    list.push(a);
    bySource.set(a.source_id, list);
  }

  for (const [sourceId, group] of bySource) {
    const ids = [...new Set(group.map((a) => a.id))];
    if (ids.length === 0) continue;
    const scope = { sourceId, ...(opts.excludePrivate ? { excludePrivate: true } : {}) };

    // 1. Companion pages in this source carrying an assessment for these ids.
    const params: unknown[] = [ids];
    const filter = pageReadFilter('p', scope, params, true);
    params.push(`${ATOM_ASSESSMENT_SLUG_PREFIX}%`);
    const pageRows = await engine.executeRaw<{ slug: string; assessments: unknown }>(
      `SELECT p.slug, p.frontmatter->'${ATOM_ASSESSMENTS_KEY}' AS assessments
         FROM pages p
        WHERE ${filter}
          AND p.type = 'note'
          AND p.slug LIKE $${params.length}
          AND jsonb_typeof(p.frontmatter->'${ATOM_ASSESSMENTS_KEY}') = 'array'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.frontmatter->'${ATOM_ASSESSMENTS_KEY}') e
             WHERE (e->>'atom_id') ~ '^[0-9]+$'
               AND (e->>'atom_id')::bigint = ANY($1::bigint[])
          )`,
      params,
    );

    const candidates: RawCandidate[] = [];
    for (const row of pageRows) {
      for (const rec of coerceArray(row.assessments)) {
        if (rec && typeof rec === 'object') {
          candidates.push({ record: rec as AtomAssessmentRecord, assessment_slug: row.slug });
        }
      }
    }
    if (candidates.length === 0) continue;

    // 2. Resolve which referenced slugs are safe same-source canonical pages.
    const refSlugs = new Set<string>();
    for (const c of candidates) {
      for (const v of [c.record.evidence_slug, c.record.successor_slug]) {
        if (typeof v === 'string' && isSafeSlugShape(v)) refSlugs.add(v);
      }
    }
    const safeSlugs = new Set<string>();
    if (refSlugs.size > 0) {
      const refParams: unknown[] = [[...refSlugs]];
      const refFilter = pageReadFilter('p', scope, refParams, true);
      const refRows = await engine.executeRaw<{ slug: string }>(
        `SELECT p.slug FROM pages p WHERE p.slug = ANY($1::text[]) AND ${refFilter}`,
        refParams,
      );
      for (const r of refRows) safeSlugs.add(r.slug);
    }

    // 3. Decide per atom.
    for (const a of group) {
      const d = resolveAtomDisposition(a, candidates, safeSlugs);
      if (d) out.set(a.id, d);
    }
  }

  return out;
}

/**
 * Best-effort read-time stamp for search results: clears any stale
 * `atom_disposition` (so a cached row is re-enriched with CURRENT data) and
 * stamps the freshly-validated disposition on atom results. Never throws.
 */
export async function stampAtomDispositions(
  engine: BrainEngine,
  results: SearchResult[],
  policy?: PageReadPolicy,
): Promise<void> {
  // Clear first: a cached/stored row must never keep a stale disposition.
  for (const r of results) {
    if (r.atom_disposition !== undefined) delete r.atom_disposition;
  }
  const atomResults = results.filter((r) => r.type === 'atom');
  if (atomResults.length === 0) return;
  try {
    const ids = [...new Set(
      atomResults
        .map((r) => r.page_id)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
    )];
    if (ids.length === 0) return;
    const rows = await engine.executeRaw<{
      id: number;
      source_id: string | null;
      slug: string;
      ss: string | null;
      sh: string | null;
      body: string | null;
    }>(
      `SELECT id, source_id, slug,
              frontmatter->>'source_slug' AS ss,
              frontmatter->>'source_hash' AS sh,
              compiled_truth AS body
         FROM pages
        WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
      [ids],
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const inputs: AtomDispositionInput[] = [];
    for (const r of atomResults) {
      const row = byId.get(r.page_id);
      if (!row) continue;
      inputs.push({
        id: Number(row.id),
        slug: row.slug,
        source_id: row.source_id ?? 'default',
        source_hash: row.sh,
        source_slug: row.ss,
        body_sha256: computeAtomBodySha256(row.body ?? ''),
      });
    }
    if (inputs.length === 0) return;
    const dispositions = await loadAtomDispositions(engine, inputs, { excludePrivate: policy?.excludePrivate });
    for (const r of atomResults) {
      const d = dispositions.get(r.page_id);
      if (d) r.atom_disposition = d;
    }
  } catch {
    // best-effort: never break retrieval.
  }
}

/** The minimal page shape get_page needs (a Page satisfies this structurally). */
export interface AtomDispositionPage {
  id: number;
  slug: string;
  source_id: string;
  compiled_truth: string;
  frontmatter: Record<string, unknown> | null | undefined;
}

/**
 * Single-atom load for get_page. Callers must invoke this AFTER scope/private
 * handling has resolved the final readable page. Never throws.
 */
export async function loadAtomDispositionForPage(
  engine: BrainEngine,
  page: AtomDispositionPage,
  opts: LoadAtomDispositionsOptions = {},
): Promise<AtomDisposition | undefined> {
  const fm = page.frontmatter ?? {};
  const input: AtomDispositionInput = {
    id: page.id,
    slug: page.slug,
    source_id: page.source_id,
    source_hash: typeof fm.source_hash === 'string' ? fm.source_hash : null,
    source_slug: typeof fm.source_slug === 'string' ? fm.source_slug : null,
    body_sha256: computeAtomBodySha256(page.compiled_truth ?? ''),
  };
  try {
    const map = await loadAtomDispositions(engine, [input], opts);
    return map.get(page.id);
  } catch {
    return undefined;
  }
}
