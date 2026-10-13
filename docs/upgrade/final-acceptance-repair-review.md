# Final acceptance repair rationale (t_ea03660d)

This is an engineering-review ledger, not GREEN acceptance or deployment authority.
The parent contract in this card supersedes the earlier contract-decision blocker.
All failed receipts and protected binaries remain historical evidence.

## Admission: 78143511d

B01 stays strict for ordinary local/remote writes and unscoped agents. The existing
#4852 generated-producer seam now runs inside vocabulary preflight/admission,
ahead of strict canonical admission, using the actual selected source's pack.
It operates only on server-bound viaSubagent + explicit allowedSlugPrefixes,
never fields supplied in a public request. Original-byte size/YAML/slug screening
precedes serialization; no declared note means no normalization. Replay checks
still precede both pack lookup and normalization, and caller identity is unchanged.

brain-allowlist's obsolete literal insight expectation becomes its declared note
canonical type (base-v2 aliases insight to note, not concept). The unscoped pattern
write now asserts invalid_params and no stored page. All existing scoped raw-size,
malformed-YAML and frozen-UUID replay assertions remain. Added actual-source,
missing-note, empty-vocabulary, forged-scope, preserved custom fields/body/timeline,
file publication and changed-pack replay controls in the existing serial suite.
The link-semantic test pack declares person. The managed mention test declares
ticket in a disposable on-disk test pack extending base-v2 so the real writer
subprocess sees it; all alias/mention/coordinator assertions remain, with pack
resolution and canonical account controls added. Published schema-pack docs now
state exactly this contract and distinguish unresolved from resolved-empty packs.

## Compact schemas, retain the public knobs

The B03/B04 exclusion parameters remain visible on BOTH starter and full search
and query surfaces; none are hidden to get under budget. Shortened duplicate
operation/parameter prose while preserving every existing DX-14 phrase, defaults,
next-call and recovery assertion. Description hard caps, per-tool sizes, starter
character/token limits and initialize-instruction ceilings are unchanged. The
existing generators refresh only the operation manifest and tool catalog.

## Known writers and historical inventory

The canonical-writer row is restored from reviewed commit f4aafb381 for exactly
four operator-quarantine census references, with its pre-transaction managed-brain
refusal and trigger race fence unchanged. The attribution census separately counts
two raw metadata UPDATEs; they are explicitly UNATTRIBUTED, not falsely claimed
as coordinated. Its incident contract leaves content/files/aliases/chunks untouched.
Historical markers are confined to overlay-inventory sections that enumerate the
old commit range or explicitly quote git-show e90ad6edd paths. No path allowlist or
checker changes, and current source references remain checked.

## Real PostgreSQL repairs

The covered-atom slug NOT ANY corpus set caused both HNSW planner regression and
cross-source slug-collision exclusion. Correlate the predicate to the OUTER page's
id/type/source instead. The exact prefix-only source alias and outgoing link
coverage conditions remain; non-atoms and uncovered atoms stay visible, and opt-out
still bypasses coverage. A same-slug other-source regression now proves isolation.
Native planner/statistics/recall tests then pass unchanged. This is a product fix,
not a golden-only acceptance of the regression.

engineSchemaInput uses the existing snapshotConfigReader seam, not new caching:
real engines pay one pass instead of global/source per-key reads; preparation's
existing engine view answers from its frozen snapshot. GetConfig-only and failed
snapshot fallbacks remain. Actual wire budget returns to 27 admission /24 prepare,
103 critical-path statements with every ceiling unchanged. A first raw-SQL batching
attempt bypassed preparation's snapshot and failed its25 budget; it was rejected.

Operator quarantine's test previously compared ALL database rows and required
unrelated rows' generations to advance. Restrict the advancing-generation/hash
assertions to the exact five manifest identities, add equality of their IDs and
an unchanged complementary-row snapshot, retain chunks/aliases/readiness/search
and rollback assertions. No product quarantine change or managed bypass.

The restricted search test roles now receive SELECT on links/page_links for the
retained coverage query; their source/JIT restrictive RLS policies remain. Production
ACLs are untouched. The pooled-only idle fixture explicitly selects the existing
single-pool mode, since port6543 otherwise enables the separate direct-route mode
already tested above it. Existing 3+-to-1 pool/socket assertions remain, with a
single-pool identity assertion added. No time/budget ceiling increases.

## Reviewed golden families (no assertion removal or broad normalization)

Each family was captured separately with fenced Bun1.4.3 and then its full diff
reviewed against source/inventory. Only these semantic changes are allowed:

- CLI help/tools: retained B03/B04 knobs and the compact descriptions above;
  unchanged tool names, types, mutating/local-only tags and all old parameters.
- Export surface: additive opencodeGoSessionHeaders (B06), stampAtomProvenance
  and provenance_status (B09), atom_disposition (B27), includeCoveredAtoms (B04),
  includeQuarantined (B07). No former export/signature/member removed.
- SQL text: coverage predicate only, now page-identity-correlated as above;
  bound parameters, source/private/projection filters, ordering and pagination
  remain. SQL digest changes follow that exact semantic delta. links.json and
  its _driver trace additionally replace exactly two single-key config reads
  (one bound string) with the existing whole-table snapshot (zero parameters);
  all link-write statements, guard predicates and transaction ordering remain.
- Doctor fresh/degraded: exactly fresh, quote_present_in_live_page, quote_probe
  atom diagnostics (B09). Content/hot-check fixtures additionally report
  multi_source_drift NOT VERIFIED instead of falsely green where fixture source
  identities do not bind; the retained coverage-honesty overlay 5f6aa6d0b changes
  meta/overall scores and adds that warning. All other checks remain.
- Thin-client: FIXED actual bug first: RemoteMcpError must not be classified as
  a PostgreSQL ECONNREFUSED by the fatal writer. Fixtures retain unavailable,
  remote-doctor recovery, and capture's original-request retry identity. Only
  the Bun1.4.3 ECONNREFUSED detail and retained host-only operator set/rollback
  hint change. New whole-matrix negative assertions forbid DB markers/db-repair
  and positively retain remote-doctor or original-request recovery.

## Execution disclosures and remaining gates

focused.sh exports Bun1.4.3 PATH for parent/subprocesses, a private HOME, and the
approved short stage5/acc-tmp outside worktrees. Early probes labelled contract-2,
contract-3 and unfenced filenames inherited ambient tool-call environment; they are
DIAGNOSTIC ONLY, not final evidence. Subsequent fenced-* logs are authoritative
focused checks. Shell exports did not persist across tool calls in this runtime.

The worker scope has MemoryMax4GiB, observed from cgroup. Full typecheck's explicit
6GiB heap plus the worker caused swap pressure; interrupted trials are not passes.
Independent bounded systemd supervision (MemoryMax8GiB, CPUQuota200%, RuntimeMax1200s)
completed native typecheck rc0. No test/guard ceiling changed. Long acceptance must
use the same supervised/resource-accounted arrangement rather than worker nesting.

The generated operation manifest was refreshed before final CLI help capture;
its compact strings are now also pinned by help-and-errors. Doctor goldens run
only after retrieval changes are committed: the dirty-source warning encountered
mid-repair is a real diagnostic and was NOT blessed into fixtures. Final clean
doctor fresh/content/hot-check captures pass without further golden mutation.

An additional dream namespace negative exposed error precedence: preflight now
enforces the already-existing client/subagent fences before any producer
transformation. The legacy in-namespace positive uses declared note (its purpose
is namespace admission); a separate in-namespace unknown-type negative pins B01.
Scoped unknown-generated positives and outside-scope negatives remain unchanged.

Pooled, explicit-direct and derived-direct endpoint probes all identified the same
disposable cluster7695912997412859942 before targeted E2E writes; live5432 was never
selected. An old disposable cluster carries a leftover anon role, making mechanical's
no-PostgREST negative fixture genuinely invalid. Do not weaken that test or remove
roles silently: use a clean disposable fixture for its no-exposure case and final
matrix, preserving the prior fixture/receipts.

Full coherent exact-revision matrix, protected compile/caller controls, fresh full
schema165->239 rehearsal including native v0.53.0 ownership/policy/member steps,
row-identity/text preservation and recovery are still required. The three exact
facts exceptions stay ACCEPTED-NOT-REPAIRED; no live notes or facts were modified.
