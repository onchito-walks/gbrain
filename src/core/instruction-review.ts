/** Recover an exact-content operator review from the trusted persistence journal.
 * A file's override is not authority: only a committed, local quarantine-clear
 * receipt can cover an instruction flag. No tier, source rule or size gate changes.
 */
import type { BrainEngine } from './engine.ts';
import { parseMarkdown, type ParsedMarkdown } from './markdown.ts';
import { hasCurrentQuarantineOverride, QUARANTINE_OVERRIDE_KEY } from './quarantine-override.ts';
import { assessPageForGate, DEFAULT_WRITE_GATE_CONFIG, WRITE_GATE_DETECTOR_VERSION, type WriteGateAssessment } from './write-gate.ts';
import { sha256, stableJson } from './persistence/digest.ts';

type ReviewPage = Pick<ParsedMarkdown, 'title' | 'type' | 'compiled_truth' | 'timeline' | 'frontmatter'>;

// Gate-owned bookkeeping is not author content. Canonical equality leaves
// stored detector/provenance hashes untouched and retains array ordering.
const REVIEW_BOOKKEEPING = new Set(['quarantine', 'content_flag', 'embed_skip', 'atoms_scan_hash', 'quarantine_override']);
function reviewedContent(page: ReviewPage): string {
  return stableJson({ title: page.title, type: page.type, body: page.compiled_truth, timeline: page.timeline ?? '',
    frontmatter: Object.fromEntries(Object.entries(page.frontmatter).filter(([key]) => !REVIEW_BOOKKEEPING.has(key))) });
}

/** The compact proof the trusted clear preparer stamps into its terminal
 * outcome. Outcomes survive intent compaction, so a review does not depend on
 * retaining a second copy of the document. Only this exact content and detector
 * version are covered; any edit reopens review.
 */
export function instructionReviewEvidence(page: ReviewPage): Record<string, unknown> | null {
  const marker = page.frontmatter[QUARANTINE_OVERRIDE_KEY] as Record<string, unknown> | undefined;
  if (!marker || marker.write_gate_detector_version !== WRITE_GATE_DETECTOR_VERSION || !hasCurrentQuarantineOverride(page)) return null;
  return { schema_version: 1, detector_version: WRITE_GATE_DETECTOR_VERSION, marker, content_digest: sha256(reviewedContent(page)) };
}

export async function recoverInstructionReview(
  engine: Pick<BrainEngine, 'executeRaw'>,
  page: ReviewPage,
  target: { sourceId: string; slug: string },
  assessment: WriteGateAssessment,
): Promise<string | null> {
  if (assessment.detectorError || !assessment.contentHash || assessment.verdict === 'allow') return null;
  try {
    const rows = await engine.executeRaw<{ id: string; content: string | null; remote: string; state: string; review?: Record<string, unknown> }>(
      `SELECT r.id::text AS id, r.intent->>'content' AS content,
              r.authority->>'remote' AS remote, r.state, r.outcome->'instruction_review' AS review
         FROM persistence_requests r
         JOIN sources s ON s.id = r.source_id AND s.incarnation = r.source_incarnation
         JOIN pages p ON p.id = r.page_id AND p.source_id = r.source_id
                     AND p.slug = r.slug AND p.deleted_at IS NULL
        WHERE r.source_id = $1 AND r.slug = $2 AND r.operation = 'put_page'
          AND (r.intent->>'kind' = 'managed_quarantine_clear' OR r.outcome ? 'instruction_review')
          AND r.authority->>'remote' = 'false' AND r.state = 'committed'
          AND (r.intent IS NULL OR length(r.intent->>'content') <= 1048576)
        ORDER BY r.created_at DESC LIMIT 10`, [target.sourceId, target.slug]);
    for (const row of rows) {
      if (row.remote !== 'false' || row.state !== 'committed') continue;
      const proof = row.review;
      if (proof?.schema_version === 1 && proof.detector_version === WRITE_GATE_DETECTOR_VERSION &&
          proof.content_digest === sha256(reviewedContent(page)) &&
          hasCurrentQuarantineOverride({ ...page, frontmatter: { ...page.frontmatter, [QUARANTINE_OVERRIDE_KEY]: proof.marker } })) {
        page.frontmatter[QUARANTINE_OVERRIDE_KEY] = proof.marker;
        return row.id;
      }
      // Pre-compaction receipts carry the full reviewed document instead.
      if (typeof row.content !== 'string') continue;
      const reviewed = parseMarkdown(row.content, `${target.slug}.md`, { validate: true });
      const marker = reviewed.frontmatter[QUARANTINE_OVERRIDE_KEY] as Record<string, unknown> | undefined;
      if (!marker || marker.write_gate_detector_version !== WRITE_GATE_DETECTOR_VERSION ||
          !hasCurrentQuarantineOverride(reviewed) || !hasCurrentQuarantineOverride({ ...page,
            frontmatter: { ...page.frontmatter, [QUARANTINE_OVERRIDE_KEY]: marker } })) continue;
      // Compare canonical content, never order-sensitive detector hashes:
      // serialization may reorder keys without changing any value.
      const original = assessPageForGate(reviewed, { tier: 'unknown' }, DEFAULT_WRITE_GATE_CONFIG);
      if (original.detectorError || reviewedContent(reviewed) !== reviewedContent(page)) continue;
      page.frontmatter[QUARANTINE_OVERRIDE_KEY] = marker;
      return row.id;
    }
  } catch { /* Missing/compacted/unreadable journal evidence is never a bypass. */ }
  return null;
}
