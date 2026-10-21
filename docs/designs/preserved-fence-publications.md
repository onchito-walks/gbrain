# Preserved fence publication boundary

Status: INSTALLED. `src/core/facts/preserved-fence-publication.ts` plans and
validates the separate representation, `src/core/facts/preserved-fence-store.ts`
publishes it through the existing owner/journal, and the v0.32.2 migration's
phase B (the shared `src/core/facts/unfenced-facts.ts` pass the `extract_facts`
cycle also runs) publishes it instead of rewriting originals. This document does
not claim migration acceptance: the freeze, the protected build and the strict
delta/native rehearsal are separate.

## Representation

`src/core/facts/preserved-fence-publication.ts` takes complete source/page/fact
records with explicit column manifests, the literal source-bound document and
an explicit candidate ID set. It reuses the native codec planner through
`planFenceWithOccupiedRows`. The result is a distinct derived document plus
explicit original-fact-to-derived-position bindings. An original NULL remains
NULL, an original position 5 remains 5 even when the derived position is 9,
and any codec-normalized claim exists only in the derived document/binding.
Original source, page, body and every supplied fact/provenance column are
fingerprinted with the existing persistence digest helpers; the complete
supplied original fact population is pinned, not merely candidate IDs. The page
digest normalizes the two derivative index columns the publishing write itself
refreshes (`MAINTENANCE_REFRESHED_PAGE_COLUMNS`); every other page column is
covered, and any difference in one of them refuses.

This object is not a write capability. Neither it nor its assignments may be
applied as UPDATEs to original facts or installed over the original page/file.
No storage or owner authority is invented by this module. The adapter proves
column and row population completeness from the engine, never from a
caller-asserted subset. Digest-captured vectors in diagnostic fixtures prove
only equality of those captured digests, not an independent read of the
original vectors.

Validation replans from current complete originals and compares the entire
publication, including its derived document, bindings and manifest. No
normalization is applied to original values. Missing or added original rows,
removed columns, provenance/text/position drift and any unlisted derived
change refuse. Duplicate IDs, ambiguous occupied positions, duplicate claims,
unrenderable candidates and source/page mismatches refuse the entire plan.
Noncandidate conversation-domain zero coordinates are preserved as original
evidence; they are not silently converted into valid fence positions.

## Installed integration

- v0.32.2 phase B publishes the derived representation instead of invoking the
  inline mutator: `fenceFilePage` writes no file, mirrors no body and runs no
  `UPDATE facts`; the managed path submits one
  `managed_maintenance_publish_preserved_fence` request. The canonical file and
  every original fact row are left exactly as they are, so a page whose fence
  step reports `fenced=N` gained N derived positions and no original edit.
- Phase C verifies both coordinate systems independently: the original fence
  against the index rows the document does not bind, and every stored document
  against its page's current originals (plus, per document, that every original
  fence claim survives and every binding is addressable). A document that is no
  longer the plan of its current originals fails the phase by name; pages whose
  adopted rows hold no position at all are verified through the stored documents
  themselves.
- `pendingLegacyRows` recognizes only complete validated publications, so a
  preserved NULL original no longer gates its page forever.
- `planFenceReconcile` binds derived rows to their original identities without
  expiring, detaching, restamping or rewriting them: a bound row is exempt
  unless the page's own fence carries its derived position with exactly its
  stored claim, and it is never re-occupied by an inserted row. A drifted
  document is drift, not authority: the page keeps its index.
- The derived document is a projection the tool maintains: it is recomputed from
  the page's current originals, so a stale one is replaced by a truthful replan
  rather than freezing the page's fence step, and losing the row (a rebuild, a
  restored backup) is not data loss — the next run recreates it. Import/rebuild
  never treats a document as a fact source, and original identities are never
  inferred from matching claim text or a fabricated origin.
- Existing source ownership, trust, withdrawal, deletion, remote authorization,
  idempotency and interruption controls are unchanged: the unmanaged path writes
  inside one maintenance transaction under the page lock, the managed path
  through the coordinator against the page revision, and a publication that is
  already current writes nothing at all.
- **Cycle upkeep precedes strict completion.** The successful-cycle path first
  runs `cycle/preserved-fence-maintenance.ts` over existing publications only.
  It explicitly supersedes a drifted derived document using the existing
  current-originals planner and transactional writer, retaining the old document
  as a version. It never mines atoms or edits original facts/page bodies. A
  current document is a write-free no-op; a concurrent original change refuses
  rather than rebinding a stale plan. The completion transition itself remains
  strict and atomic as described below.
- **Cycle completion is a transition, not a drift repair.**
  `src/core/cycle/preserved-fence-completion.ts` owns the per-source `runCycle`
  stamp. Where a source has stored derived documents, that stamp is not a bare
  `updateSourceConfig`: because the document's complete-source digest covers the
  whole `sources` row, stamping `last_source_cycle_at`/`last_full_cycle_at`
  immediately after publication would invalidate the document it had just
  finished. The completion instead commits the two completion keys and a
  re-derived, version-bound document for every page **in one transaction** (one
  `maintenanceTransaction` unmanaged; one
  `managed_maintenance_complete_preserved_cycle` request through the
  coordinator, admitted against the page revision, for managed brains). Every
  prior document is first asserted to still be the plan of its current
  originals, and the only difference permitted between the pre- and post-image
  of the source is those two keys: a changed config key, page, fact or stored
  document refuses the whole completion. The previous document is retained
  under `${PRESERVED_FENCE_SOURCE}:version:<sha256>` (an additive `raw_data`
  row) and nothing else advances. A failure, an abort or a dry run advances
  neither the stamp nor a document (`stamp_write_failed` still degrades the run
  to `partial`). Unrelated external edits are never blessed and automatic blind
  rebinding is not performed: an explicit supersede is propagated only when the
  caller requests one, and then only after the current-originals check.

## Verification scope

The pure unit suite covers literal NULL/numbered originals, the 5-to-derived-9
collision, already-paired rows, normalized derived claims, duplicate and
ambiguous candidates, complete population/provenance drift, source isolation,
idempotent replanning and refusal without input mutation. The store suite adds
the publication path (originals byte-identical, canonical plan stored, drift
refused without supersede, and that a supersede that was requested propagates
onto the managed request while an unrequested one does not). The completion
suite (`test/preserved-fence-completion.test.ts`, unmanaged and managed,
PGLite and Postgres) covers: the atomic version-bound completion with literal
originals; pre-existing unrelated source-config, completion-key, page, fact and
stored-document drift each refusing with the stamp and every stored row
unchanged; a concurrent source/page/fact edit committed between planning and
apply refusing without rebinding; dry-run and last-phase abort advancing
nothing; and a post-stamp storage failure rolling the source, the documents and
the original-row changes back together while the run reports
`stamp_write_failed`. The adoption suite drives the shared pass and the
migration's own phases over real originals. Pure planning is not publication
crash/recovery proof: the freeze, the protected build and the strict
delta/native rehearsal remain required.
