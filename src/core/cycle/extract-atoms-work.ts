/**
 * Work-item assembly for extract_atoms (B12 peel, behavior-preserving).
 *
 * Peeled out of `runPhaseExtractAtoms` so that function keeps its
 * scripts/function-size-baseline.tsv row while the execution-boundary
 * quarantine re-check gains its call site; the merge itself is unchanged.
 *
 * Dual-source merge: transcripts + pages, dedup by contentHash.
 *    Transcripts win on COLLISION (origin attribution stays with the raw
 *    transcript file even if the same content was later imported as a
 *    brain page) — that's decided by the two loops below, which register
 *    every transcript hash into `seenHashes` before any page is checked.
 *
 *    Order is page-item-first, interleaved 1-for-1 with transcripts (NOT
 *    concatenated transcripts-then-pages). The per-call budget cap
 *    (foreground `work` order in runPhaseExtractAtoms) stops processing
 *    `work` in list order once `budgetTracker.totalSpent >= budgetCap`,
 *    skipping everything after that point. Two failure modes this avoids:
 *      - Concatenation (old code): a transcript corpus that alone
 *        exceeds the budget cap starves the page pool completely, no
 *        matter how many drain batches run.
 *      - Interleaving with transcripts first: still starves ALL pages
 *        whenever the budget only covers exactly one call (item 0 is a
 *        transcript, item 1 — the first page — never gets attempted).
 *    Pages are the ONLY pool `countExtractAtomsBacklog`/doctor's
 *    extract_atoms_backlog check measures (see that function's
 *    docstring), so page-first guarantees the doctor-visible backlog
 *    makes forward progress on every budget-capped call, however tight
 *    the cap — `--drain` can no longer report the same backlog number
 *    forever while atoms keep getting extracted from transcripts.
 */

import type { AtomPageInput } from './extract-atoms-page-state.ts';

export type AtomWorkItem =
  | { kind: 'transcript'; filePath: string; content: string; contentHash: string }
  | ({ kind: 'page' } & AtomPageInput);

export interface AtomWorkList {
  /** Live transcripts after source-hash/tombstone idempotency, deduped by content. */
  transcriptItems: AtomWorkItem[];
  /** Discovered (or seam-supplied) pages, deduped by content against transcripts. */
  pageItems: AtomWorkItem[];
  /** The execution order: page-first, interleaved 1-for-1 with transcripts. */
  work: AtomWorkItem[];
  /** Transcripts dropped as a same-content duplicate of an earlier transcript. */
  duplicateTranscripts: number;
  /** Pages dropped because a transcript (or an earlier page) already carried their content. */
  duplicatePages: number;
}

export function buildAtomWorkList(
  transcriptsLive: ReadonlyArray<{ filePath: string; content: string; contentHash: string }>,
  pages: ReadonlyArray<AtomPageInput>,
): AtomWorkList {
  const seenHashes = new Set<string>();
  const transcriptItems: AtomWorkItem[] = [];
  let duplicateTranscripts = 0;
  for (const t of transcriptsLive) {
    if (seenHashes.has(t.contentHash)) { duplicateTranscripts++; continue; }
    seenHashes.add(t.contentHash);
    transcriptItems.push({ kind: 'transcript', ...t });
  }
  const pageItems: AtomWorkItem[] = [];
  let duplicatePages = 0;
  for (const p of pages) {
    if (seenHashes.has(p.contentHash)) { duplicatePages++; continue; }
    seenHashes.add(p.contentHash);
    pageItems.push({ kind: 'page', ...p });
  }
  const work: AtomWorkItem[] = [];
  const maxPoolLen = Math.max(transcriptItems.length, pageItems.length);
  for (let i = 0; i < maxPoolLen; i++) {
    if (i < pageItems.length) work.push(pageItems[i]);
    if (i < transcriptItems.length) work.push(transcriptItems[i]);
  }
  return { transcriptItems, pageItems, work, duplicateTranscripts, duplicatePages };
}
