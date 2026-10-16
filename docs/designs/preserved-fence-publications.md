# Preserved fence publication boundary

Status: pure planner/validator implemented; NOT installed in the migration or
publication consumers. The current writer still mutates original pages/facts.
This document does not claim migration readiness or authorize deployment.

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
supplied original fact population is pinned, not merely candidate IDs.

This object is not a write capability. Neither it nor its assignments may be
applied as UPDATEs to original facts or installed over the original page/file.
No storage or owner authority is invented by this module. An adapter must
prove column and row population completeness from the engine, not accept a
caller-asserted subset as discovery. Digest-captured vectors in diagnostic
fixtures prove only equality of those captured digests, not an independent
read of the original vectors.

Validation replans from current complete originals and compares the entire
publication, including its derived document, bindings and manifest. No
normalization is applied to original values. Missing or added original rows,
removed columns, provenance/text/position drift and any unlisted derived
change refuse. Duplicate IDs, ambiguous occupied positions, duplicate claims,
unrenderable candidates and source/page mismatches refuse the entire plan.
Noncandidate conversation-domain zero coordinates are preserved as original
evidence; they are not silently converted into valid fence positions.

## Required integration, not implemented by this boundary

A durable adapter must publish the separate derived document and binding
through the existing source owner/journal, retaining the original source and
page bindings and checking them again inside publication. It must not rely on
an unvalidated JSON frontmatter flag, bypass managed writer guards, fabricate
source provenance or silently use database-only publication for a file-backed
source. An incomplete or interrupted publication must remain uncommitted or
resume under the native exact-input idempotency rules.

The following consumers must be integrated together before enabling this path:

- v0.32.2 phase B must publish the derived representation instead of invoking
  the existing inline mutator; phase C must verify original and derived
  coordinates independently. The original page's unrelated fence rows still
  participate in normal drift validation; bindings are not a drift exemption.
- `pendingLegacyRows` must recognize only complete validated publications,
  otherwise preserved NULL originals remain gated forever.
- `planFenceReconcile` and canonical publication must bind derived rows to
  their original identities without expiring, detaching, restamping or
  rewriting original rows. A raw sidecar alone is not sufficient.
- Import/rebuild/recovery must preserve truthful provenance and distinguish
  derived records from original rows. Original identities must never be
  inferred from matching claim text alone or from a fabricated origin.
- Existing source ownership, trust, withdrawal, deletion, remote authorization,
  idempotency and interruption controls remain mandatory. A binding cannot
  grant a low-trust caller permission to freeze or overwrite another row.

## Verification scope

The pure unit suite covers literal NULL/numbered originals, the 5-to-derived-9
collision, already-paired rows, normalized derived claims, duplicate and
ambiguous candidates, complete population/provenance drift, source isolation,
idempotent replanning and refusal without input mutation. Pure planning is not
publication crash/recovery proof. Existing migration/managed/cycle tests must
still pass, followed by real integrated publication/recovery controls before
one final protected binary build and the required delta/native rehearsal.
