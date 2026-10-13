/**
 * Named, evidenced exceptions to the v0.32.2 Phase C fence ↔ database pairing
 * gate (the `verify` phase) — production data conditions the owner ruled are
 * ACCEPTED as pre-existing, not repaired.
 *
 * Contract (owner ruling 2026-10-13, kanban t_084a589b):
 *   - strict by default: every comparison is unchanged, and drift that is not
 *     named here still fails the phase exactly as before;
 *   - tolerance is per CONDITION, never a class: an entry names one exact page
 *     slug and the ONE observation it tolerates, matched field by field (the
 *     surface the comparison read, the row numbers, and the counts). A page
 *     that drifts differently, or that gains or loses a row, is NOT covered —
 *     the gate bites again and says so;
 *   - the tolerance path only re-classifies an observation the gate already
 *     made. It never deletes, re-keys, re-stamps, re-numbers or rewrites a row
 *     or a file byte;
 *   - a run that tolerates a listed exception always reports it by name
 *     (`phaseCVerify` prints it and carries it in the phase detail), so an
 *     accepted condition is never silently suppressed;
 *   - there is no environment switch, no prefix rule, no wildcard, no
 *     threshold and no "ignore verify failures" flag. Adding or removing an
 *     entry is a reviewed source change with a written rationale.
 *
 * Why these are tolerated instead of repaired: the standing rule is that data
 * is never deleted, archived or purged to reach a green verify. Every candidate
 * repair for the conditions below would either delete a row (data loss) or
 * invent one (fabricated provenance). Re-keying the orphaned prefixed-slug rows
 * is a provenance change that needs its own explicit authorization; the
 * fence/database wording divergence is a hand edit whose authoritative side
 * only the owner can pick. Until such authorization lands, the exception is the
 * honest record: detected, reported, and not repaired.
 *
 * Evidence: `stage5/logs/repair99/iso-c9f7df36/RECEIPT.md` §7. The signatures
 * below were re-derived read-only from the production rows and reproduce
 * identically in the retained pre-image (`stage5-fresh_t_c9f7df36`, schema 165)
 * and in the post-chain clone (`chain3`, schema 239).
 */

/** Which side of the comparison produced the observation. */
export type FenceDriftSurface = 'file' | 'page';

/**
 * A page-missing observation: the database carries fence-owned rows for a slug
 * whose page/file does not exist.
 */
export interface PageMissingObservation {
  kind: 'page_missing';
  sourceId: string;
  slug: string;
  surface: FenceDriftSurface;
  /** Every row number the database carries for the slug, ascending. */
  rows: number[];
}

/**
 * A fence/database divergence: both sides exist and disagree about which row
 * numbers are paired.
 */
export interface FenceDivergenceObservation {
  kind: 'fence_divergence';
  sourceId: string;
  slug: string;
  surface: FenceDriftSurface;
  /** Number of fence rows parsed. */
  fence: number;
  /** Number of distinct non-conversation-miner row numbers in the database. */
  db: number;
  /** Fence positions with no database row. */
  notIndexed: number[];
  /** Database positions with no fence row. */
  notInFence: number[];
}

export type FenceDriftObservation = PageMissingObservation | FenceDivergenceObservation;

export interface FenceDriftException {
  /** The exact page slug. Never a prefix, glob, pattern or slug class. */
  slug: string;
  /** The source the observation must belong to. */
  sourceId: string;
  /** The only observation tolerated for this slug, matched field by field. */
  tolerates: FenceDriftObservation;
  /** Why this condition is accepted rather than repaired. */
  rationale: string;
  /** Where the evidence for the accepted condition lives. */
  evidence: string;
  /** Who ruled, and when. */
  ruling: string;
}

const EVIDENCE_ROOT =
  '/srv/minio/native/ubuntu-root-offload/gbrain-port/stage5/logs/repair99/iso-c9f7df36';

/**
 * The accepted conditions. Every entry is a specific, reproduced production
 * data state — not a policy.
 */
export const FENCE_DRIFT_EXCEPTIONS: readonly FenceDriftException[] = [
  {
    slug: 'hermes-moncho/concepts/leviathan-seven-patterns',
    sourceId: 'default',
    tolerates: {
      kind: 'page_missing',
      sourceId: 'default',
      slug: 'hermes-moncho/concepts/leviathan-seven-patterns',
      surface: 'file',
      rows: [1, 2],
    },
    rationale:
      'Legacy import shape: 2 stamped `facts` rows carry the prefixed ' +
      '`hermes-moncho/concepts/...` slug while the page lives at the unprefixed ' +
      '`concepts/leviathan-seven-patterns`. Both claims are already present ' +
      'verbatim under the canonical slug, so nothing is missing from the brain. ' +
      'Re-keying the rows would be a provenance change (and would collide on ' +
      'row_num with the canonical rows); deleting them to reach green is ' +
      'forbidden. Accepted, untouched.',
    evidence: `${EVIDENCE_ROOT}/RECEIPT.md §7; observed rows: 2 (row_num 1, 2, source mcp:put_page)`,
    ruling: 'owner ruling 2026-10-13 (kanban t_084a589b): accept as permanent exception',
  },
  {
    slug: 'hermes-moncho/concepts/raymonddelgado-com-design-policy',
    sourceId: 'default',
    tolerates: {
      kind: 'page_missing',
      sourceId: 'default',
      slug: 'hermes-moncho/concepts/raymonddelgado-com-design-policy',
      surface: 'file',
      rows: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
        12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
      ],
    },
    rationale:
      'Same legacy import shape as the leviathan page, 22 rows instead of 2: ' +
      'the prefixed `hermes-moncho/concepts/raymonddelgado-com-design-policy` ' +
      'slug carries the stamped rows while the page lives at the unprefixed ' +
      'slug, where all 22 claim texts are already present verbatim. Same ' +
      're-keying/provenance objection, same prohibition on deleting rows to ' +
      'reach green. Accepted, untouched.',
    evidence: `${EVIDENCE_ROOT}/RECEIPT.md §7; observed rows: 22 (row_num 1..22, source mcp:extract_facts/mcp:put_page)`,
    ruling: 'owner ruling 2026-10-13 (kanban t_084a589b): accept as permanent exception',
  },
  {
    slug: 'projects/rayops-tailscale-control-tunnel',
    sourceId: 'default',
    tolerates: {
      kind: 'fence_divergence',
      sourceId: 'default',
      slug: 'projects/rayops-tailscale-control-tunnel',
      surface: 'file',
      fence: 9,
      db: 8,
      notIndexed: [5],
      notInFence: [],
    },
    rationale:
      'Genuine file/database disagreement, not drift introduced by the repair. ' +
      'The live file\'s `## Facts` fence row 5 was hand-edited after the ' +
      '`sync:import` that created the rows ("Check OCI … if present, remove ' +
      'it …"), while the database still holds the original wording of that ' +
      'commitment ("Remove the OCI broad ingress rule …"). Because the fence ' +
      'already occupies position 5, Phase B republishes the database row under ' +
      'the next free position (9), so after the repair the fence carries 9 ' +
      'rows and the database 8: fence row 5 has no database owner. No claim is ' +
      'lost or changed — the original wording is in the fence at row 9 and the ' +
      'database row keeps its id and text. Making this pair clean would need ' +
      'either a fabricated database row or a hand deletion in a live note; ' +
      'which side is authoritative is the owner\'s call, so it is accepted ' +
      'unrepaired meanwhile.',
    evidence: `${EVIDENCE_ROOT}/RECEIPT.md §7; observed: fence=9, db=8, not indexed: 5 (derived read-only from the production rows and the retained pre-image, reproduced identically in clone \`chain3\`)`,
    ruling: 'owner ruling 2026-10-13 (kanban t_084a589b): accept as permanent exception',
  },
];

/**
 * Conditions the owner ruling named that the gate never compares, listed so the
 * exception list is not mistaken for an incomplete implementation of that
 * ruling. Both are prefixed-slug `facts` rows, but their entire group is
 * conversation-miner (`cli:`) sourced, and Phase C skips a group with no
 * non-conversation-miner fenced row — so the gate neither tolerates nor
 * reports them, and adding an entry for them would be dead code that looks like
 * coverage:
 *   - `hermes-moncho/architecture/quiver-trailhead-integration`: its one
 *     prefixed-slug row is `source_markdown_slug =
 *     conversations/hermes-cli-2026-07-11-f69fc5-part-3`, source
 *     `cli:extract-conversation-facts`, row_num 0.
 *   - `hermes-moncho/meetings/hermes-telegram-2026-05-21-ff4931`: one row,
 *     source `cli:extract-conversation-facts:terminal`, row_num 0.
 * The canonical (unprefixed) counterpart page exists for both.
 */
export const NAMED_NOT_GATE_OBSERVABLE: readonly string[] = [
  'hermes-moncho/architecture/quiver-trailhead-integration',
  'hermes-moncho/meetings/hermes-telegram-2026-05-21-ff4931',
];

function sameRowSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((v, i) => v === right[i]);
}

/**
 * Return the exception that tolerates this observation, or null when the
 * observation is not on the list (the caller then fails the phase exactly as
 * before). Matching is exact: slug and source identity, observation kind,
 * surface, and every row number and count the entry records.
 */
export function matchFenceDriftException(observed: FenceDriftObservation): FenceDriftException | null {
  for (const exception of FENCE_DRIFT_EXCEPTIONS) {
    const tolerated = exception.tolerates;
    if (exception.slug !== observed.slug || exception.sourceId !== observed.sourceId) continue;
    if (tolerated.kind !== observed.kind) continue;
    if (tolerated.surface !== observed.surface) continue;
    if (tolerated.kind === 'page_missing' && observed.kind === 'page_missing') {
      if (sameRowSet(tolerated.rows, observed.rows)) return exception;
      continue;
    }
    if (tolerated.kind === 'fence_divergence' && observed.kind === 'fence_divergence') {
      if (tolerated.fence !== observed.fence || tolerated.db !== observed.db) continue;
      if (!sameRowSet(tolerated.notIndexed, observed.notIndexed)) continue;
      if (!sameRowSet(tolerated.notInFence, observed.notInFence)) continue;
      return exception;
    }
  }
  return null;
}

/** The exception's own row list, compacted for a report line. */
function describeRows(rows: readonly number[]): string {
  if (rows.length === 0) return 'none';
  if (rows.length === 1) return `row_num ${rows[0]}`;
  const sorted = [...rows].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
  return contiguous
    ? `row_num ${sorted[0]}..${sorted[sorted.length - 1]} (${sorted.length})`
    : `row_num ${sorted.join(', ')} (${sorted.length})`;
}

/** One line naming what was tolerated, in the gate's own vocabulary. */
export function describeToleratedDrift(exception: FenceDriftException): string {
  const observed = exception.tolerates;
  if (observed.kind === 'page_missing') {
    return `${observed.surface === 'file' ? 'file missing' : 'page missing'}; ` +
      `no page at this slug, ${describeRows(observed.rows)} orphaned`;
  }
  const missing = [
    observed.notIndexed.length > 0 ? `not indexed: ${describeRows(observed.notIndexed)}` : '',
    observed.notInFence.length > 0 ? `not in fence: ${describeRows(observed.notInFence)}` : '',
  ].filter(Boolean).join('; ');
  return `fence=${observed.fence}, db=${observed.db}; ${missing}`;
}

/** The slugs the list covers (for reports and regressions). */
export function fenceDriftExceptionSlugs(): string[] {
  return FENCE_DRIFT_EXCEPTIONS.map(e => e.slug);
}

/**
 * The block `phaseCVerify` prints when it tolerates a named exception: every
 * tolerated condition by name, its reason, and the audit line for entries that
 * this brain did not exercise. Never printed for unlisted drift — that fails.
 */
export function formatToleratedDriftReport(tolerated: readonly FenceDriftException[]): string {
  const lines: string[] = [];
  lines.push(
    `  verify: ${tolerated.length} named pre-existing-drift exception(s) tolerated ` +
    `(accepted data conditions, not repaired; see src/commands/migrations/v0_32_2-drift-exceptions.ts)`,
  );
  for (const exception of tolerated) {
    lines.push(`    • ${exception.slug} — ${describeToleratedDrift(exception)}`);
    lines.push(`      accepted: ${exception.ruling}`);
    lines.push(`      evidence: ${exception.evidence}`);
  }
  const unobserved = FENCE_DRIFT_EXCEPTIONS.filter(e => !tolerated.includes(e)).map(e => e.slug);
  lines.push(`    exceptions not observed in this run: ${unobserved.length > 0 ? unobserved.join(', ') : 'none'}`);
  lines.push('    no row was deleted, re-keyed, re-stamped or rewritten by this tolerance.');
  return lines.join('\n');
}
