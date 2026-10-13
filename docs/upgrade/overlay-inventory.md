# Official v0.60.178 overlay inventory — Stage 1

Status: COMPLETE commit-range inventory; static source classification, NOT parity acceptance or deployment approval.
Task: t_12301fe4. Scope: analysis plus these two committed documents only. No code integration, dependencies, builds, new test runs, service changes or database writes in this run.

## Frozen identities and accounting

- Official candidate: v0.60.178.0, `0460af288227a193c2031eca2e6a64f808cbd8bd`.
- Inventory source: deployed source revision `e90ad6eddce9414d262e11bbc01ce63cf6235de8`. This identifies the compared source, not an independently probed executable in this run.
- Authoritative artifact: `/srv/minio/native/ubuntu-root-offload/gbrain-port/wt-upgrade-v060178/docs/upgrade/overlay-inventory.md` on `upgrade/official-v060178-reconciled`.
- Durable program state: `/srv/minio/hermes-native/.hermes/profiles/monchobot/scripts/references/gbrain-upgrade-v060178-program.md` (separate Hermes repository; commit only this path).
- Prior overlay `818dc93edd26e7c0c7afc0313f6f08b5f3845e8f` is recorded in the installed registry and prior acceptance logs; it is NOT integrated in this staging tree by Stage 1.
- Range: 37 unique commits, 27 behavioral rows: 24 RETAIN / 2 UPSTREAM-EQUIVALENT / 1 CONFIG-REPLACED. RETAIN splits into 21 runtime behaviors and 3 optional/verification tooling behaviors. Counts are behavior rows, not commits or indispensable patches.
- Unclassified runtime behaviors: none identified in this enumerated range. No equivalence claim for unrelated pre-range upstream functionality. Static classification is subject to the listed integration/fixture gaps; it does not imply these behaviors work on the candidate today.

Exact commands executed from the staging repository:

```text
git status --short
Observed: empty at entry.
git branch --show-current
Observed: upgrade/official-v060178-reconciled
git rev-parse HEAD
Observed: 0460af288227a193c2031eca2e6a64f808cbd8bd
git tag --points-at 0460af288
Observed: v0.60.178.0
git rev-list --reverse 0460af288227a193c2031eca2e6a64f808cbd8bd..e90ad6eddce9414d262e11bbc01ce63cf6235de8
Observed: 37 SHAs; all appear in the coverage ledger below.
git log --reverse --format='%H %s' 0460af288227a193c2031eca2e6a64f808cbd8bd..e90ad6eddce9414d262e11bbc01ce63cf6235de8
Observed: same SHA/subject sequence as the ledger below.
```

Each evidence block below quotes an actual `git show REF:PATH` command and selected numbered output observed from it. Line windows are excerpts, not entire-file output. All local line references are at `e90ad6eddce9414d262e11bbc01ce63cf6235de8`; all official references are at `0460af288227a193c2031eca2e6a64f808cbd8bd`. The changed-path ledger comes from `git diff-tree --no-commit-id --name-only -r SHA`; test inventory from reading the actual test files at the deployed revision. No patch-ID absence is used as behavioral absence proof. Missing tokens are discovery only; actual official execution seams were read, including reorganized modules.

## Classification decision flow

Keep upstream's implementation where it already supplies the policy; carry only the extra guarantee, not old file layout. Official #5432 already distinguishes unreadable/truncated/skipped sources from clean, and already reports thrown check failures. Official prefix matching really calls Git and applies the work-tree prefix; it is not just a file bearing the same name. `GBRAIN_DRIFT_TIMEOUT_MS=30000` replaces the local thirty-second default, but cannot replace an end-to-end deadline, source identity parity or authorization checks.

The installed JSON registry is a previous staging plan, not authoritative evidence of equivalence. Corrections established here: GO header injection is an actual source patch introduced by f2676d1fe, not merely service configuration; prefix support is upstream-equivalent, while skip-only cases 8/9 do not prove it; native explicit-budget unpriced-route refusal already exists, but its default-budget behavior differs; quarantine list/clear/scan is not the guarded operator set/rollback lane. Preserve upstream managed writers and privacy/read eligibility when adapting old patches.

## Behavior classification table
<!-- repo-paths: historical -->

Changed files for each behavior are the exact union of introducing commits (includes their support/tests); the full per-commit split follows. Regression paths are inspected source tests, NOT new successful runs. See detailed notes for insufficient helper-only or missing coverage.

| ID / behavior | Class | Introducing commits | Touched files | Prevented failure | Regression tests | Evidence |
|---|---|---|---|---|---|---|
| B01 Canonical type admission for put_page | RETAIN | `f2676d1fe` | `src/core/ai/gateway.ts`<br>`src/core/import-file.ts`<br>`src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/persistence/page-prepare.ts`<br>`src/core/pglite-engine.ts`<br>`src/core/postgres-engine.ts`<br>`src/core/schema-pack/type-usage.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/forward-port-semantics.test.ts` | Prevents new aliases/undeclared types being persisted verbatim. | `test/forward-port-semantics.test.ts`<br>`test/brain-allowlist.serial.test.ts`<br>`test/e2e/dream-allow-list-pglite.test.ts` | E:canonical-0460af288, E:canonical-e90ad6edd, E:prepare-e90ad6edd |
| B02 sync.exclude guard on put_page, including dry run | RETAIN | `f2676d1fe` | `src/core/ai/gateway.ts`<br>`src/core/import-file.ts`<br>`src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/persistence/page-prepare.ts`<br>`src/core/pglite-engine.ts`<br>`src/core/postgres-engine.ts`<br>`src/core/schema-pack/type-usage.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/forward-port-semantics.test.ts` | Prevents direct page writes bypassing indexing exclusions. | `test/forward-port-semantics.test.ts` | E:exclude-write-0460af288, E:exclude-write-e90ad6edd |
| B03 Public search/query slug-prefix exclusion plumbing | RETAIN | `f2676d1fe` | `src/core/ai/gateway.ts`<br>`src/core/import-file.ts`<br>`src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/persistence/page-prepare.ts`<br>`src/core/pglite-engine.ts`<br>`src/core/postgres-engine.ts`<br>`src/core/schema-pack/type-usage.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/forward-port-semantics.test.ts` | Prevents caller exclusions being lost at operation or hybrid rebuild seams. | `test/forward-port-semantics.test.ts` | E:search-params-0460af288, E:search-params-e90ad6edd |
| B04 Default covered-atom retrieval policy plus opt-out and cache key | RETAIN | `f2676d1fe` | `src/core/ai/gateway.ts`<br>`src/core/import-file.ts`<br>`src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/persistence/page-prepare.ts`<br>`src/core/pglite-engine.ts`<br>`src/core/postgres-engine.ts`<br>`src/core/schema-pack/type-usage.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/forward-port-semantics.test.ts` | Reduces redundant source-covered atoms without hiding uncovered unique atoms. | `test/forward-port-semantics.test.ts`<br>`test/covered-atom-source-alias.test.ts` | E:covered-policy |
| B05 Verified legacy source-root alias resolution for frozen atom bindings | RETAIN | `09759579a`, `2e20bfc41` | `src/commands/doctor/checks/extraction-sync.ts`<br>`src/core/atom-slug-alias.ts`<br>`src/core/cycle/provenance-status.ts`<br>`src/core/ops/search.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/atom-provenance-status.test.ts`<br>`test/covered-atom-source-alias.test.ts` | Prevents frozen old source_slug prefixes from falsely reading source-gone or uncovered. | `test/covered-atom-source-alias.test.ts`<br>`test/atom-provenance-status.test.ts` | E:alias-policy |
| B06 OpenCode GO session header injection in the gateway | RETAIN | `f2676d1fe`, `59ec42fa7` | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`scripts/module-size-limits.tsv`<br>`scripts/verify-readwise-drift-live.ts`<br>`src/commands/doctor.ts`<br>`src/commands/doctor/multi-source-drift-check.ts`<br>`src/commands/doctor/report-remote.ts`<br>`src/core/ai/gateway.ts`<br>`src/core/import-file.ts`<br>`src/core/multi-source-drift-walk.ts`<br>`src/core/multi-source-drift.ts`<br>`src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/persistence/page-prepare.ts`<br>`src/core/pglite-engine.ts`<br>`src/core/postgres-engine.ts`<br>`src/core/schema-pack/type-usage.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/forward-port-semantics.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts`<br>`test/multi-source-drift-coverage.test.ts`<br>`test/multi-source-drift.test.ts` | Prevents GO-compatible provider requests missing their required session header. | `test/ai/opencode-go-session.test.ts` | E:GO-0460af288, E:GO-e90ad6edd, E:local-GO-selection |
| B07 Quarantine exclusion in structural exact-slug lookup | RETAIN | `9cc3c70de` | `src/core/search/exact-lookup.ts`<br>`src/core/search/hybrid.ts`<br>`test/search/alias-hop.test.ts`<br>`test/search/exact-lookup.test.ts`<br>`test/search/quarantine-exact-slug-hybrid.serial.test.ts` | Prevents exact identity injection leaking hidden quarantined pages. | `test/search/exact-lookup.test.ts`<br>`test/search/quarantine-exact-slug-hybrid.serial.test.ts`<br>`test/search/alias-hop.test.ts` | E:official-exact-quarantine-gap |
| B08 Quarantine posture in search knobsHash | RETAIN | `b315bb9db` | `src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`test/cross-modal-phase1.test.ts`<br>`test/search-alias-resolved-boost.test.ts`<br>`test/search-mode.test.ts`<br>`test/search/knobs-hash-reranker.test.ts` | Prevents cross-posture search key collisions once the internal opt-in exists. | `test/search/knobs-hash-reranker.test.ts`<br>`test/search-mode.test.ts` | E:quarantine-hash |
| B09 Read-time atom provenance quote-status enrichment | RETAIN | `2e20bfc41` | `src/commands/doctor/checks/extraction-sync.ts`<br>`src/core/atom-slug-alias.ts`<br>`src/core/cycle/provenance-status.ts`<br>`src/core/ops/search.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/atom-provenance-status.test.ts` | Distinguishes surviving source passage from source disappearance without rewriting evidence. | `test/atom-provenance-status.test.ts` | E:official-atom-provenance, E:provenance-reader |
| B10 Quarantine-aware source evidence and provenance population | RETAIN | `fd2809782` | `src/commands/doctor/checks/extraction-sync.ts`<br>`src/core/cycle/provenance-status.ts`<br>`test/atom-provenance-status.test.ts`<br>`test/doctor-atom-provenance-drift.test.ts` | Prevents hidden pages/atoms serving as live evidence or polluting provenance counts. | `test/atom-provenance-status.test.ts`<br>`test/doctor-atom-provenance-drift.test.ts` | E:official-atom-provenance, E:provenance-reader |
| B11 Unpriced atom embedding/chat refusal and honest accounting | RETAIN | `e424ff537`, `c55023dc6` | `scripts/module-size-limits.tsv`<br>`src/core/cycle/extract-atoms-cost-gate.ts`<br>`src/core/cycle/extract-atoms-drain.ts`<br>`src/core/cycle/extract-atoms-quarantine.ts`<br>`src/core/cycle/extract-atoms.ts`<br>`test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` | Prevents default caps silently disappearing and unpriced embedding being reported as priced zero. | `test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` | E:official-cost-gate, E:local-cost-policy |
| B12 Atom candidate quarantine exclusion and execution-boundary fail-closed recheck | RETAIN | `e424ff537`, `c55023dc6` | `scripts/module-size-limits.tsv`<br>`src/core/cycle/extract-atoms-cost-gate.ts`<br>`src/core/cycle/extract-atoms-drain.ts`<br>`src/core/cycle/extract-atoms-quarantine.ts`<br>`src/core/cycle/extract-atoms.ts`<br>`test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` | Prevents quarantined content reaching inference after discovery or on DB recheck failure. | `test/extract-atoms-hardening.test.ts` | E:official-atom-selection, E:local-quarantine-recheck |
| B13 Blocked extraction drain becomes a visible retryable failure | RETAIN | `b27f41a0e`, `c55023dc6` | `src/core/cycle/extract-atoms-cost-gate.ts`<br>`src/core/cycle/extract-atoms-drain.ts`<br>`src/core/cycle/extract-atoms-quarantine.ts`<br>`src/core/cycle/extract-atoms.ts`<br>`test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` | Prevents preflight blocked/skipped batch falsely completing as no-progress green. | `test/extract-atoms-hardening.test.ts` | E:official-drain-adapter |
| B14 Dedicated global maintenance queue | RETAIN | `dde45713a` | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`src/commands/autopilot-fanout.ts`<br>`test/autopilot-global-maintenance.test.ts` | Prevents brain-wide maintenance occupying per-source default work queue. | `test/autopilot-global-maintenance.test.ts` | E:official-maintenance-queue |
| B15 Operator quarantine-set lane, exact-row guards, reversible projection-safe metadata writes | RETAIN | `fc1f16d0a`, `ab677151f`, `25705e88e`, `8902d5e63`, `8166eb2ef` | `src/cli.ts`<br>`src/commands/quarantine.ts`<br>`src/core/cli-flag-registry.generated.ts`<br>`src/core/operator-quarantine.ts`<br>`test/e2e/operator-quarantine-postgres.test.ts`<br>`test/operator-quarantine-set.serial.test.ts` | Allows finite wrong-root DB-only quarantine without content/version loss or permanently broken projections. | `test/operator-quarantine-set.serial.test.ts`<br>`test/e2e/operator-quarantine-postgres.test.ts` | E:quarantine-command, E:operator-guards |
| B16 Quarantined entity/alias exclusion from mention gazetteer | RETAIN | `43819e966` | `src/commands/extract.ts`<br>`src/core/by-mention.ts`<br>`test/by-mention-quarantine.test.ts`<br>`test/extract-by-mention-rebuild.test.ts` | Prevents hidden entities being regenerated as mention targets. | `test/by-mention-quarantine.test.ts` | E:gazetteer-0460af288, E:gazetteer-e90ad6edd |
| B17 Mention rebuild sweeps derived edges from quarantined origins | RETAIN | `43819e966` | `src/commands/extract.ts`<br>`src/core/by-mention.ts`<br>`test/by-mention-quarantine.test.ts`<br>`test/extract-by-mention-rebuild.test.ts` | Prevents pre-existing derived mention links surviving origin quarantine forever. | `test/extract-by-mention-rebuild.test.ts` | E:official-mention-body |
| B18 Unreadable roots/subdirectories and skipped Git sources warn not verified | UPSTREAM-EQUIVALENT | `59ec42fa7`, `dd40ab91f` | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`scripts/module-size-limits.tsv`<br>`scripts/verify-readwise-drift-live.ts`<br>`src/commands/doctor.ts`<br>`src/commands/doctor/multi-source-drift-check.ts`<br>`src/commands/doctor/report-remote.ts`<br>`src/commands/doctor/schema-pack-checks.ts`<br>`src/core/multi-source-drift-walk.ts`<br>`src/core/multi-source-drift.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts`<br>`test/multi-source-drift-coverage.test.ts`<br>`test/multi-source-drift.test.ts` | Prevents unreadable/skipped subset being declared clean. | `test/doctor-not-verified-5432.test.ts`<br>`test/multi-source-drift.test.ts` | E:official-drift-verdict, E:official-unreadable-tests |
| B19 Git-root work-tree prefix matching and safe unresolved skip | UPSTREAM-EQUIVALENT | `dd40ab91f`, `4e6f7a186` | `src/commands/doctor/schema-pack-checks.ts`<br>`src/core/multi-source-drift.ts`<br>`test/doctor-drift-coverage-note.test.ts`<br>`test/multi-source-drift.test.ts` | Prevents subdirectory sources being compared with incorrect unprefixed slugs. | `test/multi-source-drift.test.ts` | E:official-prefix-budget, E:official-test-test/multi-source-drift.test.ts |
| B20 One deadline and file budget across roster/config/Git/files/DB phases | RETAIN | `4e6f7a186`, `59ec42fa7` | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`scripts/module-size-limits.tsv`<br>`scripts/verify-readwise-drift-live.ts`<br>`src/commands/doctor.ts`<br>`src/commands/doctor/multi-source-drift-check.ts`<br>`src/commands/doctor/report-remote.ts`<br>`src/core/multi-source-drift-walk.ts`<br>`src/core/multi-source-drift.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/doctor-drift-coverage-note.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts`<br>`test/multi-source-drift-coverage.test.ts`<br>`test/multi-source-drift.test.ts` | Prevents a partial verifier outliving its budget or presenting unfinished sources as clean. | `test/multi-source-drift-coverage.test.ts`<br>`test/doctor-drift-coverage-note.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts` | E:official-prefix-budget, E:local-drift-coverage, E:local-drift-walk |
| B21 Drift sync-identity and eligibility parity | RETAIN | `59ec42fa7` | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`scripts/module-size-limits.tsv`<br>`scripts/verify-readwise-drift-live.ts`<br>`src/commands/doctor.ts`<br>`src/commands/doctor/multi-source-drift-check.ts`<br>`src/commands/doctor/report-remote.ts`<br>`src/core/multi-source-drift-walk.ts`<br>`src/core/multi-source-drift.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts`<br>`test/multi-source-drift-coverage.test.ts`<br>`test/multi-source-drift.test.ts` | Prevents wrong-slug misroute advice from restored legacy identities, collisions or excluded files. | `test/multi-source-drift-coverage.test.ts`<br>`test/import-file-slug.test.ts` | E:local-drift-coverage, E:local-drift-walk |
| B22 Honest DB-unavailable/roster/config failure and unauthorized comparison scope | RETAIN | `59ec42fa7` | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`scripts/module-size-limits.tsv`<br>`scripts/verify-readwise-drift-live.ts`<br>`src/commands/doctor.ts`<br>`src/commands/doctor/multi-source-drift-check.ts`<br>`src/commands/doctor/report-remote.ts`<br>`src/core/multi-source-drift-walk.ts`<br>`src/core/multi-source-drift.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts`<br>`test/multi-source-drift-coverage.test.ts`<br>`test/multi-source-drift.test.ts` | Prevents omitted drift checks or reading comparison-source data outside caller grants. | `test/multi-source-drift-coverage.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts` | E:local-drift-verdict, E:official-drift-verdict |
| B23 Thirty-second live drift budget | CONFIG-REPLACED | `e90ad6edd` | `src/commands/doctor/multi-source-drift-check.ts`<br>`test/multi-source-drift-coverage.test.ts` | Allows a real Readwise filesystem walk more than five seconds without changing default code. | `test/doctor-not-verified-5432.test.ts`<br>`test/multi-source-drift-coverage.test.ts` | E:official-prefix-budget, E:local-drift-verdict |
| B24 Serial runner unsharded membership preservation under bad scheduler output (tooling) | RETAIN | `a9f6ca816`, `e868bc259` | `scripts/run-serial-tests.sh` | Prevents an ordering helper silently shrinking the executed serial corpus. | `test/scripts/serial-files.test.ts` | E:official-serial-membership, E:local-serial-membership |
| B25 Local-only disposable codegraph probe (tooling) | RETAIN | `0990361d0` | `tools/codegraph-probe.README.md`<br>`tools/codegraph-probe.ts` | Allows caller/blast inspection without reindexing the live brain or changing grants. | No dedicated test in commit; validation gap explicit below. | E:codegraph-tool |
| B26 Scoped RSS observer and intact serial persistence workload tests (tooling) | RETAIN | `ec71615b0` | `docs/architecture/key-files/tooling-and-tests.md`<br>`scripts/persistence/read-workload.ts`<br>`test/persistence-performance.test.ts`<br>`test/persistence-rss-workload.serial.test.ts` | Prevents process-global memoryUsage spies contaminating later workload tests. | `test/persistence-performance.test.ts`<br>`test/persistence-rss-workload.serial.test.ts` | E:rss-tool |
| B27 Historical companion assessment enrichment on search and direct page reads | RETAIN | `aead2484a` | `src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/search/atom-disposition.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/types.ts`<br>`test/atom-disposition-cache-hit.serial.test.ts`<br>`test/atom-disposition.test.ts` | Makes validated historical repair work visible without rewriting original atoms or frozen provenance. | `test/atom-disposition.test.ts`<br>`test/atom-disposition-cache-hit.serial.test.ts` | E:assessment-guards |

## Minimal carry-forward boundaries

### B01 — Canonical type admission for put_page (RETAIN)

Official importFromContent only emits type_warning (lines 463-471). Local preparePageMutation loads the active vocabulary for put_page; aliases normalize and undeclared explicit types reject before publication. Existing helper tests alone do not prove full admission/disk behavior: adapt actual-op regressions and assert no side effect on refusal. Missing/unresolvable packs remain the existing best-effort boundary, not a new universal refusal.

### B02 — sync.exclude guard on put_page, including dry run (RETAIN)

Official has discovery/purge exclusions, not this pre-admission put_page guard. Carry the lowercased slug check, comma/newline and trailing-slash glob semantics; no delete of existing data. Existing regression is helper-level: add actual put_page dry-run and persistence refusal assertions. Preserve current logged fail-open on config-read failure unless separately authorized to change it.

### B03 — Public search/query slug-prefix exclusion plumbing (RETAIN)

Official engine SearchOpts already supports exclude_slug_prefixes, but search/query operation definitions do not expose it. Carry validation and keyword/hybrid/image/CRAG forwarding, not duplicate engine machinery; test each op path.

### B04 — Default covered-atom retrieval policy plus opt-out and cache key (RETAIN)

Carry include_covered_atoms -> includeCoveredAtoms, SQL leg integration, same-source live non-atom coverage and ica hash bit. Local SQL follows atom OUTGOING links to non-atom sources; early comments saying links TOWARD the atom are inaccurate. Do not reverse the edge when porting. Check cross-source correlation of the outer slug predicate; existing string tests are not comprehensive SQL parity proof.

### B05 — Verified legacy source-root alias resolution for frozen atom bindings (RETAIN)

One code-reviewed prefix-only allowlist shared by covered-atom SQL and provenance classification. Exact slug first, then de-prefix hermes-moncho/ inside the same source. Native generic alias functionality is not this frozen-binding fallback; do not mutate frozen fields or infer aliases by basename.

### B06 — OpenCode GO session header injection in the gateway (RETAIN)

Contrary to the old registry, this IS deployed code: opencodeGoSessionHeaders merges into applyResolveAuth. Official only merges recipe defaults; no automatic GO session injection. Preserve deepseek/litellm plus opencode.ai host scope, OPENCODE_GO_SESSION and stable nonsecret fallback, auth-shadow guard and actual SDK transport assertion. Service env presence alone is not transport proof.

### B07 — Quarantine exclusion in structural exact-slug lookup (RETAIN)

Official structuralExactLookup reads getPage then pushes with no quarantine check; direct recovery reads are intentionally distinct from search. Carry default quarantine filtering and narrowly scoped includeQuarantined internal opt-in across hybrid call sites; preserve official remote-safe-body handling.

### B08 — Quarantine posture in search knobsHash (RETAIN)

Carry iq bit with B07, adapting the current upstream hash version rather than resetting it to local v30. Do not imply cache reuse is enabled: semantic response reuse is disabled upstream; this remains storage-key identity discipline.

### B09 — Read-time atom provenance quote-status enrichment (RETAIN)

Official drift checker is hash/slug aggregate only. Carry fresh, quote_present_in_live_page, quote_orphaned, source_gone and slug_unbound; shared grounding fold and search/doctor propagation. Quote presence is not current claim certification or restored source binding. Preserve new upstream managed-atom pending-hash semantics when extending its checker.

### B10 — Quarantine-aware source evidence and provenance population (RETAIN)

Official computeAtomProvenanceDriftCheck live_hashes/live_slugs and atom population lack quarantine predicates. Apply visibility to all three lookup populations and quote resolution, not only the top-level count; keep same-source matching.

### B11 — Unpriced atom embedding/chat refusal and honest accounting (RETAIN)

Official explicit operator budget already refuses an unpriced chat OR embed route, but default budget runs uncapped (resolveExtractAtomsCostGate lines 59-62). Retain only extra default-route refusal and truthful unknown accounting, adapting native no_pricing receipts; do not duplicate its explicit-budget behavior. A listed price/API-rate equivalent is not an actual GO subscription charge; this inventory does not authorize new spend ceilings or routing changes.

### B12 — Atom candidate quarantine exclusion and execution-boundary fail-closed recheck (RETAIN)

Official discoverExtractablePages SQL has no explicit quarantine predicate; local policy excludes selection/backlog and rechecks the selected batch before processing. Carry zero-model-call failure when recheck cannot answer; do not rely on later publication guards to prevent inference. Adapt to native managed-atom flow rather than overwrite it.

### B13 — Blocked extraction drain becomes a visible retryable failure (RETAIN)

Official adapter derives providerFailure from failures array and succeeded count only; native no_pricing result has no failures and budget_exhausted true. Preserve blocked refusal propagation and retry visibility while distinguishing native expected-budget stop from provider outage; do not create an unbounded retry hot loop.

### B14 — Dedicated global maintenance queue (RETAIN)

Official dispatchGlobalMaintenance explicitly queue:default at line 744. Carry queue:maintenance, preserving native single-flight/maxPending/idempotency and per-source default dispatch. No official knob identified for this hardcoded enqueue target.

### B15 — Operator quarantine-set lane, exact-row guards, reversible projection-safe metadata writes (RETAIN)

Official quarantine list/clear/scan is not operator set/rollback. Preserve manifest identity/hash/path/source checks, eligibility/refusal boundaries, FOR UPDATE capture, guarded affected-row count, projection job restoration/resealing/orphan-seal recovery, raw-object JSONB parity and private snapshot rollback. Local lane refuses managed persistence: do not bypass that guard to port it; fit the new writer contract or leave safely refused pending the later stage. CLI generated registry is support, not a separate behavior.

### B16 — Quarantined entity/alias exclusion from mention gazetteer (RETAIN)

Official buildGazetteer has reworked source-pack type filtering but its page and alias queries omit quarantine. Add quarantine filters to current source-aware SQL, not local old hardcoded type machinery.

### B17 — Mention rebuild sweeps derived edges from quarantined origins (RETAIN)

Official already SKIPS quarantined origins at lines 2499-2502 (equivalent for new edge prevention), but skipping does not sweep their existing scanner-owned edges. Local supplies empty body in rebuild so reconciliation removes only derived edges. Carry cleanup delta; preserve human-authored edges and current title-inclusive extraction.

### B18 — Unreadable roots/subdirectories and skipped Git sources warn not verified (UPSTREAM-EQUIVALENT)

Verified in official #5432: unreadable_sources; multiSourceDriftCheck local+remote returns warn/not_verified for unreadable, truncated or Git-skipped inputs, plus multiSourceDriftNotVerified for thrown checks. Retirement applies only to duplicate basic renderer behavior; finer coverage and authorization remain B20-B22. Run unreadable permission fixtures as a nonroot account.

### B19 — Git-root work-tree prefix matching and safe unresolved skip (UPSTREAM-EQUIVALENT)

Verified actual official syncedPathPrefix calls rev-parse --show-prefix and applies prefix+relPath before pathToSlug. Official tests explicitly cover repo top, two-level subdirectory, symlink local_path and source-root control, beyond cases 8/9 which only test skipping nonrepos. This is the #6060/#5862 behavior; do not retire tighter deadline B20 or richer identities B21.

### B20 — One deadline and file budget across roster/config/Git/files/DB phases (RETAIN)

Official deadline is walk-focused; git prefix call has independent 30s timeout, DB reads unbounded by the drift deadline and file limit passed anew per source. Local shares global visited budget and deadline across every phase, records unvisited sources and distinguishes exactly-finished final limit from truncation. Preserve repeated-run incomplete disclosure: raising timeout alone is not certification, and repeat truncation must remain WARN. beforeDriftDeadline bounds wait, not cancellation of an engine read.

### B21 — Drift sync-identity and eligibility parity (RETAIN)

Official walker derives pathToSlug(prefix+relPath) only; local consults persisted source_path in both sources, canonical import slug resolver, invalid YAML and duplicate identities, persisted exclude/hidden-waiver/metafile classifiers, supported strategy and symlink/file read failures. Carry minimal shared helpers, do not fork official new sync/import identity logic. Invalid/ambiguous identity is unknown, never first-row wins.

### B22 — Honest DB-unavailable/roster/config failure and unauthorized comparison scope (RETAIN)

Official #5432 already catches thrown check failures into warnings; RETAIN only richer per-source stage coverage, engine-null handling, checked_sources/candidates/verification_complete contract and fail-closed grant requiring default for comparisons. Adapt local and actual remote entrypoints, with no names/errors leaked outside scope; basic notVerified duplication is B18.

### B23 — Thirty-second live drift budget (CONFIG-REPLACED)

Required value GBRAIN_DRIFT_TIMEOUT_MS=30000 on each relevant serving CLI/HTTP/worker context; official opts.timeoutMs overrides env, so overlays must not hardcode 5000/30000 over it. Keep GBRAIN_DRIFT_LIMIT=10000 unless separate accepted need. The full shared deadline B20 still needs code. This run does not set live configuration.

### B24 — Serial runner unsharded membership preservation under bad scheduler output (RETAIN)

Tooling behavior only: official trusts selected output and clears membership; local falls back if scheduler fails or misses unsharded files. Retain desired exact-set guarantee, NOT its unsafe sharded failure fallback: local retains the whole discovered corpus on scheduler failure even in a shard. Also local only detects missing entries, not unexpected/duplicate entries. New upstream already fails on scheduler error and honors successful empty shards; preserve that authority. Add malformed output contract fixtures before acceptance. No test modified in these two commits; downstream must prove failure cases.

### B25 — Local-only disposable codegraph probe (RETAIN)

Keep as optional local tooling, not a mandatory runtime patch. It wraps native importer/code-intel ops in disposable PGLite with no embeds; upstream native code tools alone do not supply this wrapper. No dedicated regression test in the commit: documentation usage is not proof of graph coverage. Audit bare-name collisions and source-qualified edges on use.

### B26 — Scoped RSS observer and intact serial persistence workload tests (RETAIN)

Verification tooling only: observeRss injection and observeResidentMemory keep unavailable samples/peak state per workload. Preserve the original full real workloads when adapting current upstream test layout, not relaxed benchmarks. No runtime service requirement.

### B27 — Historical companion assessment enrichment on search and direct page reads (RETAIN)

Carry loadAtomDispositions/stampAtomDispositions/loadAtomDispositionForPage across keyword/search/hybrid/cache hit and get_page after visibility resolution. Require same-source atom id/slug/frozen hash+slug/exact UTF-8 body SHA256 identity; malformed/stale/conflicting records warn untrusted; drop inaccessible/private references. Always historical=true/certified=false. Official retrieval/get-page have no companion atom_disposition enrichment; absence corroborated by inspection of those read paths, not missing filename alone.

## Complete commit-range coverage ledger
<!-- repo-paths: historical -->

This separates runtime behavior from docs, tests, generated support and behavior-preserving refactors. A support/refactor row is not a new runtime patch; its classification is the named behavioral dependency, not a fabricated fourth runtime class. Every SHA in the real range is accounted for exactly once here. Commands: `git show -s --format=%s SHA` and `git diff-tree --no-commit-id --name-only -r SHA`; observed subjects/files are quoted verbatim in each row.

| Commit / observed subject | Runtime classification or nonbehavior disposition | Observed changed files | Observed regression files |
|---|---|---|---|
| `f2676d1fe831bdfedb59c6f37562c6f4ce4fc421` — feat(port): forward-port five pre-v0.51 custom semantics onto v0.58.1 | B01 RETAIN, B02 RETAIN, B03 RETAIN, B04 RETAIN, B06 RETAIN | `src/core/ai/gateway.ts`<br>`src/core/import-file.ts`<br>`src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/persistence/page-prepare.ts`<br>`src/core/pglite-engine.ts`<br>`src/core/postgres-engine.ts`<br>`src/core/schema-pack/type-usage.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/forward-port-semantics.test.ts` | `test/ai/opencode-go-session.test.ts`<br>`test/forward-port-semantics.test.ts` |
| `0689f70b373c84968966da8ab669ddbc706518c0` — test(budget): prove v4.1-flash pricing override makes a cost cap bind | Test-only pricing-override cap regression; not a runtime gate or invoice proof. | `test/v41-flash-pricing-override-cap-binds.test.ts` | `test/v41-flash-pricing-override-cap-binds.test.ts` |
| `09759579ae3b711499508f4d08baac09089054d7` — fix(search): source-alias-aware covered-atom exclusion (legacy hermes-moncho/ rename) | B05 RETAIN | `src/core/search/sql-ranking.ts`<br>`test/covered-atom-source-alias.test.ts` | `test/covered-atom-source-alias.test.ts` |
| `d3fbf0c6d0b56c07b957f769d1a8e38018470ea4` — deploy(search): covered-atom source-alias fix release 09759579a | Deployment documentation/checksum only; B05 evidence history, no runtime change. | `deployments/2026-10-01-covalias-09759579a.md`<br>`deployments/2026-10-01-covalias-09759579a.sha256` | No test file changed in this commit. |
| `9cc3c70de7c0bee38a76b0b8f9095085e28e1ca6` — fix(search): quarantine parity for exact-slug identity tier | B07 RETAIN | `src/core/search/exact-lookup.ts`<br>`src/core/search/hybrid.ts`<br>`test/search/alias-hop.test.ts`<br>`test/search/exact-lookup.test.ts`<br>`test/search/quarantine-exact-slug-hybrid.serial.test.ts` | `test/search/alias-hop.test.ts`<br>`test/search/exact-lookup.test.ts`<br>`test/search/quarantine-exact-slug-hybrid.serial.test.ts` |
| `b315bb9db4fd2f1474d3a9fd7107c37b71719587` — fix(search): fold includeQuarantined into knobsHash (v30) | B08 RETAIN | `src/core/search/hybrid.ts`<br>`src/core/search/mode.ts`<br>`test/cross-modal-phase1.test.ts`<br>`test/search-alias-resolved-boost.test.ts`<br>`test/search-mode.test.ts`<br>`test/search/knobs-hash-reranker.test.ts` | `test/cross-modal-phase1.test.ts`<br>`test/search-alias-resolved-boost.test.ts`<br>`test/search-mode.test.ts`<br>`test/search/knobs-hash-reranker.test.ts` |
| `2e20bfc41a6905ea5b622957c4ada8ccb62fd06a` — feat(atoms): read-only provenance status classification (doctor + search) | B05 RETAIN, B09 RETAIN | `src/commands/doctor/checks/extraction-sync.ts`<br>`src/core/atom-slug-alias.ts`<br>`src/core/cycle/provenance-status.ts`<br>`src/core/ops/search.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/sql-ranking.ts`<br>`src/core/types.ts`<br>`test/atom-provenance-status.test.ts` | `test/atom-provenance-status.test.ts` |
| `27a1e0fe4ab8deeea54412678e6f5251a643b901` — docs(deploy): record verified quarantine and provenance release | Deployment documentation only for B07-B10. | `deployments/2026-10-01-quarantine-provenance-2e20bfc.md` | No test file changed in this commit. |
| `e424ff53760b9f1b43e1270753e3974c01b3fa79` — fix(extract_atoms): fail closed on unpriced embed cost + exclude quarantined pages | B11 RETAIN, B12 RETAIN | `scripts/module-size-limits.tsv`<br>`src/core/cycle/extract-atoms-cost-gate.ts`<br>`src/core/cycle/extract-atoms-drain.ts`<br>`src/core/cycle/extract-atoms-quarantine.ts`<br>`src/core/cycle/extract-atoms.ts`<br>`test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` | `test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` |
| `c55023dc6077417c978ef92bbe464d7f8ee143d1` — fix(extract_atoms): fail closed on quarantine re-check error + no $0-pretend for unpriced embed | B11 RETAIN, B12 RETAIN, B13 RETAIN | `src/core/cycle/extract-atoms-cost-gate.ts`<br>`src/core/cycle/extract-atoms-drain.ts`<br>`src/core/cycle/extract-atoms-quarantine.ts`<br>`src/core/cycle/extract-atoms.ts`<br>`test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` | `test/extract-atoms-embed-cost-gate.test.ts`<br>`test/extract-atoms-hardening.test.ts` |
| `b27f41a0e8dedf945eedaf916693d2345933dac1` — fix(extract_atoms): retry blocked drain instead of false-green | B13 RETAIN | `src/core/cycle/extract-atoms-drain.ts`<br>`test/extract-atoms-hardening.test.ts` | `test/extract-atoms-hardening.test.ts` |
| `02adc66e655e57428de0fb1b2bb6678bff48744f` — docs(deploy): record verified atom drain fail-closed release | Deployment documentation only for B11-B13. | `deployments/2026-10-01-atom-hardening-b27f41a.md` | No test file changed in this commit. |
| `b1c07a5831bbe8b5f107e3c36f26ae14ef318ef0` — docs(deploy): clarify atom dry-run exit status | Documentation correction only; dry-run status is not extra runtime behavior. | `deployments/2026-10-01-atom-hardening-b27f41a.md` | No test file changed in this commit. |
| `dde45713a9d744853f780739c9849f00d8d96107` — fix(autopilot): restore global-maintenance queue isolation | B14 RETAIN | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`src/commands/autopilot-fanout.ts`<br>`test/autopilot-global-maintenance.test.ts` | `test/autopilot-global-maintenance.test.ts` |
| `fc1f16d0abf57a00116b7b96e1f97b3e7cbe10aa` — feat(quarantine): first-class operator quarantine-set lane for wrong-root DB-only incident | B15 RETAIN | `src/cli.ts`<br>`src/commands/quarantine.ts`<br>`src/core/operator-quarantine.ts`<br>`test/operator-quarantine-set.serial.test.ts` | `test/operator-quarantine-set.serial.test.ts` |
| `ab677151fde47ec9525c80673cc219ec52cd89fe` — fix(quarantine): re-seal projections + exact-row concurrency guards for operator quarantine-set | B15 RETAIN | `src/commands/quarantine.ts`<br>`src/core/operator-quarantine.ts`<br>`test/operator-quarantine-set.serial.test.ts` | `test/operator-quarantine-set.serial.test.ts` |
| `25705e88ea5638f5030e6bcaf196fa62efd850b9` — fix(quarantine): seal unrecoverable rows + lock capture to close residual hidden-page paths | B15 RETAIN | `src/core/operator-quarantine.ts`<br>`test/operator-quarantine-set.serial.test.ts` | `test/operator-quarantine-set.serial.test.ts` |
| `8902d5e636d4731f06902dcd38762ccff15217ec` — build(flags): regenerate CLI flag registry for operator quarantine-set lane | B15 RETAIN | `src/core/cli-flag-registry.generated.ts` | No test file changed in this commit. |
| `8166eb2ef57623d63c34e02b61c5ef2ce01f0db9` — fix(quarantine): bind operator lane jsonb params as raw objects (postgres.js parity) | B15 RETAIN | `src/core/operator-quarantine.ts`<br>`test/e2e/operator-quarantine-postgres.test.ts`<br>`test/operator-quarantine-set.serial.test.ts` | `test/e2e/operator-quarantine-postgres.test.ts`<br>`test/operator-quarantine-set.serial.test.ts` |
| `43819e9661b8ede9f395fd97d74f36968e41cb8c` — fix(graph): exclude quarantined entities and origins from mention reconciliation | B16 RETAIN, B17 RETAIN | `src/commands/extract.ts`<br>`src/core/by-mention.ts`<br>`test/by-mention-quarantine.test.ts`<br>`test/extract-by-mention-rebuild.test.ts` | `test/by-mention-quarantine.test.ts`<br>`test/extract-by-mention-rebuild.test.ts` |
| `fd28097829240445f4b2af1df2fb3c988f899737` — fix(provenance): respect quarantine visibility in source evidence | B10 RETAIN | `src/commands/doctor/checks/extraction-sync.ts`<br>`src/core/cycle/provenance-status.ts`<br>`test/atom-provenance-status.test.ts`<br>`test/doctor-atom-provenance-drift.test.ts` | `test/atom-provenance-status.test.ts`<br>`test/doctor-atom-provenance-drift.test.ts` |
| `aead2484a238d06c2d84913d406346f72de89796` — feat(search): read-time atom_disposition enrichment from companion assessment pages | B27 RETAIN | `src/core/ops/pages.ts`<br>`src/core/ops/search.ts`<br>`src/core/search/atom-disposition.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/types.ts`<br>`test/atom-disposition-cache-hit.serial.test.ts`<br>`test/atom-disposition.test.ts` | `test/atom-disposition-cache-hit.serial.test.ts`<br>`test/atom-disposition.test.ts` |
| `dd40ab91f8cc9110dc91d9eb8f0d3fc802a9a932` — fix(doctor): prefix-aware git-root-pinned matching in multi_source_drift (#4712) | B18 UPSTREAM-EQUIVALENT, B19 UPSTREAM-EQUIVALENT | `src/commands/doctor/schema-pack-checks.ts`<br>`src/core/multi-source-drift.ts`<br>`test/multi-source-drift.test.ts` | `test/multi-source-drift.test.ts` |
| `4e6f7a186b676f62bc08afa321b1b6df80f5109f` — fix(doctor): bound prefix discovery by drift deadline and cover scoped Git paths | B19 UPSTREAM-EQUIVALENT, B20 RETAIN | `src/core/multi-source-drift.ts`<br>`test/doctor-drift-coverage-note.test.ts`<br>`test/multi-source-drift.test.ts` | `test/doctor-drift-coverage-note.test.ts`<br>`test/multi-source-drift.test.ts` |
| `a2de6d0fc6cb98ac7bb428f3778d9727ce71b15e` — refactor(gates): behavior-preserving module extraction to clear module-size ratchet | Behavior-preserving helper extraction (slug/import, batch split, metadata boosts); no independent runtime semantics. Preserve B01-B06/B21 when adapting existing upstream helpers; do not blanket cherry-pick old layouts. | `src/commands/extract-slug-path.ts`<br>`src/commands/extract.ts`<br>`src/core/ai/batch-split.ts`<br>`src/core/ai/gateway.ts`<br>`src/core/import-file-slug.ts`<br>`src/core/import-file.ts`<br>`src/core/search/hybrid.ts`<br>`src/core/search/metadata-boosts.ts`<br>`test/import-file-slug.test.ts` | `test/import-file-slug.test.ts` |
| `2cedc7f0c11bf3862ef7dc0c83d505fd2a5851a2` — refactor(module-size): peel four over-ceiling modules into behavior-preserving siblings | Behavior-preserving module peels and reexports; no new runtime policy. Underlying B09-B11/B15/B22 behavior, not filename layout, is retained. | `src/commands/doctor/checks/extraction-content-checks.ts`<br>`src/commands/doctor/checks/extraction-sync.ts`<br>`src/core/degraded-stages.ts`<br>`src/core/ops/pages-read-ops.ts`<br>`src/core/ops/pages.ts`<br>`src/core/search/mode.ts`<br>`src/core/search/search-mode-config-keys.ts`<br>`src/core/types.ts` | No test file changed in this commit. |
| `0990361d0ff37aeb0afad3a3545942b09f0126ba` — tools: add local-only disposable-brain code-graph probe (codegraph-probe) | B25 RETAIN | `tools/codegraph-probe.README.md`<br>`tools/codegraph-probe.ts` | No test file changed in this commit. |
| `59ec42fa78365be68779d86e51cb27f9ab202cb3` — fix(doctor): fail closed on incomplete drift coverage and share sync identities | B06 RETAIN, B18 UPSTREAM-EQUIVALENT, B20 RETAIN, B21 RETAIN, B22 RETAIN | `docs/proposals/2026-10-01-maintenance-queue-isolation.md`<br>`scripts/module-size-limits.tsv`<br>`scripts/verify-readwise-drift-live.ts`<br>`src/commands/doctor.ts`<br>`src/commands/doctor/multi-source-drift-check.ts`<br>`src/commands/doctor/report-remote.ts`<br>`src/core/multi-source-drift-walk.ts`<br>`src/core/multi-source-drift.ts`<br>`test/ai/opencode-go-session.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts`<br>`test/multi-source-drift-coverage.test.ts`<br>`test/multi-source-drift.test.ts` | `test/ai/opencode-go-session.test.ts`<br>`test/e2e/multi-source-drift-postgres.test.ts`<br>`test/multi-source-drift-compiled.serial.test.ts`<br>`test/multi-source-drift-coverage.test.ts`<br>`test/multi-source-drift.test.ts` |
| `f4aafb3816f2a78dab63775947ac505cf703c422` — docs(guards): review metadata-only operator quarantine write boundary | Reviewed canonical-writer inventory entry for B15; documentation/guard contract, no runtime write implementation. | `docs/architecture/canonical-writers.tsv` | No test file changed in this commit. |
| `9b5e0c4efb2330d8853dc6f87fe0a151f33872d6` — test(ci): claim drift and operator quarantine PostgreSQL regressions | E2E selection map support claims drift/quarantine test suites B15/B20-B22; not service behavior. | `scripts/e2e-test-map.ts`<br>`test/select-e2e.test.ts` | `test/select-e2e.test.ts` |
| `245995dc43143096d67f2647a7e3789395df814e` — test(search): provide ranking view permissions to restricted fixture role | Restricted search fixture view permission fix only; not production grants. | `test/e2e/search-query-contract-postgres.test.ts` | `test/e2e/search-query-contract-postgres.test.ts` |
| `ba7e3fbea37f0b093fd6bb2ab485a8fd648c769f` — test(readwise): align put_page type expectations with canonical schema | Test expectation fix for canonical page-type schema; supports B01. Do not delete rejection/no-side-effect coverage. | `test/brain-allowlist.serial.test.ts`<br>`test/e2e/dream-allow-list-pglite.test.ts` | `test/brain-allowlist.serial.test.ts`<br>`test/e2e/dream-allow-list-pglite.test.ts` |
| `ec71615b0282d2a7f4108ad560ab5201a7528424` — test(persistence): isolate RSS observation and retain full serial workloads | B26 RETAIN | `docs/architecture/key-files/tooling-and-tests.md`<br>`scripts/persistence/read-workload.ts`<br>`test/persistence-performance.test.ts`<br>`test/persistence-rss-workload.serial.test.ts` | `test/persistence-performance.test.ts`<br>`test/persistence-rss-workload.serial.test.ts` |
| `2ca686785932a9e734460b4b78cc35a31fddf446` — test(persistence): give bounded-wait assertions headroom for one scheduling quantum | Test scheduling-quantum wait headroom only; no runtime timeout policy. | `test/persistence-consumer-scheduling.test.ts` | `test/persistence-consumer-scheduling.test.ts` |
| `a9f6ca8166f7e0d61aa2a8b1298d967560940918` — fix(serial-runner): never let the scheduler shrink serial membership | B24 RETAIN | `scripts/run-serial-tests.sh` | No test file changed in this commit. |
| `e868bc25965cee8b617e54b0654d87236d70d4e5` — fix(serial-runner): keep scheduler authority over empty shards, fall back only on untrusted output | B24 RETAIN | `scripts/run-serial-tests.sh` | No test file changed in this commit. |
| `e90ad6eddce9414d262e11bbc01ce63cf6235de8` — fix(doctor): allow bounded drift verification to finish on live Readwise trees | B23 CONFIG-REPLACED | `src/commands/doctor/multi-source-drift-check.ts`<br>`test/multi-source-drift-coverage.test.ts` | `test/multi-source-drift-coverage.test.ts` |

## Acceptance evidence retained from the prior run — corrected handoff

Read commands executed in this run:

- `read_file(/srv/minio/hermes-native/.hermes/profiles/monchobot/cache/scratch/t12301fe4-acceptance-runA-logs/focused-drift.log)` observed `bun test v1.4.3`, `40 pass`, `0 fail`, `110 expect() calls`, `Ran 40 tests across 2 files. [20.52s]`. This is old receipt evidence, NOT a test invocation by Stage 1. It includes passing repo-top/subdirectory/symlink prefix tests, and the coverage/identity suite. The prior task attributes it to overlay 818dc93edd; the log itself does not print a SHA. Do not relabel it as a green current staging run.
- `read_file(.../repository-guards.log)` observed `Failed: typecheck check:bootstrap-tag check:windows-hide`, `typecheck (TIMED OUT after 120s)`, `check:bootstrap-tag (rc=1)`, `check:windows-hide (rc=1)`, and `elapsed=132s | pass=75 fail=3 skip=0`.

Important correction: comments describing two documentation checks plus one import defect are inaccurate. There are three failing CHECKS: a typecheck timeout, one bootstrap-tag check (four diagnostic matches across README/INSTALL/CODEX), and the overlay direct child_process import. The log's candidate path contains a colon (`sha256:...`); official check-bootstrap-tag's Rule 4 parses grep lines using colon-separated `file:line:match`, and its sed expects a colon-free path. The captured diagnostics retain trailing Markdown/comments even for `@codex-plugin`. This establishes a path/parser hazard, not proof that every official pin is actually unsupported. Stage 2 must reproduce in a clean no-colon candidate path, repair genuine guard/parser or doc defects without suppressing checks, and resolve the typecheck timeout with honest successful execution. Do not blindly replace valid official documentation from the old summary.

Windows failure observed exactly: `FAIL [windows_hide_direct_child_process]: src/core/multi-source-drift-walk.ts:1 imports child_process directly`; guard remedy is `src/core/spawn.ts` (windowsHide defaults true). This repair belongs to Stage 2.

Existing updater/ledger/guardian implementation is already committed per task history; do not reconstruct it. Green-to-green no-duplicate-work proof and migration rehearsal remain missing per the prior checkpoint. No false acceptance records with empty suite lists should be trusted. Preserve failure delivery; do not resurrect gbrain-update-watcher.sh.

## Open questions and downstream acceptance gaps

1. All runtime behavior groups are classified, but full candidate parity remains unverified: adapt regressions to the new managed writer/import/eligibility interfaces, particularly B01/B02 actual admission and B15 operator metadata lane (old code intentionally refuses managed persistence). This is engineering work, not a new permission request.
2. B04 SQL correlation and exact link direction require real multi-source engine fixtures; string-only tests do not establish population correctness. Preserve uncovered atoms and current native privacy visibility.
3. B11/B13 must adapt native no_pricing/expected-budget-stop receipts rather than conflate every refusal with a provider outage. Unknown rate must not be claimed as zero, but list-rate equivalents are not GO invoice charges. No new ceiling or credential/provider switch is authorized by this inventory.
4. B24 needs exact permutation (missing/unexpected/duplicates) checks in an unsharded lane, successful empty-shard handling, and fail-closed scheduler errors for sharded execution. Existing local code's whole-corpus fallback on a failed shard is a known hazard, not something to reproduce.
5. Integration acceptance must retain upstream #5432 tests as well as prefix tests and stronger local regression fixtures. No new candidate tests, builds, full matrix or database rehearal were run in Stage 1. Guard log defects above are unresolved; previous 40/0 is not whole-candidate acceptance.
6. Next owner must preserve the pinned v0.60.178 candidate even if latest upstream advances. Installed registry overlay pointer is separate from staging branch HEAD. After this documentation commit those branches diverge from the common official base: blindly fast-forwarding staging to the old overlay will fail; use a reviewed cherry-pick/integration of the existing overlay onto the inventory-bearing branch, not a reset that loses this artifact. No code integrated here.
7. Migration v165 -> v239 on a disposable copy, exact executable identity, actual-caller behavior probes, scheduled receipt/resume and green-to-green reuse proof remain subsequent-stage acceptance. Stage 1 is not deployment authorization.

## Source evidence appendix

These are observed source excerpts, not evaluated/fabricated test results. `git show` was executed locally against the frozen objects; source inspection adds no runtime write or model inference. To reproduce a numbered excerpt, run the quoted `git show` and select its named line window; full source remains in Git.

### E:canonical-0460af288

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/import-file.ts`

Observed selected output:

```text
14: import type { WriteGateAssessment, WriteGateInput } from './write-gate.ts';
15: import { applyImportFences } from './fence-repair/import-step.ts';
16: import type { FenceIssueWire } from './fence-repair/tier1.ts';
17: import type { FenceFix } from './fence-repair/types.ts';
18: import { classifyStoredType } from './schema-pack/type-usage.ts';
19: import { prepareFenceAwareMarkdownChunks } from './markdown-chunks.ts';
20: import { prepareCodeChunks, installCodeChunkEdges, mapCodeEdges } from './code-chunks.ts';
21: import { detectCodeLanguage, CHUNKER_VERSION, GRAMMAR_REVISIONS, type SupportedCodeLanguage } from './chunkers/code.ts';
22: import { sanitizeRemoteBody } from './remote-body.ts';
23: import { installPageEmbeddings, installPageProjection, preparePageProjection, projectionBelowSafeFence, queuePageProjection, readProjectionSnapshot, resealSafeChunks,
24:   sealPageTextProjection, stampEmbeddingInputs, type ProjectionSnapshot } from './page-state/projections.ts';
25: import { sanitizeText } from './batch-rows.ts';
26: import { hasProtectedBody, safeChunksFilter } from './search/safe-chunks.ts';
27: import { planEmbeddingReuse } from './embed-reuse.ts';
28: import { reuseStoredChunkVectors } from './import-chunk-reuse.ts';
29: import { extractCodeRefs, imageOfCandidates } from './link-extraction.ts';
30: import { embedMultimodal, currentEmbeddingSignature } from './embedding.ts';
31: // #3374 — import-path embeds ride the shared retry loop (429 retry-after +
462:   // (once per file, aggregated once per type per run by sync/import) so the
463:   // misroute class is loud. Purely advisory: the type is still stored as-is.
464:   let typeWarning: ImportResult['type_warning'];
465:   if (parsed.typeExplicit === true && opts.activePack) {
466:     const cls = classifyStoredType(parsed.type, opts.activePack);
467:     if (cls.kind === 'alias_of') {
468:       typeWarning = { kind: 'alias_of', type: parsed.type, canonical: cls.canonical, directory: cls.directory };
469:     } else if (cls.kind === 'undeclared') {
470:       typeWarning = { kind: 'undeclared', type: parsed.type };
471:     }
472:   }
473:
474:   // #3694: the hash formula lives in ONE place — utils.contentHash — shared
475:   // with both engines' putPage fallback, so a page written via putPage and
476:   // the same page re-imported by sync produce the SAME hash (pre-fix they
477:   // diverged and every putPage→sync roundtrip re-chunked + re-embedded).
478:   // The helper strips HASH_EPHEMERAL_FRONTMATTER_KEYS + the tags key from a
479:   // frontmatter copy and folds sorted tags in — the exact former inline
```

### E:exclude-write-0460af288

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/ops/pages.ts`

Observed selected output:

```text
(no matching lines)
```

### E:search-params-0460af288

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/ops/search.ts`

Observed selected output:

```text
(no matching lines)
```

### E:GO-0460af288

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/ai/gateway.ts`

Observed selected output:

```text
331:
332:   // v0.37.6.0 — resolve default_headers (static or env-templated). Mutually
333:   // exclusive; declaring both is a config error.
334:   if (recipe.default_headers && recipe.resolveDefaultHeaders) {
335:     throw new AIConfigError(
336:       `Recipe "${recipe.id}" declares both default_headers and resolveDefaultHeaders. Pick one.`,
337:       recipe.setup_hint,
338:     );
339:   }
340:   const defaults = recipe.resolveDefaultHeaders
341:     ? recipe.resolveDefaultHeaders(cfg.env)
342:     : recipe.default_headers;
343:
344:   // v0.37.6.0 — defaults MUST NOT shadow the resolved auth header. SDK applies
345:   // headers after apiKey, so an `Authorization` entry in defaults would replace
346:   // the Bearer the SDK adds. Custom-header recipes (Azure: api-key) are
347:   // protected the same way.
348:   if (defaults) {
349:     const lcResolved = resolved.headerName.toLowerCase();
```

### E:canonical-e90ad6edd

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/import-file.ts`

Observed selected output:

```text
7: import { createHash } from 'crypto';
8: import type { BrainEngine, FileSpec } from './engine.ts';
9: import { parseMarkdown } from './markdown.ts';
10: import { invalidYamlFrontmatterError, resolveImportSlug } from './import-file-slug.ts';
11: import { classifyStoredType, canonicalTypeRejectMessage } from './schema-pack/type-usage.ts';
12: import { prepareMarkdownChunks } from './markdown-chunks.ts';
13: import { prepareCodeChunks, installCodeChunkEdges } from './code-chunks.ts';
14: import { detectCodeLanguage, CHUNKER_VERSION } from './chunkers/code.ts';
15: import { sanitizeRemoteBody } from './remote-body.ts';
16: import { installPageEmbeddings, installPageProjection, preparePageProjection, readProjectionSnapshot, sealPageTextProjection, type ProjectionSnapshot } from './page-state/projections.ts';
17: import { sanitizeText } from './batch-rows.ts';
18: import { hasProtectedBody, safeChunksFilter } from './search/safe-chunks.ts';
19: import { findChunkForOffset } from './chunkers/edge-extractor.ts';
20: import { planEmbeddingReuse } from './embed-reuse.ts';
21: import { extractCodeRefs, imageOfCandidates } from './link-extraction.ts';
22: import { embedMultimodal, currentEmbeddingSignature } from './embedding.ts';
23: // #3374 — import-path embeds ride the shared retry loop (429 retry-after +
24: // transient network backoff) instead of bare embedBatch, so one socket blip
250:      * status:'error' — never persisted. Legacy path erasure: only the new-write
251:      * put_page surface sets this; sync/legacy reads and implicit (inferred) types
252:      * are untouched, so existing pages and valid legacy reads are unaffected.
253:      */
254:     enforceCanonicalType?: boolean;
255:     /**
256:      * v0.39.3.0 provenance write-through (WARN-8). When set, threaded to
257:      * `tx.putPage` so the page's `source_kind`, `source_uri`,
258:      * `ingested_via` DB columns get populated. The trust gate lives at the
259:      * `put_page` op layer — by the time importFromContent sees these, the
260:      * caller is already trusted (capture CLI sets them; remote MCP callers
261:      * had theirs overridden to `mcp:put_page` upstream). `ingested_at` is
262:      * NOT a caller-controllable param; the engine's putPage stamps it
263:      * server-side via now() when any provenance write fires.
264:      */
265:     source_kind?: string | null;
266:     source_uri?: string | null;
267:     ingested_via?: string | null;
617:   // (once per file, aggregated once per type per run by sync/import) so the
618:   // misroute class is loud. Purely advisory: the type is still stored as-is.
619:   let typeWarning: ImportResult['type_warning'];
620:   if (parsed.typeExplicit === true && opts.activePack) {
621:     const cls = classifyStoredType(parsed.type, opts.activePack);
622:     if (cls.kind === 'alias_of') {
623:       typeWarning = { kind: 'alias_of', type: parsed.type, canonical: cls.canonical, directory: cls.directory };
624:       // Stage-2 canonical-type enforcement: a declared pack ALIAS is normalized
625:       // to its canonical name before persistence so concurrent agents stop
626:       // filing the same concept under different strings. write-through
627:       // re-renders the canonical name on disk, keeping DB and file in lockstep
628:       // (no sync churn on the next round-trip). Only the enforced new-write
629:       // put_page path sets opts.enforceCanonicalType; the advisory alias_of
630:       // warning is still reported (it records the caller's original type).
631:       if (opts.enforceCanonicalType === true) {
632:         parsed.type = cls.canonical;
633:       }
634:     } else if (cls.kind === 'undeclared') {
635:       typeWarning = { kind: 'undeclared', type: parsed.type };
636:       // Stage-2 canonical-type enforcement: a fully undeclared type (neither a
637:       // canonical name nor a known alias) is REJECTED before persistence,
638:       // naming the declared vocabulary so the caller can self-correct. This
639:       // happens before any tx write, so nothing is persisted for the page.
640:       if (opts.enforceCanonicalType === true) {
641:         return {
642:           slug,
643:           status: 'error',
644:           chunks: 0,
645:           error: canonicalTypeRejectMessage(parsed.type, opts.activePack),
646:         };
647:       }
648:     }
649:   }
650:
651:   // #3694: the hash formula lives in ONE place — utils.contentHash — shared
652:   // with both engines' putPage fallback, so a page written via putPage and
653:   // the same page re-imported by sync produce the SAME hash (pre-fix they
```

### E:prepare-e90ad6edd

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/persistence/page-prepare.ts`

Observed selected output:

```text
13: import { recordedPathFromFileUri, scannerSourcePath } from '../write-through.ts';
14: import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
15: import { assertPurgeParams } from './purge-params.ts';
16: import { loadActivePackForWriteVocabulary } from '../schema-pack/write-vocabulary.ts';
17: import { authorizeWrite } from './authority.ts';
18: import { digest, sha256 } from './digest.ts';
19: import { getWorktreeBinding } from './ownership.ts';
20: import type { PreparedContentImport } from './prepared-import.ts';
21: import type { PreparedMutation } from './coordinator.ts';
22: import type { WriteRequest } from './model.ts';
23: import { sealPageTextProjection } from '../page-state/projections.ts';
24: import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
186:   // never set this. Both remote and local put_page funnel through here.
187:   // Best-effort: no resolvable pack (missing / corrupt / trust-gated) ->
188:   // null -> no vocabulary to enforce -> legacy verbatim behavior preserved.
189:   const canonicalPack = row.operation === 'put_page'
190:     ? await loadActivePackForWriteVocabulary({ engine, remote: row.authority?.remote, sourceId: row.source_id })
191:     : null;
192:   const result = await importFromContent(engine, row.slug, content, {
193:     ...source, noEmbed: true, remote: row.authority.remote,
194:     forceRechunk: row.operation === 'restore_page' || row.operation === 'revert_version',
195:     allowEmptyOverwrite: p.allow_empty === true || row.operation === 'restore_page' || row.operation === 'revert_version',
196:     activePack: canonicalPack ? { page_types: canonicalPack.manifest.page_types.map((pt) => ({ name: pt.name, path_prefixes: pt.path_prefixes, aliases: pt.aliases })) } : undefined,
197:     enforceCanonicalType: row.operation === 'put_page',
198:     source_kind: typeof p.source_kind === 'string' ? p.source_kind : null,
199:     source_uri: typeof p.source_uri === 'string' ? p.source_uri : null,
200:     ingested_via: typeof p.ingested_via === 'string' ? p.ingested_via : null,
201:     prepareFrontmatter: page => { provenance = putProvenance(row, snapshot, page); },
202:     prepare: async value => { prepared = value; return value.result; },
203:   });
204:   signal?.throwIfAborted();
205:   if (!prepared) {
```

### E:exclude-write-e90ad6edd

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/ops/pages.ts`

Observed selected output:

```text
178:
179: /**
180:  * Stage-2 write-path hygiene gate (approved policy): put_page must never
181:  * persist content into a root the operator excluded from the brain's indexing
182:  * scope via `sync.exclude` — the same persisted config the sync and import
183:  * walkers honor. Sync/import skip these roots at walk time; a direct put_page
184:  * write previously BYPASSED that scope and would both persist the page AND
185:  * embed it into the graph. This gate closes that hole for the new-write
186:  * put_page surface (remote MCP and local CLI funnel through the same op),
187:  * uniformly and BEFORE any embedding / DB row / disk file is touched.
188:  *
189:  * Semantics mirror sync's own exclude handling:
190:  *   - patterns split on comma or newline, trimmed, empties dropped;
191:  *   - a trailing `/` is widened to a `/**` subtree glob (so `raw/` reads as
192:  *     "the whole subtree"), matching performSyncInner's normalization so the
197:  *   - "without touching existing pages": only the NEW slug is rejected; no
198:  *     existing page under an excluded root is removed, modified, or purged.
199:  *   - "without breaking valid non-excluded writes": slugs that match no
200:  *     excluded root fall through untouched (identical behavior to today).
201:  *   - no `sync.exclude` configured (or the config read fails) => fail-open
202:  *     exactly like a sync: nothing is scoped, so nothing is rejected.
203:  *   - enforcement is scoped to this new-write op only; sync/legacy reads and
204:  *     import-from-existing surfaces never consult this gate.
205:  */
206: async function enforceExcludedRootGuard(engine: BrainEngine, slug: string, logger: Logger): Promise<void> {
207:   let stored: string | null = null;
208:   try {
209:     stored = await engine.getConfig('sync.exclude');
210:   } catch {
211:     // Config unreadable — never break a write over a scope read (mirrors sync).
212:     logger.warn(`[put_page] sync.exclude unreadable; skipping write-path hygiene check for '${slug}'`);
213:     return;
214:   }
215:   const patterns = (stored ?? '')
216:     .split(/[\n,]/)
217:     .map((p) => p.trim())
218:     .filter(Boolean)
219:     .map((p) => (p.endsWith('/') ? `${p}**` : p));
220:   if (patterns.length === 0) return;
221:   if (matchesAnyGlob(slug, patterns)) {
222:     throw new OperationError(
223:       'permission_denied',
224:       `put_page: refusing to write '${slug}' — its path falls under an excluded root configured in sync.exclude.`,
225:       `Choose a slug outside the excluded roots (${patterns.join(', ')}), or adjust sync.exclude if this path should be indexed. Nothing was written or embedded.`,
226:     );
227:   }
228: }
229:
230: const put_page: Operation = {
231:   name: 'put_page',
232:   description: 'Replace a complete canonical Markdown page. Read get_page with include_content:true and pass its revision as expected_revision; force explicitly overwrites the current revision. Omitting both permits creation only. Retain a UUID request_id and repeat identical arguments after transport failure or a pending receipt. Content, tags, sanitized text projections, versions and the committed receipt publish together; embedding and optional Git effects have separate status. Remote callers preserve protected facts/takes fences; automatic graph links are skipped for untrusted writes. A stdio `gbrain serve` sweeps them at startup + on idle; `gbrain serve --http` does not self-sweep — run `gbrain sweep --once` or use trusted local capture/put_page for inline link extraction. Remote callers receive write_through.warning when no repo is configured. For file input use gbrain capture --file PATH --slug SLUG.',
233:   params: {
234:     ...PAGE_MUTATION_PARAMS,
235:     slug: { type: 'string', required: true, description: 'Page slug' },
250:   handler: async (ctx, p) => {
251:     pageMutationSource(ctx, p, 'put_page');
252:     // Stage-2 write-path hygiene gate (approved policy): put_page must never
253:     // persist content into a root the operator has excluded from the brain's
254:     // indexing scope (`sync.exclude` — the same persisted config the sync and
255:     // import walkers honor). Sync excludes these roots at walk time, so a
256:     // direct put_page write previously BYPASSED that scope and would land,
257:     // embed, and persist excluded content into the graph. Reject here BEFORE
258:     // the dry-run short-circuit so preview calls surface the same rejection,
259:     // and before any admission/journaling so nothing is persisted. Slugs are
260:     // lowercased by the persistence layer, so match the canonical (lowercased)
261:     // slug the write would actually persist.
262:     await enforceExcludedRootGuard(ctx.engine, (typeof p.slug === 'string' ? p.slug : '').toLowerCase(), ctx.logger);
263:     if (ctx.dryRun) {
264:       if (typeof p.slug === 'string') {
265:         validatePageSlug(p.slug);
266:         enforceClientSlugFence(ctx, p.slug, 'put_page');
267:         enforceSubagentSlugFence(ctx, p.slug, 'put_page');
268:       }
269:       return { dry_run: true, action: 'put_page', slug: p.slug };
270:     }
271:     return submitPageMutation(ctx, { operation: 'put_page', params: p });
272:   },
```

### E:search-params-e90ad6edd

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/ops/search.ts`

Observed selected output:

```text
199: /**
200:  * Expose the engine's stable slug-prefix exclusion (SearchOpts.
201:  * exclude_slug_prefixes, which both engines' keyword/title/vector/hybrid legs
202:  * already union into their hard-exclude clause via resolveHardExcludes — e.g.
203:  * `['test/', 'atoms/']`). Additive over the DEFAULT_HARD_EXCLUDES union and
216:     throw new OperationError(
217:       'invalid_params',
218:       '`exclude_slug_prefixes` must be an array of slug-prefix strings (CLI: --exclude-slug-prefixes test/,atoms/).',
219:     );
220:   }
223:     throw new OperationError(
224:       'invalid_params',
225:       '`exclude_slug_prefixes` was provided but contained no usable slug-prefix strings.',
226:     );
227:   }
286:     // #3985: multi-type filter (plumbing shipped v0.33; exposed here).
287:     types: { type: 'array', items: { type: 'string' }, description: TYPES_PARAM_DESCRIPTION },
288:     // Expose slug-prefix excludes on the public op (SearchOpts.exclude_slug_prefixes).
289:     exclude_slug_prefixes: { type: 'array', items: { type: 'string' }, description: EXCLUDE_SLUG_PREFIXES_PARAM_DESCRIPTION },
290:     // Default covered-atom retrieval policy opt-in (smallest backwards-compatible boolean).
291:     include_covered_atoms: { type: 'boolean', description: INCLUDE_COVERED_ATOMS_PARAM_DESCRIPTION },
292:     // #3800: subagent token economy — per-call snippet cap.
293:     snippet_chars: { type: 'number', description: SNIPPET_CHARS_PARAM_DESCRIPTION },
320:     let types = normalizeTypesParam(p.types);
321:     // Additive slug-prefix exclusion (stacks with `types`; independent axis).
322:     const excludeSlugPrefixes = normalizeExcludeSlugPrefixesParam(p.exclude_slug_prefixes);
323:     // Default covered-atom policy: falsy/absent = source-covered atoms hidden,
324:     // uncovered atoms always kept; true = include every atom.
325:     const includeCoveredAtoms = p.include_covered_atoms === true;
326:     // #3800: snippet cap (param > subagent config default > full text).
327:     const snippetCap = await resolveSnippetCap(ctx, p);
354:         if (types?.length === 0) return [];
355:       }
356:       const raw = await ctx.engine.searchKeyword(queryText, { limit, offset, excludePrivate, requireSafeChunks: ctx.remote !== false, ...(types ? { types } : {}), ...(excludeSlugPrefixes ? { exclude_slug_prefixes: excludeSlugPrefixes } : {}), includeCoveredAtoms, ...scope });
357:       const results = dedupResults(raw).map(r => ({ ...r }));
358:       // #3783 — every row here IS a keyword hit (direct FTS path); mark
390:       takesHoldersAllowList: readHolders(ctx),
391:       ...(types ? { types } : {}),
392:       ...(excludeSlugPrefixes ? { exclude_slug_prefixes: excludeSlugPrefixes } : {}),
393:       includeCoveredAtoms,
394:       ...scope,
445:     // #3985: multi-type filter (plumbing shipped v0.33; exposed here).
446:     types: { type: 'array', items: { type: 'string' }, description: TYPES_PARAM_DESCRIPTION },
447:     // Expose slug-prefix excludes on the public op (SearchOpts.exclude_slug_prefixes).
448:     exclude_slug_prefixes: { type: 'array', items: { type: 'string' }, description: EXCLUDE_SLUG_PREFIXES_PARAM_DESCRIPTION },
449:     // Default covered-atom retrieval policy opt-in (smallest backwards-compatible boolean).
450:     include_covered_atoms: { type: 'boolean', description: INCLUDE_COVERED_ATOMS_PARAM_DESCRIPTION },
451:     // #3800: subagent token economy — per-call snippet cap.
452:     snippet_chars: { type: 'number', description: SNIPPET_CHARS_PARAM_DESCRIPTION },
542:     let types = normalizeTypesParam(p.types);
543:     // Additive slug-prefix exclusion (stacks with `types`; independent axis).
544:     const excludeSlugPrefixes = normalizeExcludeSlugPrefixesParam(p.exclude_slug_prefixes);
545:     // Default covered-atom policy: falsy/absent = source-covered atoms hidden,
546:     // uncovered atoms always kept; true = include every atom.
547:     const includeCoveredAtoms = p.include_covered_atoms === true;
548:     // #3800: snippet cap (param > subagent config default > full text).
549:     const snippetCap = await resolveSnippetCap(ctx, p);
605:         takesHoldersAllowList: readHolders(ctx),
606:         ...(types ? { types } : {}),
607:         ...(excludeSlugPrefixes ? { exclude_slug_prefixes: excludeSlugPrefixes } : {}),
608:         includeCoveredAtoms,
609:         ...querySourceScope,
668:       types,
669:       // Additive slug-prefix exclusion — reaches every hybrid leg.
670:       ...(excludeSlugPrefixes ? { exclude_slug_prefixes: excludeSlugPrefixes } : {}),
671:       includeCoveredAtoms,
672:       language: (p.lang as string) || undefined,
765:             // Preserve the caller's slug-prefix excludes + covered-atom policy
766:             // on the re-run (both already normalized above).
767:             ...(excludeSlugPrefixes ? { exclude_slug_prefixes: excludeSlugPrefixes } : {}),
768:             includeCoveredAtoms,
769:             language: (p.lang as string) || undefined,
```

### E:GO-e90ad6edd

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/ai/gateway.ts`

Observed selected output:

```text
314:  *
315:  * @internal exported for tests; not part of the public gateway API.
316:  */
317: export function opencodeGoSessionHeaders(
318:   recipe: Recipe,
319:   cfg: AIGatewayConfig,
320: ): Record<string, string> | undefined {
321:   // Only the two recipes that today run as OpenCode GO lanes.
322:   if (recipe.id !== 'deepseek' && recipe.id !== 'litellm') return undefined;
323:   const baseURL = cfg.base_urls?.[recipe.id] ?? recipe.base_url_default;
324:   if (!baseURL) return undefined;
325:   let host: string;
353:
354:   // v0.37.6.0 — resolve default_headers (static or env-templated). Mutually
355:   // exclusive; declaring both is a config error.
356:   if (recipe.default_headers && recipe.resolveDefaultHeaders) {
357:     throw new AIConfigError(
358:       `Recipe "${recipe.id}" declares both default_headers and resolveDefaultHeaders. Pick one.`,
359:       recipe.setup_hint,
360:     );
361:   }
362:   const defaults = recipe.resolveDefaultHeaders
363:     ? recipe.resolveDefaultHeaders(cfg.env)
364:     : recipe.default_headers;
365:
366:   // v0.48.4.1 (OpenCode GO): the deepseek/litellm GO lanes need a nonempty
367:   // `x-opencode-session` header on every request to opencode.ai. Merge it into
368:   // the defaults so it rides all three touchpoints (embedding/expansion/chat).
369:   // Non-GO base URLs get nothing.
370:   const goHeaders = opencodeGoSessionHeaders(recipe, cfg);
371:   const effectiveDefaults = goHeaders
372:     ? { ...(defaults ?? {}), ...goHeaders }
373:     : defaults;
374:
375:   // v0.37.6.0 — defaults MUST NOT shadow the resolved auth header. SDK applies
376:   // headers after apiKey, so an `Authorization` entry in defaults would replace
377:   // the Bearer the SDK adds. Custom-header recipes (Azure: api-key) are
378:   // protected the same way.
379:   if (effectiveDefaults) {
380:     const lcResolved = resolved.headerName.toLowerCase();
381:     for (const k of Object.keys(effectiveDefaults)) {
382:       const lc = k.toLowerCase();
383:       if (lc === 'authorization' || lc === lcResolved) {
384:         throw new AIConfigError(
385:           `Recipe "${recipe.id}" default_headers contains "${k}" which would shadow the auth header. Remove it.`,
386:           recipe.setup_hint,
387:         );
388:       }
389:     }
396:     resolved.headerName === 'Authorization' &&
397:     resolved.token.startsWith('Bearer ')
398:   ) {
399:     return effectiveDefaults
400:       ? { apiKey: resolved.token.slice('Bearer '.length), headers: { ...effectiveDefaults } }
401:       : { apiKey: resolved.token.slice('Bearer '.length) };
402:   }
403:
404:   // Custom header (Azure: api-key). Use headers; do NOT pass apiKey, or the
405:   // SDK will also set Authorization and the server may reject double-auth.
406:   // Defaults merge in first, resolver wins on key conflict (the shadow guard
407:   // above already rejects conflicts, so this is defense-in-depth).
408:   return { headers: { ...(effectiveDefaults ?? {}), [resolved.headerName]: resolved.token } };
409: }
410:
411: /**
412:  * Resolve the openai-compatible URL + optional fetch wrapper. Defaults to
413:  * `cfg.base_urls?.[recipe.id] ?? recipe.base_url_default` (the pre-v0.32
414:  * behavior). Recipes whose URL is env-templated (Azure: needs endpoint +
415:  * deployment + api-version) override `recipe.resolveOpenAICompatConfig` to
416:  * build the URL and inject custom fetch behavior.
```

### E:gazetteer-0460af288

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/by-mention.ts`

Observed selected output:

```text
496:   const allTypes = [...new Set([...typesBySource.values()].flatMap(set => [...set]))];
497:   const linkable = (sourceId: string | null, type: string | null) => !!type && (typesBySource.get(sourceId ?? 'default')?.has(type) ?? false);
498:   const rows = (await engine.executeRaw<{ slug: string; source_id: string | null; title: string | null; type: string | null; connector_stub: boolean }>(
499:     `SELECT slug, source_id, title, type, (frontmatter ->> 'google_contact_id') IS NOT NULL AS connector_stub
500:      FROM pages
501:      WHERE type = ANY($1::text[])
502:        AND deleted_at IS NULL`,
503:     [allTypes],
504:   )).filter(r => linkable(r.source_id, r.type));
505:   const stubPages = new Set(rows.filter(r => r.connector_stub).map(r => `${r.source_id ?? 'default'}\0${r.slug}`));
506:   const stubFlag = (src: string, slug: string) => stubPages.has(`${src}\0${slug}`) ? { connector_stub: true as const } : {};
507:
578:     origin: string | null; case_sensitive: boolean | null; alias_text: string | null; identity: unknown }> = [];
579:   try {
580:     aliasRows = (await engine.executeRaw<typeof aliasRows[number]>(
581:       `SELECT pa.alias_norm, pa.slug, pa.source_id, p.title, p.type, pa.origin, pa.case_sensitive, pa.alias_text, p.frontmatter->>'identity' AS identity
582:        FROM page_aliases pa
583:        JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
584:        WHERE p.type = ANY($1::text[])
585:          AND p.deleted_at IS NULL`,
586:       [allTypes],
587:     )).filter(r => linkable(r.source_id, r.type));
588:   } catch (err) {
589:     // pre-v110 brains: no page_aliases table — titles-only gazetteer.
975:     id: number; slug: string; source_id: string | null; body: string;
976:   }>(
977:     `${scannedCte}
978:      SELECT p.id, p.slug, p.source_id,
979:             COALESCE(p.title, '') || E'\n\n' || COALESCE(p.compiled_truth, '') || E'\n\n' || COALESCE(p.timeline, '') AS body
980:        FROM pages p
981:        JOIN scanned s ON s.id = p.id
982:       ORDER BY p.slug`,
983:     [limit],
984:   );
985:
986:   const rows = await engine.executeRaw<{
988:     to_source_id: string | null; link_kind: string | null;
989:   }>(
990:     `${scannedCte}
991:      SELECT l.from_page_id AS from_id, f.slug AS from_slug,
992:             t.slug AS to_slug, t.source_id AS to_source_id, l.link_kind
993:        FROM links l
994:        JOIN scanned s ON s.id = l.from_page_id
995:        JOIN pages f ON f.id = l.from_page_id
996:        JOIN pages t ON t.id = l.to_page_id
997:       WHERE l.link_source = 'mentions'
998:       ORDER BY f.slug, t.slug`,
999:     [limit],
```

### E:gazetteer-e90ad6edd

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/by-mention.ts`

Observed selected output:

```text
34: // #4222: shared generic-token reject list — same list gates enrichEntity
35: // minting and drives the junk_entity_hubs doctor check.
36: import { isGenericEntityToken } from './entity-name-quality.ts';
37: import { QUARANTINE_FILTER_FRAGMENT } from './quarantine.ts';
38:
39: /** D2: hardcoded entity types for v1. Pack-aware extension is TODO-1. */
40: export const LINKABLE_ENTITY_TYPES = ['person', 'company', 'organization', 'entity'] as const;
41:
42: /**
43:  * Minimum title length for gazetteer inclusion. Filters out 2-3 char names
44:  * (AI, YC, X, IBM) that produce dense false-positive auto-links in body text.
45:  * Codex CK13 noted v1 will under-deliver on 3-char real entities; the
401: ): Promise<Gazetteer> {
402:   const typeList = LINKABLE_ENTITY_TYPES.map(t => `'${t}'`).join(', ');
403:   const rows = await engine.executeRaw<{ slug: string; source_id: string | null; title: string | null; type: string | null }>(
404:     `SELECT p.slug, p.source_id, p.title, p.type
405:      FROM pages p
406:      WHERE p.type IN (${typeList})
407:        AND p.deleted_at IS NULL
408:        AND ${QUARANTINE_FILTER_FRAGMENT}`,
409:     [],
410:   );
411:
412:   // Pre-build the existing-slug Set so the ignore-list rule can check
413:   // "does this name already correspond to a real page?" in O(1).
414:   const existingTitles = new Set<string>();
415:   for (const r of rows) {
416:     if (r.title) existingTitles.add(r.title);
473:       source_id: string | null;
474:       title: string | null;
475:     }>(
476:       `SELECT pa.alias_norm, pa.slug, pa.source_id, p.title
477:        FROM page_aliases pa
478:        JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
479:        WHERE p.type IN (${typeList})
480:          AND p.deleted_at IS NULL
481:          AND ${QUARANTINE_FILTER_FRAGMENT}`,
482:       [],
483:     );
484:     const ignoreLc = new Set(Array.from(ignoreSet, (s) => s.toLowerCase()));
485:     // Per-source title index for alias-vs-title collision checks.
486:     const titleBySource = new Set<string>();
487:     for (const r of rows) {
488:       if (r.title) titleBySource.add(`${r.source_id ?? 'default'} ${r.title.toLowerCase()}`);
489:     }
770:     id: number; slug: string; source_id: string | null; body: string;
771:   }>(
772:     `${scannedCte}
773:      SELECT p.id, p.slug, p.source_id,
774:             COALESCE(p.compiled_truth, '') || E'\n\n' || COALESCE(p.timeline, '') AS body
775:        FROM pages p
776:        JOIN scanned s ON s.id = p.id
777:       ORDER BY p.slug`,
778:     [limit],
779:   );
780:
781:   const rows = await engine.executeRaw<{
783:     to_source_id: string | null; link_kind: string | null;
784:   }>(
785:     `${scannedCte}
786:      SELECT l.from_page_id AS from_id, f.slug AS from_slug,
787:             t.slug AS to_slug, t.source_id AS to_source_id, l.link_kind
788:        FROM links l
789:        JOIN scanned s ON s.id = l.from_page_id
790:        JOIN pages f ON f.id = l.from_page_id
791:        JOIN pages t ON t.id = l.to_page_id
792:       WHERE l.link_source = 'mentions'
793:       ORDER BY f.slug, t.slug`,
794:     [limit],
```

### E:quarantine-command

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/commands/quarantine.ts`

Observed selected output:

```text
1: /**
2:  * gbrain quarantine — operator surface for the content-quality gate (issue #1699).
3:  *
4:  *   gbrain quarantine list [--json] [--include-flagged]   (also write-gate fact/take holds)
5:  *   gbrain quarantine clear <slug> [--force] [--no-embed] [--json]
6:  *   gbrain quarantine scan [--limit N] [--apply] [--no-embed] [--json]
7:  *
8:  * `quarantine` (hidden) marks high-confidence junk; `content_flag` (warned,
9:  * still searchable) marks fuzzy markup-heavy / oversize pages. See
10:  * src/core/quarantine.ts for the marker contract.
11:  */
12: import type { BrainEngine } from '../core/engine.ts';
13: import { isQuarantined, getContentFlag, QUARANTINE_KEY, CONTENT_FLAG_KEY } from '../core/quarantine.ts';
14: import { serializePageToMarkdown, serializeMarkdown } from '../core/markdown.ts';
15: import { importFromContent } from '../core/import-file.ts';
16: import { randomUUID } from 'node:crypto';
17: import { loadConfig } from '../core/config.ts';
18: import { opError, type OperationContext } from '../core/ops/contract.ts';
19: import { readFix } from '../core/ops/op-fix.ts';
20: import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
21: import { submitPageMutation } from '../core/persistence/page-mutations.ts';
22: import { resolveCliWriteWaitMs } from '../core/persistence/write-wait.ts';
23: import { QUARANTINE_OVERRIDE_KEY, quarantineOverrideFor } from '../core/quarantine-override.ts';
24: import { reportPersistenceCliError } from './persistence-delegate.ts';
25: import type { PageType } from '../core/types.ts';
26: import { listWriteGateHolds, type WriteGateHold } from '../core/write-gate-store.ts';
27:
28: export interface QuarantineRow {
29:   slug: string;
30:   source_id: string;
31:   marker: 'quarantine' | 'content_flag';
32:   reason: string;
33:   assessed_at: string;
34: }
35:
36: export function rowFor(page: { slug: string; source_id?: string; frontmatter?: Record<string, unknown> | null }): QuarantineRow | null {
37:   const fm = page.frontmatter ?? null;
38:   if (isQuarantined(fm)) {
39:     const m = (fm as Record<string, unknown>)[QUARANTINE_KEY] as Record<string, unknown>;
40:     return {
41:       slug: page.slug,
42:       source_id: page.source_id ?? 'default',
43:       marker: 'quarantine',
44:       reason: typeof m?.reason === 'string' ? m.reason : 'unknown',
45:       assessed_at: typeof m?.assessed_at === 'string' ? m.assessed_at : '',
46:     };
47:   }
48:   const flag = getContentFlag(fm);
49:   if (flag) {
50:     const m = (fm as Record<string, unknown>)[CONTENT_FLAG_KEY] as Record<string, unknown>;
51:     return {
52:       slug: page.slug,
53:       source_id: page.source_id ?? 'default',
54:       marker: 'content_flag',
55:       reason: flag.reason,
56:       assessed_at: typeof m?.assessed_at === 'string' ? m.assessed_at : '',
57:     };
58:   }
59:   return null;
60: }
61:
62: // Bounds for the quarantine_list op's clamps (src/core/ops/admin.ts); the CLI
63: // list stays unbounded. One canonical home so the op clamps and the param
64: // descriptions can't drift apart silently.
65: export const QUARANTINE_LIST_DEFAULT_LIMIT = 200;
```

### E:official-cost-gate

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/cycle/extract-atoms-cost-gate.ts`

Observed selected output:

```text
1: /**
2:  * Cost-gate decision for the extract_atoms BudgetTracker.
3:  *
4:  * Split out of extract-atoms.ts so the decision is a pure, unit-testable
5:  * function and the phase file stays under the module-size cap. See the
6:  * "cost cap" comment at the tracker construction site in extract-atoms.ts
7:  * for the defect this closes.
8:  */
9:
10: import { isAvailable, getEmbeddingModel } from '../ai/gateway.ts';
11: import { isModelPriceable, type PricingOverrides } from '../budget/budget-tracker.ts';
12: import { noPricingGuidance, noPricingMessage, pricingSetCommand, type NoPricingGuidance } from '../budget/no-pricing.ts';
13: import type { BrainEngine } from '../engine.ts';
14: import type { PhaseResult } from '../cycle.ts';
15: import { classifyRunStop, upsertExtractRollup } from '../extract/rollup-writer.ts';
16:
17: /**
18:  * Cost-gate decision for the extract_atoms BudgetTracker.
19:  *
20:  * `enforceCap: true` → construct the tracker with `maxCostUsd`. `false` → run
21:  * uncapped (the tracker then warns once on unpriced models instead of throwing)
22:  * and `unpricedModel`/`unpricedKind` name the call that made the cap
23:  * unenforceable. `refusal` → an explicit budget met an unpriced route: the run
24:  * makes no model call and reports the guidance. Pure: no config or gateway
25:  * access, so it is unit-testable.
26:  */
27: export interface ExtractAtomsCostGate {
28:   enforceCap: boolean;
29:   unpricedModel?: string;
30:   unpricedKind?: 'chat' | 'embed';
31:   /** Explicit budget + unpriced chat or embed route: refuse, with the no_pricing guidance. */
32:   refusal?: NoPricingGuidance;
33: }
34:
35: /**
36:  * Both models that bill under the extract_atoms tracker must be priceable for
37:  * a cap to be enforceable: the extraction chat model AND the embedding model
38:  * the atom import path calls (pass `null` when embedding is unavailable, in
39:  * which case the import runs with `noEmbed` and nothing embeds). Operator
40:  * `pricing.overrides` are consulted first, matching BudgetTracker.reserve().
41:  *
42:  * `explicitBudget` = the operator SET `cycle.extract_atoms.budget_usd`. A
43:  * default cap is dropped for an unpriced route (warn and run, so a new model
44:  * still works). A cap the operator set is a spending limit: the run is
45:  * refused with guidance to look the price up and register it, for the chat
46:  * model and the embed route alike.
47:  */
48: export function resolveExtractAtomsCostGate(
49:   extractModel: string,
50:   embedModel: string | null,
51:   overrides?: PricingOverrides,
52:   opts: { explicitBudget?: boolean } = {},
53: ): ExtractAtomsCostGate {
54:   const unpriced: { model: string; kind: 'chat' | 'embed' } | null =
55:     !isModelPriceable(extractModel, 'chat', overrides) ? { model: extractModel, kind: 'chat' }
[additional inspected output omitted here; inspect the frozen file for full context]
127:   };
128: }
129:
130: /**
131:  * Doctor's extract_health overlay, applied in place: a recorded refusal turns
132:  * the check into a warning that names the model, what to look up and the
133:  * registration command.
134:  */
135: export function applyExtractAtomsNoPricing(
136:   check: { status: 'ok' | 'warn' | 'fail'; message: string; details?: Record<string, unknown> },
137:   refusals: Array<NoPricingGuidance & { source_id: string }>,
138: ): void {
139:   if (refusals.length === 0) return;
140:   const first = refusals[0]!;
141:   if (check.status !== 'fail') check.status = 'warn';
142:   check.message = `extract_atoms refused under its cost cap in ${refusals.length} source(s): no price for ${first.model}. ` +
143:     `${first.lookup} Then run on the brain host: ${first.register_command}; ${check.message}`;
144:   check.details = { ...(check.details ?? {}), no_pricing: refusals };
145: }
146:
147: /** Every source's recorded extract_atoms refusal, for doctor's extract_health. */
148: export async function readExtractAtomsNoPricing(engine: BrainEngine): Promise<Array<NoPricingGuidance & { source_id: string }>> {
149:   const out: Array<NoPricingGuidance & { source_id: string }> = [];
150:   for (const key of await engine.listConfigKeys(ATOMS_NO_PRICING_KEY_PREFIX)) {
151:     try {
152:       const value = JSON.parse((await engine.getConfig(key)) ?? '');
153:       if (value && value.code === 'no_pricing') out.push({ ...value, source_id: key.slice(ATOMS_NO_PRICING_KEY_PREFIX.length) });
154:     } catch { /* unreadable record: skip */ }
155:   }
156:   return out;
157: }
158:
159: /**
160:  * The embedding model the atom import will bill under this phase's tracker,
161:  * or `null` when embedding is unavailable (the write site then passes
162:  * `noEmbed: true` and no embed call happens). Mirrors the write site's own
163:  * `isAvailable('embedding')` check so the gate and the import agree.
164:  */
165: export function resolveEmbedModelForCostGate(): string | null {
166:   try {
167:     return isAvailable('embedding') ? getEmbeddingModel() : null;
168:   } catch {
169:     return null;
170:   }
171: }
```

### E:local-quarantine-recheck

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/cycle/extract-atoms-quarantine.ts`

Observed selected output:

```text
1: /**
2:  * Execution-boundary quarantine re-check for extract_atoms.
3:  *
4:  * Candidate SELECTION already excludes quarantined pages — both
5:  * `discoverExtractablePages` and `countExtractAtomsBacklog` carry
6:  * `quarantineFilterFragment('p')` — so a page the content-quality gate marked
7:  * `quarantine` (high-confidence junk: Cloudflare/CAPTCHA interstitials,
8:  * operator literals) never enters the candidate list in the first place.
9:  *
10:  * This helper closes the RACE: a page can be quarantined BETWEEN listing and
11:  * execution (a concurrent `quarantine scan`, an import/sync disposition, or a
12:  * capture write). The drain holds a single continuous lock, but sync/capture
13:  * run on their own connections, so the page list can be stale by the time the
14:  * work loop reaches a page. Re-checking the marker here, at the execution
15:  * boundary, keeps the "junk never reaches the model" guarantee true even when
16:  * the quarantine lands after discovery — one batched query for every page in
17:  * the batch, not per item.
18:  *
19:  * Split out of extract-atoms.ts to respect the module-size ratchet; stateless
20:  * and pure over the engine seam so it is unit-testable against PGLite.
21:  */
22:
23: import type { BrainEngine } from '../engine.ts';
24: import type { PhaseResult } from '../cycle.ts';
25: import { QUARANTINE_KEY } from '../quarantine.ts';
26:
27: /**
28:  * Thrown when the execution-boundary quarantine re-check cannot be answered
29:  * (query error / DB unavailable). Carries the underlying message so the phase
30:  * can surface WHY it refused to run.
31:  */
32: export class QuarantineRecheckError extends Error {
33:   readonly tag = 'QUARANTINE_RECHECK_FAILED' as const;
34:   constructor(cause: unknown) {
35:     const msg = cause instanceof Error ? cause.message : String(cause);
36:     super(`quarantine re-check failed: ${msg}`);
37:     this.name = 'QuarantineRecheckError';
38:   }
39: }
40:
41: /**
42:  * Return the subset of `slugs` that currently carry the `quarantine` marker in
43:  * the given source. Marker semantics mirror `isQuarantined` /
44:  * `quarantineFilterFragment`: key EXISTENCE (non-null) triggers, not a value.
45:  *
46:  * FAIL-CLOSED on a query error: throws `QuarantineRecheckError` instead of
47:  * returning the empty set. Returning empty would claim "none of these pages
48:  * are quarantined" when the true answer is UNKNOWN, and the phase would then
49:  * send the batch to the model — exactly the fail-OPEN that lets quarantined
50:  * junk reach the LLM. The caller treats a throw as "refuse to run, zero model
51:  * calls" (see `quarantineRecheckFailedResult`). The quarantine status of a
52:  * candidate is never assumed when it cannot be verified.
53:  */
54: export async function quarantinedSlugsAmong(
55:   engine: BrainEngine,
[additional inspected output omitted here; inspect the frozen file for full context]
87: /**
88:  * Build the FAIL-CLOSED phase result for an unanswerable quarantine re-check.
89:  *
90:  * The phase makes ZERO model calls: neither the pages whose status is unknown
91:  * NOR anything else runs, because a DB that cannot answer the re-check is not
92:  * a DB whose listing snapshot we can trust. The result is `skipped` with
93:  * `blocked: true` / `blocked_reason: 'quarantine_recheck_failed'` so the drain
94:  * adapter and operators see WHY nothing was extracted, instead of a silent
95:  * empty batch.
96:  */
97: export function quarantineRecheckFailedResult(
98:   cause: unknown,
99:   ctx: QuarantineRecheckFailedContext,
100: ): PhaseResult {
101:   const msg = cause instanceof Error ? cause.message : String(cause);
102:   console.error(
103:     `[extract_atoms] FAIL-CLOSED: quarantine re-check failed — refusing to run (0 model calls) ` +
104:       `rather than risk sending quarantined junk to the model: ${msg}`,
105:   );
106:   return {
107:     phase: 'extract_atoms',
108:     status: 'skipped',
109:     duration_ms: 0,
110:     summary:
111:       'extract_atoms: fail-closed — quarantine re-check failed, 0 model calls',
112:     details: {
113:       reason: 'quarantine_recheck_failed',
114:       blocked: true,
115:       blocked_reason: 'quarantine_recheck_failed',
116:       source_id: ctx.sourceId,
117:       dry_run: ctx.dryRun,
118:       atoms_extracted: 0,
119:       transcripts_processed: 0,
120:       transcripts_total: ctx.transcriptsTotal,
121:       transcripts_skipped_budget: 0,
122:       pages_processed: 0,
123:       pages_total: ctx.pagesTotal,
124:       pages_excluded_quarantined: 0,
125:       duplicates_skipped: ctx.duplicatesSkipped,
126:       failures: [],
127:       estimated_spend_usd: 0,
128:       budget_usd: ctx.budgetUsd,
129:     },
130:   };
131: }
```

### E:official-drain-adapter

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/cycle/extract-atoms-drain.ts`

Observed selected output:

```text
490:   return runExtractAtomsDrain(
491:     {
492:       withLock: (work) => withRefreshingLock(engine, lockId, (signal) => work(signal), { ttlMinutes: 5 }),
493:       runBatch: async ({ signal, stopSignal }) => {
494:         const r = await runPhaseExtractAtomsStamped(engine, {
495:           sourceId: extractionSourceId,
496:           dryRun: false,
497:           brainDir: opts.brainDir,
498:           signal,
499:           stopSignal,
500:           attempt,
501:         });
502:         const d = (r.details ?? {}) as Record<string, unknown>;
503:         // issue #3218: `r.status` collapses to 'warn' whether ONE item failed
504:         // (partial success — leave the drain's existing ok/no_progress path
505:         // alone) or EVERY item failed (a total provider outage the drain
506:         // adapter was silently swallowing). Re-derive the total-failure case
507:         // from the per-item counts `runPhaseExtractAtoms` already returns:
508:         // >=1 failure AND zero items successfully processed (transcripts_processed
509:         // + pages_processed both 0 means every attempted `chat()` call threw —
510:         // items that succeed with 0 atoms still count as processed, so this
511:         // does not fire on "provider fine, nothing extractable").
512:         const failures = Array.isArray(d.failures) ? d.failures : [];
513:         const itemsSucceeded =
514:           Number(d.transcripts_processed ?? 0) + Number(d.pages_processed ?? 0);
515:         // #4730: carry EVERY per-item failure up as a typed {source, reason}
516:         // record (the pure loop bounds + sanitizes them) instead of the
517:         // #4539 collapse to count + one representative error — a mixed
518:         // three-failure batch used to be unrecoverable from `--json`.
519:         const typedFailures = failures
520:           .filter(
521:             (f): f is { source: string; error: string } =>
522:               f != null &&
523:               typeof f === 'object' &&
524:               typeof (f as { source?: unknown }).source === 'string' &&
525:               typeof (f as { error?: unknown }).error === 'string',
526:           )
527:           .map(({ source, error }) => ({ source, reason: error }));
528:         return {
529:           extracted: Number(d.atoms_extracted ?? 0),
530:           skipped: Number(d.duplicates_skipped ?? 0),
531:           providerFailure: failures.length > 0 && itemsSucceeded === 0,
532:           failureCount: failures.length,
533:           failures: typedFailures,
534:           budgetSkipped: Number(d.pages_skipped_budget ?? 0) + Number(d.transcripts_skipped_budget ?? 0),
535:           budget: { spentUsd: Number(d.estimated_spend_usd ?? 0), capUsd: Number(d.budget_usd ?? 0) },
536:         };
537:       },
538:       countRemaining: (signal) => countExtractAtomsBacklog(engine, extractionSourceId, { signal }),
539:       now: Date.now,
540:       onBatch: opts.onBatch,
541:     },
542:     {
543:       windowMs: opts.windowSeconds * 1000,
544:       maxBatches: opts.maxBatches,
545:       signal: opts.signal,
546:       deadlineAtMs: opts.deadlineAtMs,
547:     },
548:   );
549: }
```

### E:operator-guards

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/operator-quarantine.ts`

Observed selected output:

```text
54: import { resolveSourceLocalFilePath } from './markdown.ts';
55: import { QUARANTINE_KEY } from './quarantine.ts';
56: import { executeRawJsonb } from './sql-query.ts';
57:
58: /** Closed allowlist of operator reasons. Adding one is a deliberate change. */
59: export const OPERATOR_QUARANTINE_REASONS = ['wrong-root-sync'] as const;
77:
78: /** One immutable manifest row. JSONL, one object per line. */
79: export interface OperatorManifestRecord {
80:   id: number;
81:   slug: string;
82:   source_id: string;
83:   /** Expected sha256 of the page at manifest capture time. */
84:   content_hash: string;
85:   /** Recorded source path (may contain commas/spaces — never CSV). */
86:   source_path: string;
87: }
88:
89: export interface OperatorQuarantineMarker {
90:   reason: string;
91:   detail: string;
92:   assessed_at: string;
99: }
100:
101: export interface OperatorPlanRow extends OperatorManifestRecord {
102:   generation: number;
103:   updated_at: string;
104: }
105:
106: export interface OperatorPlanRejection {
107:   id: number;
108:   slug: string;
109:   reason: string;
111: }
112:
113: export interface OperatorQuarantinePlan {
114:   source_id: string;
115:   source_root: string | null;
116:   manifest_sha256: string;
121: }
122:
123: export interface OperatorSnapshotRow extends OperatorPlanRow {
124:   marker: OperatorQuarantineMarker;
125: }
126:
127: export interface OperatorQuarantineSnapshot {
128:   schema_version: 1;
129:   reason: string;
130:   incident: string;
134:   rows: OperatorSnapshotRow[];
135:   /** Path to the archived raw manifest JSONL (written 0600 next to the
136:    *  snapshot). Optional so a hand-authored snapshot stays loadable; when
137:    *  present, rollback re-verifies the archive's sha256 before clearing. */
138:   manifest_path?: string;
139: }
[additional inspected output omitted here; inspect the frozen file for full context]
638:   if (!snapshot || snapshot.schema_version !== 1 || !Array.isArray(snapshot.rows) || snapshot.rows.length === 0) {
639:     throw new OperatorQuarantineError('bad_snapshot', 'snapshot is missing or malformed');
640:   }
641:   const ids = snapshot.rows.map((r) => r.id);
642:
643:   await assertPersistenceDisabled(engine);
644:
647:     // marker or change content_hash between this check and the UPDATE below.
648:     const rows = await tx.executeRaw<{ id: number; content_hash: string | null; generation: number; frontmatter: Record<string, unknown> | null }>(
649:       `SELECT id, content_hash, generation, frontmatter FROM pages WHERE id IN (${intList(ids)}) FOR UPDATE`,
650:     );
651:     const byId = new Map(rows.map((r) => [Number(r.id), r]));
652:     for (const r of snapshot.rows) {
653:       const row = byId.get(r.id);
654:       if (!row) throw new OperatorQuarantineError('rollback_mismatch', `page id ${r.id} (${r.slug}) is missing`);
655:       if (row.content_hash !== r.content_hash) {
656:         throw new OperatorQuarantineError('rollback_mismatch', `page id ${r.id} (${r.slug}) content_hash changed since the snapshot`);
657:       }
658:       const fm = row.frontmatter ?? {};
659:       const live = (fm as Record<string, unknown>)[QUARANTINE_KEY] as Record<string, unknown> | undefined;
660:       if (!live || typeof live !== 'object' || live.operator !== true || live.incident !== snapshot.incident || live.manifest_sha256 !== snapshot.manifest_sha256) {
661:         throw new OperatorQuarantineError(
662:           'rollback_mismatch',
663:           `page id ${r.id} (${r.slug}) does not carry this operator marker (refusing to clear)`,
667:
668:     // Exact-row guarded clear: re-assert id + source_id + slug + content_hash
669:     // + source_path so a drifted row cannot be cleared by a stale snapshot.
670:     // RAW `{ rows }` object through executeRawJsonb — see applyOperatorQuarantine
671:     // for why JSON.stringify + `$N::jsonb` double-encodes under postgres.js.
672:     const guard = {
673:       rows: snapshot.rows.map((r) => ({
674:         id: r.id, source_id: r.source_id, slug: r.slug, content_hash: r.content_hash, source_path: r.source_path,
675:       })),
676:     };
677:     const updated = await executeRawJsonb<{ id: number }>(
678:       tx,
679:       `UPDATE pages p SET frontmatter = p.frontmatter - ${quoteKey(QUARANTINE_KEY)}
680:          FROM jsonb_array_elements(($1::jsonb)->'rows') e
690:       [guard],
691:     );
692:     if (updated.length !== snapshot.rows.length) {
693:       throw new OperatorQuarantineError('apply_count_mismatch', `cleared ${updated.length} of ${snapshot.rows.length}`);
694:     }
695:     return { rolledBack: updated.length };
696:   });
```

### E:assessment-guards

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/search/atom-disposition.ts`

Observed selected output:

```text
13:  * ----------------
14:  * This is NOT a reconciliation, a repair, or a re-bind. It NEVER writes the
15:  * atom, its frontmatter, `source_hash`, `content_hash`, or any companion page.
16:  * It makes NO model calls. A disposition is a HISTORICAL assessment, explicitly
17:  * flagged `historical: true` / `certified: false` and always carrying a warning:
18:  * it is informational evidence about the atom, never a certification that the
19:  * atom is correct or that its binding was restored.
20:  *
25:  * frontmatter `atom_assessments` array of records:
26:  *
27:  *   { atom_id:number, atom_slug:string, source_id:string,
28:  *     frozen_source_hash:string, frozen_source_slug:string, body_sha256:string,
29:  *     status:string, explanation:string,
30:  *     evidence_slug?:string, successor_slug?:string, assessed_at:string }
31:  *
33:  * ------------------------------------------------
34:  *   - same source only: a companion page in a DIFFERENT source than the atom is
35:  *     never consulted (source_id isolation);
36:  *   - visibility only: the companion page (and any referenced slug) must be a
37:  *     live, non-deleted, non-quarantined page — plus non-private when the caller
38:  *     is untrusted (`excludePrivate`);
39:  *   - exact binding: a record only counts when atom_id, atom_slug, source_id,
40:  *     frozen_source_hash, frozen_source_slug AND body_sha256 ALL match the live
41:  *     atom row exactly;
42:  *   - absent / malformed / conflicting / stale markers FAIL CLOSED: no trusted
43:  *     status is emitted, only a warning disposition (`status: 'untrusted'`);
44:  *   - references are sanitized: only well-formed canonical slugs that resolve to
45:  *     a live, visible page in the SAME source are exposed — never a local
46:  *     filesystem path, a `~`/absolute path, or a private evidence path.
65: export type AtomDispositionWarningCode =
66:   | 'historical_not_certified'
67:   | 'assessment_stale'
68:   | 'assessment_conflict'
69:   | 'assessment_untrusted';
70:
71: export interface AtomDispositionWarning {
77:  * The top-level enrichment surfaced on an atom search result / get_page. Every
78:  * field is derived from a validated companion record, except `historical`,
79:  * `certified` and `warning` which are always the module's own honest framing.
80:  */
81: export interface AtomDisposition {
82:   /** Verbatim assessment status, or `'untrusted'` for a fail-closed marker. */
88:   /** The canonical companion page slug the record was read from (same source). */
89:   assessment_slug: string;
90:   /** The source_id the disposition is scoped to (== the atom's own source). */
91:   source_id: string;
92:   /** Always true — a historical assessment, not a live certification. */
93:   historical: true;
94:   /** Always false — never a certification of the atom's correctness. */
95:   certified: false;
96:   /** Always present — the honest framing / fail-closed reason. */
97:   warning: AtomDispositionWarning;
98:   /** Safe same-source canonical reference, only when it resolves to a live page. */
99:   evidence_slug?: string;
100:   /** Safe same-source canonical reference, only when it resolves to a live page. */
[additional inspected output omitted here; inspect the frozen file for full context]
430:   for (const r of results) {
431:     if (r.atom_disposition !== undefined) delete r.atom_disposition;
432:   }
442:     const rows = await engine.executeRaw<{
443:       id: number;
444:       source_id: string | null;
445:       slug: string;
446:       ss: string | null;
447:       sh: string | null;
448:       body: string | null;
449:     }>(
450:       `SELECT id, source_id, slug,
451:               frontmatter->>'source_slug' AS ss,
452:               frontmatter->>'source_hash' AS sh,
453:               compiled_truth AS body
454:          FROM pages
455:         WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
464:         id: Number(row.id),
465:         slug: row.slug,
466:         source_id: row.source_id ?? 'default',
467:         source_hash: row.sh,
468:         source_slug: row.ss,
469:         body_sha256: computeAtomBodySha256(row.body ?? ''),
470:       });
471:     }
485:   id: number;
486:   slug: string;
487:   source_id: string;
488:   compiled_truth: string;
489:   frontmatter: Record<string, unknown> | null | undefined;
490: }
494:  * handling has resolved the final readable page. Never throws.
495:  */
496: export async function loadAtomDispositionForPage(
497:   engine: BrainEngine,
498:   page: AtomDispositionPage,
499:   opts: LoadAtomDispositionsOptions = {},
503:     id: page.id,
504:     slug: page.slug,
505:     source_id: page.source_id,
506:     source_hash: typeof fm.source_hash === 'string' ? fm.source_hash : null,
507:     source_slug: typeof fm.source_slug === 'string' ? fm.source_slug : null,
508:     body_sha256: computeAtomBodySha256(page.compiled_truth ?? ''),
509:   };
510:   try {
```

### E:official-atom-selection

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/cycle/extract-atoms.ts`

Observed selected output:

```text
394: export async function discoverExtractablePages(
395:   engine: BrainEngine,
396:   sourceId: string,
397:   affectedSlugs?: string[],
398:   limit: number = PAGE_DISCOVERY_BUDGET,
399: ): Promise<AtomPageInput[]> {
400:   const hasFilter = Array.isArray(affectedSlugs) && affectedSlugs.length > 0;
401:   const connectorExclusion = await connectorAtomExclusionSql(engine);
402:   const sql = `
403:     SELECT p.id, p.knowledge_revision,
404:            (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
405:            p.slug,
406:            p.compiled_truth,
407:            p.content_hash
408:     FROM pages p
409:     WHERE p.source_id = $1
410:       AND p.type = ANY($2::text[])
411:       AND p.deleted_at IS NULL
412:       AND p.content_hash IS NOT NULL
413:       AND COALESCE(p.frontmatter->>'imported_from',   '') <> 'markdown-greenfield'
414:       AND COALESCE(p.frontmatter->>'dream_generated', '') <> 'true'
415:       ${RAW_SOURCE_HOLDER_EXCLUSION_SQL}
416:       AND ${minCompiledTruthChars('$3')}
417:       ${MANAGED_ATOM_DISCOVERY_SQL}
418:       ${PAGE_SCAN_STATE_EXCLUSION_SQL}
419:       ${connectorExclusion}
420:       ${hasFilter ? "AND p.slug = ANY($5::text[])" : ''}
421:       AND NOT EXISTS (
422:         SELECT 1
423:         FROM pages atom
424:         WHERE atom.type = 'atom'
425:           AND atom.source_id = $1
426:           AND atom.frontmatter->>'source_hash' = substring(p.content_hash from 1 for 16)
427:           AND COALESCE(atom.frontmatter->>'managed_extraction', '') <> 'true'
428:           AND atom.deleted_at IS NULL
429:       )
430:     ORDER BY p.updated_at DESC
431:     LIMIT $4
432:   `;
433:   const params: unknown[] = [
434:     sourceId,
435:     await resolveExtractableTypes(),
436:     MIN_PAGE_CHARS_FOR_EXTRACTION,
437:     limit,
438:   ];
439:   if (hasFilter) params.push(affectedSlugs);
440:
441:   try {
442:     const rows = await engine.executeRaw<{
443:       id: number;
444:       knowledge_revision: string;
445:       source_incarnation: string;
446:       slug: string;
447:       compiled_truth: string;
448:       content_hash: string;
449:     }>(sql, params);
450:     return rows.map((r) => ({
451:       slug: r.slug,
452:       content: r.compiled_truth,
453:       contentHash: r.content_hash,
454:       identity: { pageId: r.id, sourceIncarnation: r.source_incarnation, revision: r.knowledge_revision },
455:     }));
456:   } catch (err) {
457:     const msg = err instanceof Error ? err.message : String(err);
458:     console.error(`[extract_atoms] page-discovery query failed: ${msg}`);
459:     return []; // fail-soft: transcript path still proceeds
460:   }
```

### E:official-atom-provenance

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/commands/doctor/checks/extraction-sync.ts`

Observed selected output:

```text
849: export async function computeAtomProvenanceDriftCheck(
850:   engine: BrainEngine,
851: ): Promise<Check> {
852:   const name = 'atom_provenance_drift';
853:   // Both must trip: the ratio alone flaps on brains with a handful of atoms,
854:   // and the count alone fires on large healthy brains mid-cycle.
855:   const MIN_DRIFTED = 25;
856:   const WARN_RATIO = 0.1;
857:   try {
858:     const rows = await engine.executeRaw<{
859:       total: string | number; slug_unbound: string | number; drifted: string | number;
860:       source_changed: string | number; source_gone: string | number;
861:       oldest_ext: string | null;
862:     }>(
863:       // extracted_at stays TEXT end to end (review fix): an unguarded
864:       // ::timestamptz cast let ONE malformed frontmatter value (hand edit,
865:       // truncation) abort the whole aggregate and permanently degrade this
866:       // check to a spurious "check failed" warn. The ISO-shape regex drops
867:       // garbage from the min(); the age math happens in TS where Date
868:       // parsing can never throw (semantically-invalid dates become NaN →
869:       // metric omitted, verdict untouched).
870:       `WITH atom AS (
871:          SELECT a.source_id,
872:                 -- managed atoms keep their provisional prefix for good (#5770)
873:                 CASE WHEN a.frontmatter->>'managed_extraction' = 'true'
874:                      THEN regexp_replace(a.frontmatter->>'source_hash', '^pending:', '')
875:                      ELSE a.frontmatter->>'source_hash' END AS sh,
876:                 -- NULL = slug-unbound: transcript-minted (source_path only) or
877:                 -- pre-binding-era. \`ss IS NULL\` is THE predicate for that
878:                 -- population everywhere below (#4799 / #4806).
879:                 NULLIF(a.frontmatter->>'source_slug', '') AS ss,
880:                 CASE WHEN a.frontmatter->>'extracted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
881:                      THEN a.frontmatter->>'extracted_at' END AS ext
882:            FROM pages a
883:           WHERE a.type = 'atom'
884:             AND a.deleted_at IS NULL
885:             AND a.frontmatter->>'source_hash' IS NOT NULL
886:             -- in-flight marker written before an unmanaged extraction commits
887:             AND (a.frontmatter->>'source_hash' NOT LIKE 'pending:%' OR a.frontmatter->>'managed_extraction' = 'true')
888:        -- Lookup sets are built ONCE and joined (#4937). A correlated EXISTS in
889:        -- the SELECT list is not rewritten to a semi-join — Postgres re-runs it
890:        -- per atom over substring(content_hash), which no index serves, so the
891:        -- check went O(atoms x same-source pages) and blew health-check budgets.
892:        -- DISTINCT is load-bearing: duplicate live content_hash values are a
893:        -- real state and would otherwise fan one atom out into several rows.
894:        ), live_hashes AS MATERIALIZED (
895:          SELECT DISTINCT source_id, substring(content_hash from 1 for 16) AS sh
896:            FROM pages WHERE deleted_at IS NULL AND content_hash IS NOT NULL
897:        ), live_slugs AS MATERIALIZED (
898:          SELECT DISTINCT source_id, slug FROM pages WHERE deleted_at IS NULL
899:        ), drift AS (
900:          SELECT atom.*,
901:                 -- a slug-unbound atom is never drift: its hash is over a file,
902:                 -- not a page, so the page probe is meaningless (#4806)
903:                 (atom.ss IS NOT NULL AND h.sh IS NULL) AS drifted,
904:                 (s.slug IS NOT NULL) AS src_alive
905:            FROM atom
906:            LEFT JOIN live_hashes h ON h.source_id = atom.source_id AND h.sh = atom.sh
907:            LEFT JOIN live_slugs  s ON s.source_id = atom.source_id AND s.slug = atom.ss
908:        )
909:        SELECT count(*) FILTER (WHERE ss IS NOT NULL) AS total,
910:               count(*) FILTER (WHERE ss IS NULL) AS slug_unbound,
911:               count(*) FILTER (WHERE drifted) AS drifted,
912:               count(*) FILTER (WHERE drifted AND src_alive) AS source_changed,
913:               -- drifted implies a slug binding, so "gone" is always a binding
914:               -- that failed to resolve — never a slug-unbound atom (#4799)
915:               count(*) FILTER (WHERE drifted AND NOT src_alive) AS source_gone,
916:               -- lexicographic min of ISO-shaped strings ≈ chronological min
917:               -- (oldest); informational only, never verdict-bearing
918:               min(ext) FILTER (WHERE drifted) AS oldest_ext
919:          FROM drift`,
920:       [],
921:     );
922:     const r = rows?.[0];
923:     if (!r) return { name, status: 'warn', message: 'atom provenance query returned no rows', details: { health: 'unknown' } };
924:
925:     const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));
926:     const total = num(r.total);
927:     const slugUnbound = num(r.slug_unbound);
928:     const drifted = num(r.drifted);
929:     const sourceChanged = num(r.source_changed);
930:     const sourceGone = num(r.source_gone);
931:     const oldestExtMs = r.oldest_ext ? new Date(String(r.oldest_ext)).getTime() : NaN;
932:     const oldestDays = Number.isFinite(oldestExtMs)
933:       ? Math.round(((Date.now() - oldestExtMs) / 86_400_000) * 10) / 10
934:       : null;
935:     const ratio = total > 0 ? drifted / total : 0;
936:     const details = {
937:       total_atoms: total,
938:       slug_unbound: slugUnbound,
939:       drifted,
940:       source_changed: sourceChanged,
941:       source_gone: sourceGone,
942:       drift_pct: total > 0 ? Math.round(ratio * 1000) / 10 : 0,
943:       oldest_drifted_days: oldestDays ?? undefined,
944:     };
945:
946:     // Slug-unbound atoms cannot be page-checked; say so instead of hiding them.
947:     const su = slugUnbound > 0
948:       ? `; ${slugUnbound} slug-unbound atom(s) (no source_slug: transcript-minted source_path-only, or pre-binding-era) are file-bound and not page-checked`
949:       : '';
950:     if (total === 0) {
951:       return { name, status: 'ok', message: (slugUnbound > 0 ? 'no page-bound atoms to check' : 'no atoms to check') + su, details };
952:     }
953:     if (drifted === 0) return { name, status: 'ok', message: `${total} atom(s), all provenance-resolved${su}`, details };
954:
955:     if (drifted >= MIN_DRIFTED && ratio > WARN_RATIO) {
```

### E:official-prefix-budget

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/multi-source-drift.ts`

Observed selected output:

```text
213:  * The path prefix sync put in front of a walked file's `local_path`-relative
214:  * path before slugging it: '' unless the source is pinned to 'git-root', and
215:  * then `local_path`'s location in its git work tree as git reports it
216:  * (`rev-parse --show-prefix`: '' at the toplevel, 'sub/dir/' below it, with
217:  * symlinks resolved, the scope managed sync derives). null when git cannot
218:  * place `local_path` in a work tree.
219:  */
220: async function syncedPathPrefix(engine: BrainEngine, src: SourceWithPath): Promise<string | null> {
221:   if (await readSlugRootMode(engine, src.id) !== 'git-root') return '';
222:   try {
223:     return git(src.local_path, ['rev-parse', '--show-prefix'], [], 30_000, { silenceStderr: true });
224:   } catch {
225:     return null;
226:   }
227: }
228:
229: /**
230:  * Find pages that appear misrouted from intended source X to source 'default'.
231:  * For each non-default source with a configured local_path, walk the
232:  * filesystem and cross-check against the DB.
233:  *
234:  * @returns aggregated MisroutedResult across all checked sources. The sample
235:  *          array is bounded at 5 entries so the doctor message stays scannable.
236:  */
237: export async function findMisroutedPages(
238:   engine: BrainEngine,
239:   sources: SourceWithPath[],
240:   opts: { limit?: number; timeoutMs?: number } = {},
241: ): Promise<MisroutedResult> {
242:   const limit = opts.limit ?? positiveIntEnv('GBRAIN_DRIFT_LIMIT') ?? DEFAULT_FILE_LIMIT;
243:   const timeoutMs = opts.timeoutMs ?? positiveIntEnv('GBRAIN_DRIFT_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
244:   const deadlineMs = Date.now() + timeoutMs;
245:
246:   let totalCount = 0;
247:   let walkTruncated = false;
248:   const sample: MisroutedSample[] = [];
249:   const gitRootSkipped: string[] = [];
250:   const unreadable: MisroutedResult['unreadable_sources'] = [];
251:
252:   for (const src of sources) {
253:     if (src.id === 'default') continue;
254:     if (!src.local_path) continue;
255:     if (Date.now() >= deadlineMs) {
256:       walkTruncated = true;
257:       break;
258:     }
259:     const { files, truncated, rootUnreadable, unreadableDirs } = walkMarkdownAndMdxFiles(src.local_path, limit, deadlineMs);
260:     if (truncated) walkTruncated = true;
261:     if (rootUnreadable) unreadable.push({ source_id: src.id, reason: 'root_unreadable', dirs: 1 });
262:     else if (unreadableDirs > 0) unreadable.push({ source_id: src.id, reason: 'subdirs_unreadable', dirs: unreadableDirs });
263:     if (files.length === 0) continue;
264:
265:     // Asked only once the walk found files, so a missing local_path stays
266:     // root_unreadable instead of reading as a git-root skip.
267:     const prefix = await syncedPathPrefix(engine, src);
268:     if (prefix === null) {
269:       gitRootSkipped.push(src.id);
270:       continue;
271:     }
272:
273:     // Convert FS paths to canonical slugs (lowercased, extension stripped).
274:     const slugs = Array.from(new Set(files.map(f => pathToSlug(prefix + f.relPath))));
275:     const existenceMap = await batchProbeExistence(engine, slugs, src.id);
276:
277:     for (const slug of slugs) {
278:       const present = existenceMap.get(slug);
279:       if (!present) continue; // missing both — uningested, not misroute
280:       const hasDefault = present.has('default');
281:       const hasSource = present.has(src.id);
282:       // The misroute heuristic: present at default, missing from intended source.
283:       if (hasDefault && !hasSource) {
284:         totalCount++;
285:         if (sample.length < SAMPLE_LIMIT) {
286:           sample.push({ slug, intended_source: src.id, local_path: src.local_path });
287:         }
288:       }
289:     }
290:   }
291:
292:   return {
293:     walk_truncated: walkTruncated, count: totalCount, sample, git_root_skipped: gitRootSkipped,
294:     unreadable_sources: unreadable, limit, timeout_ms: timeoutMs,
295:   };
```

### E:official-drift-verdict

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/commands/doctor/schema-pack-checks.ts`

Observed selected output:

```text
265: export function multiSourceDriftCheck(
266:   result: MisroutedResult,
267:   candidateSources: number,
268:   host: 'local' | 'remote',
269:   managed = false,
270: ): Check {
271:   const details = {
272:     walk_truncated: result.walk_truncated,
273:     unreadable_sources: result.unreadable_sources,
274:     git_root_skipped: result.git_root_skipped,
275:     limit: result.limit,
276:     timeout_ms: result.timeout_ms,
277:     docs: DRIFT_DOCS,
278:   };
279:   const skipNote = result.git_root_skipped.length > 0 ? multiSourceDriftGitRootSkipNote(result.git_root_skipped) : '';
280:   const unreadable = result.unreadable_sources;
281:   const unreadableNote = unreadable.length > 0
282:     ? ` Not verified for ${unreadable.length} source(s) whose local_path could not be read: ` +
283:       unreadable.map((u) => `${u.source_id} (${u.reason === 'root_unreadable' ? 'root unreadable' : `${u.dirs} unreadable dir(s)`})`).join(', ') +
284:       `. Fix the path or permissions (\`gbrain sources status\`), then re-run \`gbrain doctor\`.`
285:     : '';
286:   if (result.walk_truncated) {
287:     return {
288:       name: 'multi_source_drift',
289:       status: 'warn',
290:       message:
291:         `Multi-source drift not verified — the FS walk hit its bound (${result.limit} files / ${result.timeout_ms} ms)` +
292:         (host === 'remote' ? ' on the brain server' : '') +
293:         `. Re-run with a larger bound: \`GBRAIN_DRIFT_LIMIT=<files> GBRAIN_DRIFT_TIMEOUT_MS=<ms> gbrain doctor\`.` +
294:         unreadableNote,
295:       details: { ...details, code: 'not_verified', verified: false },
296:     };
297:   }
298:   if (result.count > 0) {
299:     const sampleStr = result.sample.map((s) => `${s.slug} (intended=${s.intended_source})`).join(', ');
300:     const advice = host === 'local'
301:       ? multiSourceDriftAdvice(result.count, sampleStr, managed)
302:       : `${result.count} page slug(s) appear at 'default' but NOT at the intended source ` +
303:         `(e.g., ${sampleStr}). Likely pre-v0.30.3 misroutes OR an incomplete initial sync. ` +
304:         `Verify on the brain host: \`gbrain sources status\` then \`gbrain sync --source <id>${managed ? ' --no-pull' : ''} --full\`.`;
305:     return { name: 'multi_source_drift', status: 'warn', message: advice + skipNote + unreadableNote, details: { ...details, code: 'drift_detected' } };
306:   }
307:   if (unreadable.length > 0) {
308:     return {
309:       name: 'multi_source_drift',
310:       status: 'warn',
311:       message: `No cross-source slug drift among readable sources.${unreadableNote}${skipNote}`,
312:       details: { ...details, code: 'not_verified', verified: false },
313:     };
314:   }
315:   if (result.git_root_skipped.length === 0) {
316:     return { name: 'multi_source_drift', status: 'ok', message: 'No cross-source slug drift detected.', details };
317:   }
318:   // Skipped sources were never compared, so this cannot be "no drift" even
319:   // when every checked sibling was clean.
320:   const lead = result.git_root_skipped.length >= candidateSources
321:     ? 'Multi-source drift check performed no verification'
322:     : 'No cross-source slug drift among checked sources.';
323:   return { name: 'multi_source_drift', status: 'warn', message: lead + skipNote, details: { ...details, code: 'not_verified', verified: false } };
324: }
325:
326: /** #5432: the drift check itself failed (e.g. the sources query); report it instead of dropping the check. */
327: export function multiSourceDriftNotVerified(err: unknown): Check {
328:   return { name: 'multi_source_drift', ...notVerified(err, 'gbrain doctor', DRIFT_DOCS) };
329: }
```

### E:local-drift-coverage

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/multi-source-drift.ts`

Observed selected output:

```text
1: /** Read-only Markdown drift heuristic. Incomplete coverage is never verified clean. */
2: import type { BrainEngine } from './engine.ts';
3:
4: import { parseMarkdown } from './markdown.ts';
5: import { validateSlug } from './utils.ts';
13: export interface DriftCoverageIssue {
14:   source_id: string;
15:   reason: 'git_root_unresolved' | 'filesystem' | 'identity' | 'database' | 'deadline' | 'limit' | 'configuration' | 'unsupported_strategy';
16: }
17: export interface MisroutedResult {
18:   walk_truncated: boolean;
19:   count: number;
23:   checked_sources: string[];
24:   candidates_checked: number;
25:   coverage_issues: DriftCoverageIssue[];
26: }
27: const DEFAULT_FILE_LIMIT = 10_000;
28: const DEFAULT_TIMEOUT_MS = 5_000;
29: const BATCH_SIZE = 250;
48: }
49:
50: /** Active source_path identities, source-scoped and ambiguity-detecting (no first-row wins). */
51: async function storedIdentities(engine: BrainEngine, paths: string[], sourceId: string): Promise<Map<string, string>> {
52:   const rows = await engine.executeRaw<{ source_path: string; source_id: string; slug: string }>(`
53:     SELECT source_path, source_id, slug FROM pages
54:     WHERE deleted_at IS NULL AND source_id IN ('default', $2::text)
55:       AND source_path = ANY($1::text[])`, [paths, sourceId]);
56:   const map = new Map<string, string>();
57:   for (const row of rows) {
58:     const key = `${row.source_id}\0${row.source_path}`;
59:     const previous = map.get(key);
60:     if (previous && previous !== row.slug) throw new Error('Ambiguous stored source path');
61:     map.set(key, row.slug);
62:   }
70:   const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
71:   const result: MisroutedResult = { walk_truncated: false, count: 0, sample: [], git_root_skipped: [],
72:     verification_complete: true, checked_sources: [], candidates_checked: 0, coverage_issues: [] };
73:   const eligible = sources.filter(source => source.id !== 'default' && source.local_path);
74:   const issue = (source_id: string, reason: DriftCoverageIssue['reason']) => {
75:     result.verification_complete = false;
76:     if (!result.coverage_issues.some(i => i.source_id === source_id && i.reason === reason)) result.coverage_issues.push({ source_id, reason });
77:     if (reason === 'deadline' || reason === 'limit') result.walk_truncated = true;
78:   };
79:   if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
80:     for (const src of eligible) issue(src.id, 'configuration');
93:   let visited = 0;
94:   for (const src of eligible) {
95:     const initialIssues = result.coverage_issues.length;
96:     if (Date.now() >= deadline) { issue(src.id, 'deadline'); continue; }
97:     if (visited >= limit) { issue(src.id, 'limit'); continue; }
98:     let phase: DriftCoverageIssue['reason'] = 'configuration';
99:     try {
119:           }
120:           if (error instanceof DriftDeadlineError || Date.now() >= deadline) throw new DriftDeadlineError();
121:           // An unpinned non-Git import uses source-root identity, just like sync.
122:         }
123:         if (!mode && scope.pathPrefix) mode = await beforeDriftDeadline(deadline, () => resolveSlugRootMode(engine,
124:           { sourceId: src.id, explicitGitRoot: false, slugPrefix: scope.slugPrefix, dryRun: true }));
125:       }
139:         for (let i = 0; i < files.length; i++) {
140:           if (Date.now() >= deadline) throw new DriftDeadlineError();
141:           phase = 'identity';
142:           // Match import admission, including normalization-equivalent restored keys.
143:           const parsed = parseMarkdown(files[i].content, paths[i], { validate: true });
144:           const selected = resolveImportedMarkdownSlug(paths[i], parsed);
145:           if (selected.error) { issue(src.id, 'identity'); continue; }
146:           const intended = identities.get(`${src.id}\0${paths[i]}`);
147:           const atDefault = identities.get(`default\0${paths[i]}`);
148:           // Both engines canonicalize writes through validateSlug after import selection.
149:           const slug = intended ?? atDefault ?? validateSlug(selected.slug);
150:           if (!slug) { issue(src.id, 'identity'); continue; }
151:           const previousPath = seen.get(slug);
152:           if (previousPath && previousPath !== paths[i]) { issue(src.id, 'identity'); continue; }
153:           if (!previousPath) { seen.set(slug, paths[i]); candidates.push(slug); }
154:         }
155:         phase = 'database';
156:         const existence = await beforeDriftDeadline(deadline, () => batchProbeExistence(engine, candidates, src.id));
164:         }
165:       }
166:       if (result.coverage_issues.length === initialIssues) result.checked_sources.push(src.id);
167:     } catch (error) { issue(src.id, error instanceof DriftDeadlineError ? 'deadline' : phase); }
168:   }
169:   return result;
170: }
```

### E:local-drift-walk

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/multi-source-drift-walk.ts`

Observed selected output:

```text
10:
11: export class DriftDeadlineError extends Error {
12:   constructor() { super('Multi-source drift verification deadline exceeded'); }
13: }
14:
15: /** Bounds the verifier's wait, NOT cancellation of an engine's in-flight read. */
16: export async function beforeDriftDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
17:   const remaining = deadline - Date.now();
18:   if (remaining <= 0) throw new DriftDeadlineError();
19:   let timer: ReturnType<typeof setTimeout> | undefined;
20:   try {
28: export interface DriftGitScope { slugPrefix: string; pathPrefix: string }
29: const executeFile = promisify(execFile);
30: export async function resolveDriftGitScope(localPath: string, deadline: number): Promise<DriftGitScope> {
31:   return beforeDriftDeadline(deadline, async () => {
32:     const scopeRoot = await realpath(localPath);
33:     const { stdout } = await executeFile('git', ['rev-parse', '--show-toplevel'], {
34:       cwd: scopeRoot, timeout: Math.max(1, Math.min(30_000, deadline - Date.now())), encoding: 'utf8',
35:     });
36:     const gitRoot = await realpath(stdout.trim());
37:     const pathPrefix = gitRelativePath(gitRoot, scopeRoot);
50:
51: /** Same persistent sync classifiers; filesystem/read errors are coverage failures. */
52: export async function walkDriftMarkdown(
53:   root: string, limit: number, deadline: number, opts: DriftSyncOptions,
54: ): Promise<DriftWalkResult> {
55:   const result: DriftWalkResult = { files: [], truncated: false, errors: 0 };
56:   async function walk(dir: string): Promise<void> {
57:     if (result.truncated) return;
58:     const entries = await beforeDriftDeadline(deadline, () => readdir(dir, { withFileTypes: true }));
59:     entries.sort((a, b) => a.name.localeCompare(b.name));
60:     for (const entry of entries) {
61:       if (Date.now() >= deadline) throw new DriftDeadlineError();
62:       const path = join(dir, entry.name);
63:       const relPath = relative(root, path).split(sep).join('/');
64:       if (entry.isSymbolicLink()) continue; // importer refuses symlinks too
65:       if (entry.isDirectory()) {
66:         if (isPathPruned(relPath, ['**'])) continue; // dot waiver cannot admit vendored/raw directories
67:         if (!opts.includeHidden?.length && isPathPruned(relPath)) continue;
68:         try { await walk(path); }
69:         catch (error) { if (error instanceof DriftDeadlineError) throw error; result.errors++; }
74:         try {
75:           // Open once, refuse a raced symlink and inspect the actual open file.
76:           // Close a late-opened handle even when the outer deadline already won.
77:           const handle = await beforeDriftDeadline(deadline, async () => {
78:             const opened = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
79:             if (Date.now() >= deadline) { await opened.close(); throw new DriftDeadlineError(); }
80:             return opened;
81:           });
82:           try {
83:             const stat = await beforeDriftDeadline(deadline, () => handle.stat());
84:             if (!stat.isFile() || stat.size > 5_000_000) { result.errors++; continue; }
85:             const content = await beforeDriftDeadline(deadline, () => handle.readFile('utf8'));
86:             result.files.push({ relPath, content: content.replace(/^\uFEFF/, '') });
87:           } finally { await handle.close(); }
88:         } catch (error) { if (error instanceof DriftDeadlineError) throw error; result.errors++; }
```

### E:local-drift-verdict

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/commands/doctor/multi-source-drift-check.ts`

Observed selected output:

```text
1: import type { BrainEngine } from '../../core/engine.ts';
2: import { findMisroutedPages, type MisroutedResult, type SourceWithPath } from '../../core/multi-source-drift.ts';
3: import { beforeDriftDeadline } from '../../core/multi-source-drift-walk.ts';
4: import type { Check } from '../doctor.ts';
5: import { multiSourceDriftAdvice } from './schema-pack-checks.ts';
6:
7: /** One renderer for local CLI and scoped server doctor: unknown is never OK. */
8: export function multiSourceDriftCheck(result: MisroutedResult, remote = false): Check {
9:   const coverage = result.coverage_issues.length
10:     ? ` Verification incomplete; health is unknown for: ${result.coverage_issues.map(issue => `${issue.source_id} (${issue.reason})`).join(', ')}.`
11:     : '';
12:   const evidence = result.count > 0
13:     ? multiSourceDriftAdvice(result.count, result.sample.map(sample => `${sample.slug} (intended=${sample.intended_source})`).join(', '))
14:     : result.verification_complete ? 'No cross-source slug drift detected.'
15:       : 'Multi-source drift check could not verify every eligible source.';
16:   // Read-only evidence and host verification advice, never destructive cleanup.
17:   const host = remote && result.count > 0 ? ' Verify on the brain host.' : '';
18:   return { name: 'multi_source_drift', status: result.count > 0 || !result.verification_complete ? 'warn' : 'ok',
19:     message: `${evidence}${coverage}${host}`,
20:     details: { verification_scope: 'markdown', verification_complete: result.verification_complete,
21:       checked_sources: result.checked_sources, candidates_checked: result.candidates_checked, coverage_issues: result.coverage_issues } };
22: }
23:
24: export async function checkMultiSourceDrift(
25:   engine: BrainEngine | null,
26:   opts: { sourceIds?: string[]; remote?: boolean; limit?: number; timeoutMs?: number } = {},
27: ): Promise<Check | null> {
28:   const unknown = (message: string): Check => ({ name: 'multi_source_drift', status: 'warn', message });
29:   if (!engine) return unknown('Multi-source drift verification unavailable: database not connected; health is unknown.');
30:   // A real Readwise tree can require more than five seconds of filesystem IO.
31:   // Keep one bounded deadline, shared by roster reads and the complete walk;
32:   // explicit caller budgets still take precedence and exhaustion remains WARN.
33:   const timeoutMs = opts.timeoutMs ?? 30_000;
34:   const deadline = Date.now() + timeoutMs;
35:   try {
36:     const sources = await beforeDriftDeadline(deadline, () => engine.executeRaw<SourceWithPath>(
37:       `SELECT id, local_path, config FROM sources ${opts.sourceIds ? 'WHERE id = ANY($1::text[])' : ''}`,
38:       opts.sourceIds ? [opts.sourceIds] : undefined));
39:     const eligible = sources.filter(source => source.id !== 'default' && source.local_path);
40:     if (!eligible.length) return null;
41:     // No read outside a scoped caller's grant, including the comparison source.
42:     if (opts.sourceIds && !opts.sourceIds.includes('default')) {
43:       return unknown('Multi-source drift verification unavailable in this source scope; comparison source is not authorized. Health is unknown.');
44:     }
45:     return multiSourceDriftCheck(await findMisroutedPages(engine, eligible,
46:       { limit: opts.limit, timeoutMs: Math.max(0, deadline - Date.now()) }), opts.remote);
47:   } catch {
48:     // Do not echo DB errors: connection strings and excluded source names can be private.
49:     return unknown('Multi-source drift verification failed or timed out; database/coverage state could not be read. Health is unknown.');
50:   }
51: }
```

### E:official-test-test/multi-source-drift.test.ts

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:test/multi-source-drift.test.ts`

Observed selected output:

```text
16:  *   5. FS walk hits limit → status `warn 'check skipped, walk too large'`.
17:  *
18:  * #5862: sources pinned to git-root slugs are compared using the prefix git
19:  * reports for local_path inside its work tree (empty at the toplevel), and a
20:  * source git cannot place keeps the doctor verdict at "not verified".
21:  */
22:
23: import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
24: import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
68:     expect(result.count).toBe(0);
69:     expect(result.sample).toEqual([]);
70:     expect(result.walk_truncated).toBe(false);
71:   });
72:
73:   test('case 2: multi-source brain, no misroutes → count=0', async () => {
74:     const root = makeTmpRoot('case2');
140:   });
141:
142:   test('case 5: FS walk hits limit → walk_truncated=true', async () => {
143:     const root = makeTmpRoot('case5');
144:     // Seed 12 files with a limit of 5 to force truncation.
145:     for (let i = 0; i < 12; i++) {
146:       seedFile(root, `topics/file-${i}.md`);
147:     }
148:
151:       timeoutMs: 5000,
152:     });
153:     expect(result.walk_truncated).toBe(true);
154:   });
155:
156:   test('case 6 (OV13): unreadable local_path does NOT crash; returns empty', async () => {
157:     const result = await findMisroutedPages(engine, [
158:       { id: 'src-fake', local_path: '/nonexistent/path/that/does/not/exist' },
159:     ]);
160:     // Walk silently returns zero files; count=0, NOT throw.
161:     expect(result.count).toBe(0);
162:     expect(result.walk_truncated).toBe(false);
163:   });
164:
165:   test('case 7 (OV13): .mdx files are walked alongside .md', async () => {
166:     const root = makeTmpRoot('case7');
180:   });
181:
182:   test('case 8 (#4712): a git-root-pinned source is skipped, not false-positived', async () => {
183:     const root = makeTmpRoot('case8');
184:     seedFile(root, 'page.md');
185:
186:     await runSources(engine, ['add', 'src-case8', '--no-federated']);
189:       [root, 'src-case8'],
190:     );
191:     await writeSlugRootMode(engine, 'src-case8', 'git-root');
192:     // Sync actually produced the git-root-prefixed slug (what import.ts's
193:     // importRelPath would derive) — NOT local_path-relative 'page'.
194:     await engine.putPage('src-case8/page', { type: 'concept', title: 'p', compiled_truth: '.' }, { sourceId: 'src-case8' });
195:     // An unrelated page legitimately owns the local_path-relative slug at
[additional inspected output omitted here; inspect the frozen file for full context]
285:     symlinkSync(real, link);
286:     await registerSource('src-gr-link', link, 'git-root');
287:     await seedPair('src-gr-link', link, 'shared/', 'grlink');
288:
289:     const result = await findMisroutedPages(engine, [{ id: 'src-gr-link', local_path: link }]);
290:     expect(result.git_root_skipped).toEqual([]);
291:     expect(result.sample).toEqual([{ slug: 'shared/grlink/lost', intended_source: 'src-gr-link', local_path: link }]);
292:   });
293:
294:   test('control: a source-root source in a subdirectory keeps local_path-relative slugs', async () => {
301:   });
302:
303:   test('a git-root source whose local_path is gone is unreadable, not a git-root skip', async () => {
304:     const gone = join(makeTmpRoot('gr-gone'), 'missing');
305:     await registerSource('src-gr-gone', gone, 'git-root');
306:
307:     const result = await findMisroutedPages(engine, [{ id: 'src-gr-gone', local_path: gone }]);
308:     expect(result.git_root_skipped).toEqual([]);
309:     expect(result.unreadable_sources).toEqual([{ source_id: 'src-gr-gone', reason: 'root_unreadable', dirs: 1 }]);
310:   });
311: });
312:
313: describe('multiSourceDriftCheck — skipped git-root sources (#5862)', () => {
314:   const clean = { walk_truncated: false, count: 0, sample: [], unreadable_sources: [], limit: 10_000, timeout_ms: 5_000 };
315:
316:   test('one skipped source beside a clean one is not verified, and says why', () => {
317:     const check = multiSourceDriftCheck({ ...clean, git_root_skipped: ['src-outside-git'] }, 2, 'local');
318:     expect(check.status).toBe('warn');
319:     expect(check.details).toMatchObject({ code: 'not_verified', verified: false, git_root_skipped: ['src-outside-git'] });
320:     expect(check.message).toStartWith('No cross-source slug drift among checked sources.');
321:     expect(check.message).toContain('src-outside-git');
322:     expect(check.message).toContain('work tree');
323:     expect(check.message).not.toContain('#4712');
325:
326:   test('every candidate skipped means no verification at all', () => {
327:     const check = multiSourceDriftCheck({ ...clean, git_root_skipped: ['a', 'b'] }, 2, 'remote');
328:     expect(check.status).toBe('warn');
329:     expect(check.message).toStartWith('Multi-source drift check performed no verification');
330:   });
331:
332:   test('control: nothing skipped and nothing found is ok', () => {
333:     const check = multiSourceDriftCheck({ ...clean, git_root_skipped: [] }, 2, 'local');
334:     expect(check).toMatchObject({ status: 'ok', message: 'No cross-source slug drift detected.' });
335:   });
336: });
```

### E:official-mention-body

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/commands/extract.ts`

Observed selected output:

```text
2465:   // page keys to checkpoint SECOND, persist THIRD. A crash between
2466:   // batch.push() and flushBatch() leaves pendingForFlush uncommitted —
2467:   // resume re-scans those pages instead of silently losing their links.
2468:   //
2469:   // Persist cadence: every 1000 items OR every 30s, whichever first
2470:   // (~322 persists on a 322K-page brain, ~24s total overhead). Crash
2471:   // window is at most 1000 pages (<0.3% loss on the driver brain).
2472:   const PERSIST_EVERY_N = 1000;
2473:   const PERSIST_EVERY_MS = 30_000;
2474:   const pendingForFlush: string[] = [];
2475:   let sinceLastPersistMs = Date.now();
2476:   let unpersistedCount = 0;
2477:
2478:   async function flushAndCheckpoint(force = false): Promise<void> {
2479:     await flushBatch();
2480:     for (const key of pendingForFlush) completed.add(key);
2481:     pendingForFlush.length = 0;
2482:     if (dryRun) return;
2483:     const now = Date.now();
2484:     if (force || unpersistedCount >= PERSIST_EVERY_N || (now - sinceLastPersistMs) >= PERSIST_EVERY_MS) {
2485:       await recordCompleted(engine, ckptKey, [...completed]);
2486:       unpersistedCount = 0;
2487:       sinceLastPersistMs = now;
2488:     }
2489:   }
2490:
2491:   for (const { slug, source_id } of remaining) {
2492:     const page = await engine.getPage(slug, { sourceId: source_id });
2493:     // v0.41.19.0 (T5 — codex fix #4): even when we skip a page (filter
2494:     // miss, missing row, empty body, no mentions), MARK IT COMPLETED so
2495:     // resume doesn't re-fetch it. The decision NOT to create links is
2496:     // itself a completed decision. (#4304: the --since filter moved to the
2497:     // ref level above — out-of-window pages never reach this loop.)
2498:     const key = `${source_id}::${slug}`;
2499:     if (!page || isQuarantined(page.frontmatter) || (typeFilter && page.type !== typeFilter)) {
2500:       pendingForFlush.push(key);
2501:       unpersistedCount++;
2502:       continue;
2503:     }
2504:     processed++;
2505:     progress.tick();
2506:
2507:     // D3: scan both columns joined with a paragraph separator so an
2508:     // end-of-compiled token doesn't accidentally merge with a
2509:     // start-of-timeline token into a false phrase match.
2510:     const body = (page.title ?? '') + '\n\n' + page.compiled_truth + '\n\n' + (page.timeline ?? '');
2511:     const mentions = body.trim()
2512:       ? findMentionedEntities(body, gazetteer, {
2513:           fromSlug: slug,
2514:           fromSourceId: source_id,
2515:           allowCrossSource,
```

### E:local-cost-policy

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/cycle/extract-atoms-cost-gate.ts`

Observed selected output:

```text
40:  * cap to be enforceable: the extraction chat model AND the embedding model the
41:  * atom import path calls (pass `null` when embedding is unavailable, in which
42:  * case the import runs with `noEmbed` and nothing embeds). Operator
43:  * `pricing.overrides` are consulted first, matching BudgetTracker.reserve().
44:  *
45:  * A model is acceptable when it is PRICED (shipped pricing table or an
46:  * operator override) OR FORMALLY ZERO-COST — local-inference providers
47:  * (`ollama:*`, `llama-server:*`, `lmstudio:*` for embeds) that
48:  * `isModelPriceable` resolves to a $0 row because they bill electricity, not
49:  * tokens. Anything else is unpriced: the gate returns `blocked: true` and the
50:  * phase refuses to run (zero model calls) instead of dropping the cap and
51:  * running uncapped.
52:  *
53:  * There is deliberately NO "the operator set a budget_usd so it must be fine"
54:  * exception. A `cycle.extract_atoms.budget_usd` ceiling on the CHAT model does
55:  * NOT bound an unpriced embedding route: pricing an unpriced route at $0 makes
56:  * the tracker blind to real embed spend (e.g. a Voyage embed model absent from
57:  * the shipped table), so `totalSpent` under-reports and the dollar cap silently
58:  * stops being a total-cost cap. An unpriced embed blocks EVEN WHEN an explicit
59:  * chat budget is set. To run the route, declare its rate via
60:  * `pricing.overrides` (0 only for something that genuinely costs nothing).
61:  */
62: export function resolveExtractAtomsCostGate(
63:   extractModel: string,
64:   embedModel: string | null,
65:   overrides?: PricingOverrides,
66: ): ExtractAtomsCostGate {
67:   if (!isModelPriceable(extractModel, 'chat', overrides)) {
68:     return {
69:       enforceCap: false,
70:       blocked: true,
71:       blockReason: 'unpriced_chat',
72:       unpricedModel: extractModel,
73:       unpricedKind: 'chat',
74:     };
75:   }
76:   if (embedModel !== null && !isModelPriceable(embedModel, 'embed', overrides)) {
77:     return {
78:       enforceCap: false,
79:       blocked: true,
80:       blockReason: 'unpriced_embed',
81:       unpricedModel: embedModel,
82:       unpricedKind: 'embed',
83:     };
84:   }
85:   return { enforceCap: true };
86: }
87:
88: /**
89:  * The embedding model the atom import will bill under this phase's tracker,
90:  * or `null` when embedding is unavailable (the write site then passes
91:  * `noEmbed: true` and no embed call happens). Mirrors the write site's own
92:  * `isAvailable('embedding')` check so the gate and the import agree.
93:  */
94: export function resolveEmbedModelForCostGate(): string | null {
95:   try {
96:     return isAvailable('embedding') ? getEmbeddingModel() : null;
97:   } catch {
98:     return null;
99:   }
100: }
```

### E:official-serial-membership

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:scripts/run-serial-tests.sh`

Observed selected output:

```text
146: # One scheduler owns membership AND heaviest-first dispatch. Bad weights are
147: # advisory; a missing/broken scheduler is an execution error, never an empty run.
148: if [ "${#pool_files[@]}" -gt 0 ]; then
149:   selected=$(printf '%s\n' "${pool_files[@]}" | bun scripts/sharding.ts \
150:     "$shard_n" "$shard_m" --weights scripts/serial-weights.json --fallback-on-error)
151:   pool_files=()
152:   if [ -n "$selected" ]; then
153:     while IFS= read -r f; do pool_files+=("$f"); done <<< "$selected"
154:   fi
155: fi
```

### E:local-serial-membership

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:scripts/run-serial-tests.sh`

Observed selected output:

```text
125: # Membership comes from the deterministic `find` walk above; the scheduler only
126: # decides dispatch ORDER (heaviest first). It is therefore never allowed to
127: # shrink the set: a scheduler that exits non-zero, or that returns anything other
128: # than a permutation of its input (observed: a truncated tail of the
129: # weight-ordered output, which scatters once the list is sorted), falls back to
130: # the deterministic order with a loud warning. Silently running a subset would
131: # drop serial coverage with no failure; refusing outright would drop ALL serial
132: # coverage; the fallback keeps the guarantee the contract test pins.
133: if [ "${#pool_files[@]}" -gt 0 ]; then
134:   scheduled_n=${#pool_files[@]}
135:   scheduler_ok=1
136:   selected=""
137:   if ! selected=$(printf '%s\n' "${pool_files[@]}" | bun scripts/sharding.ts \
138:     "$shard_n" "$shard_m" --weights scripts/serial-weights.json --fallback-on-error); then
139:     scheduler_ok=0
140:     printf '[serial-tests] WARNING: the scheduler failed; using the deterministic dispatch order for %s file(s). Membership is unchanged, so no serial file is skipped.\n' \
141:       "$scheduled_n" >&2
142:   elif [ "$shard_m" -eq 1 ]; then
143:     ordered_n=$(printf '%s\n' "$selected" | wc -l | tr -d ' ')
144:     dropped=$(comm -23 <(printf '%s\n' "${pool_files[@]}" | sort -u) \
145:       <(printf '%s\n' "$selected" | sort -u) || true)
146:     if [ -n "$dropped" ]; then
147:       scheduler_ok=0
148:       printf '[serial-tests] WARNING: the scheduler returned %s of %s file(s) (dropped %s); using the deterministic dispatch order so no serial file is skipped.\n' \
149:         "$ordered_n" "$scheduled_n" "$(printf '%s\n' "$dropped" | grep -c . || true)" >&2
150:     fi
151:   fi
152:   # A trusted scheduler owns membership: an empty result means this shard owns no
153:   # files, so the set MUST be cleared (the empty-shard contract). Only an
154:   # untrusted scheduler keeps the find-based list, which is the only case where
155:   # membership may survive the scheduler unchanged.
156:   if [ "$scheduler_ok" -eq 1 ]; then
157:     pool_files=()
158:     if [ -n "$selected" ]; then
159:       while IFS= read -r f; do pool_files+=("$f"); done <<< "$selected"
160:     fi
161:   fi
162: fi
```

### E:official-exact-quarantine-gap

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/search/exact-lookup.ts`

Observed selected output:

```text
112:   // Slug probe — only for slug-shaped queries (zero cost otherwise).
113:   if (isSlugShapedQuery(q)) {
114:     const scopes: Array<string | undefined> =
115:       opts.sourceIds && opts.sourceIds.length > 0
116:         ? [...opts.sourceIds].sort().slice(0, MAX_SLUG_PROBE_SOURCES)
117:         : opts.sourceId != null
118:           ? [opts.sourceId]
119:           : [undefined];
120:     for (const scope of scopes) {
121:       try {
122:         const page = scope != null
123:           ? await engine.getPage(q, { sourceId: scope, excludePrivate: opts.excludePrivate })
124:           : await engine.getPage(q, { excludePrivate: opts.excludePrivate }); // gbrain-allow-unscoped-getpage — read-only first-match; no paired write
125:         if (!page) continue;
126:         push({
127:           page_id: page.id,
128:           slug: page.slug,
129:           title: page.title,
130:           type: page.type,
131:           source_id: page.source_id ?? scope ?? 'default',
132:           chunk_text: sanitizeRemoteBody(page.compiled_truth ?? '').slice(0, 200),
133:           chunk_index: 0,
134:           chunk_id: 0,
135:           score: 0, // caller assigns the injection score
136:           alias_hit: true, // identity match — evidence alias_hit → 'exists'
137:           exact_lookup: 'slug',
138:         } as SearchResult);
139:       } catch {
140:         // fail-open: slug probe error → no tier hit from this scope
```

### E:official-maintenance-queue

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/commands/autopilot-fanout.ts`

Observed selected output:

```text
739:   const timeoutMs = await resolveGlobalMaintenanceTimeoutMs(engine, opts.timeoutMs);
740:   const job = await queue.add(
741:     'autopilot-global-maintenance',
742:     { repoPath: opts.repoPath, phases: MAINTENANCE_PHASES },
743:     {
744:       queue: 'default',
745:       // Structural single-flight: one global job per slot; maxPending:1
746:       // coalesces any surplus — including across slot rotation while a slow
747:       // brain-wide pass is still in flight — so duplicates never stack.
748:       idempotency_key: `autopilot-global:${opts.slot}`,
749:       max_attempts: 2,
750:       timeout_ms: timeoutMs,
751:       maxPending: 1,
752:     },
```

### E:local-GO-selection

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/ai/gateway.ts`

Observed selected output:

```text
317: export function opencodeGoSessionHeaders(
318:   recipe: Recipe,
319:   cfg: AIGatewayConfig,
320: ): Record<string, string> | undefined {
321:   // Only the two recipes that today run as OpenCode GO lanes.
322:   if (recipe.id !== 'deepseek' && recipe.id !== 'litellm') return undefined;
323:   const baseURL = cfg.base_urls?.[recipe.id] ?? recipe.base_url_default;
324:   if (!baseURL) return undefined;
325:   let host: string;
326:   try {
327:     host = new URL(baseURL).hostname.toLowerCase();
328:   } catch {
329:     return undefined;
330:   }
331:   if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return undefined;
332:   const envSession = cfg.env.OPENCODE_GO_SESSION?.trim();
333:   const session = envSession || `gbrain-go-session:${cfg.env.HOSTNAME ?? 'local'}`;
334:   return { 'x-opencode-session': session };
335: }
```

### E:bootstrap-guard

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:scripts/check-bootstrap-tag.sh`

Observed selected output:

```text
1: #!/usr/bin/env bash
2: # scripts/check-bootstrap-tag.sh — sanctioned-distribution-ref guard [C1 = D6-A].
3: #
4: # The agent-bootstrap distribution contract (docs/designs/AGENT_BOOTSTRAP_PLAN.md,
5: # "Release mechanics") is a SINGLE maintainer-controlled ref: `latest-stable`,
6: # force-advanced by .github/workflows/release.yml only AFTER a release fully
7: # publishes (binaries + provenance). Paste blocks copied into the wild never
8: # rot and never point at an unreviewed branch head. This guard keeps the two
9: # public entry documents on that contract:
10: #
11: #   1. Every raw.githubusercontent.com/garrytan/gbrain/<ref>/<path> reference
12: #      in README.md and BOOTSTRAP_FOR_AGENTS.md uses <ref> = latest-stable.
13: #      Carve-out: <path> = INSTALL_FOR_AGENTS.md — that is the pre-bootstrap
14: #      OpenClaw/Hermes headline install path with its own (master) contract,
15: #      outside the bootstrap ref rule.
16: #   2. Every explicit `github:garrytan/gbrain#<ref>` install pin in those
17: #      files is #latest-stable — no v-prefixed pins, no branch refs
18: #      (master/main). The historical un-pinned `github:garrytan/gbrain`
19: #      quick-start form is tolerated (it predates bootstrap and is owned by
20: #      the README task).
21: #   3. BOOTSTRAP_FOR_AGENTS.md embeds `<!-- gbrain-runbook-stamp: X.Y.Z.W -->`
22: #      equal to the VERSION file — `bootstrap status` compares that stamp to
23: #      the installed binary (supply-chain skew check).
24: #
25: # SKIP-GRACEFUL: files that don't exist yet are skipped with a SKIP message
26: # (exit 0) so CI stays green until the bootstrap doors task lands.
27: #
28: # Modeled on scripts/check-key-files-current-state.sh. BSD/GNU grep portable
29: # (no \t escapes, no GNU-only flags).
30: #
31: # Env overrides (for this guard's own test):
32: #   GBRAIN_BOOTSTRAP_GUARD_ROOT   repo root to scan (default: script's ../)
33: #
34: # Exit codes:
35: #   0   clean (or everything skipped)
36: #   1   violation
37:
38: set -uo pipefail
39:
40: ROOT="${GBRAIN_BOOTSTRAP_GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
41: SANCTIONED='latest-stable'
42:
43: # URL terminators: whitespace, ), <, >, ", ', backtick. Built by concatenation
44: # so the single quote and backtick stay literal.
45: RAW_URL_RE='raw\.githubusercontent\.com/garrytan/gbrain/[^/[:space:]]+/[^[:space:])<>"'\''`]*'
46: PIN_RE='github:garrytan/gbrain#[0-9A-Za-z._/-]+'
47:
48: fail=0
49: checked=0
50:
51: for rel in README.md BOOTSTRAP_FOR_AGENTS.md; do
52:   f="$ROOT/$rel"
53:   if [ ! -f "$f" ]; then
54:     echo "SKIP: $rel absent — nothing to check yet"
55:     continue
[additional inspected output omitted here; inspect the frozen file for full context]
94:     version="$(tr -d '[:space:]' < "$version_file")"
95:     stamp="$(grep -oE '<!-- gbrain-runbook-stamp: [0-9A-Za-z.-]+ -->' "$runbook" \
96:       | head -1 \
97:       | sed -E 's/<!-- gbrain-runbook-stamp: (.+) -->/\1/')"
98:     if [ -z "$stamp" ]; then
99:       fail=1
100:       echo "FAIL: BOOTSTRAP_FOR_AGENTS.md is missing its '<!-- gbrain-runbook-stamp: X.Y.Z.W -->' line." >&2
101:       echo "      bootstrap status compares this stamp to the installed binary (skew check)." >&2
102:     elif [ "$stamp" != "$version" ]; then
103:       fail=1
104:       echo "FAIL: BOOTSTRAP_FOR_AGENTS.md stamp '$stamp' != VERSION '$version'." >&2
105:       echo "      Refresh the runbook stamp in the same commit as the VERSION bump." >&2
106:     fi
107:   fi
108: fi
109:
110: # ── Rule 4: plugin marketplace refs pin a sanctioned ref ─────────────────────
111: # `codex plugin marketplace add garrytan/gbrain@<ref>` in docs must use the
112: # release channel (@latest-stable) or the slim dist branch (@codex-plugin).
113: # The @-less form (`plugin marketplace add garrytan/gbrain`) is deliberately
114: # OUT of scope: Claude Code marketplace adds have no ref pin syntax, so the
115: # Claude lane documents the bare form and installs the repo default branch —
116: # a recorded decision, not a gate hole. Codex docs headline the pinned form.
117: while IFS=: read -r file line match; do
118:   ref="${match##*@}"
119:   case "$ref" in
120:     latest-stable|codex-plugin) ;;
121:     *)
122:       fail=1
123:       echo "FAIL: $file:$line pins 'marketplace add garrytan/gbrain@$ref' — use @latest-stable or @codex-plugin." >&2
124:       ;;
125:   esac
126: done < <(grep -RInE 'plugin marketplace add garrytan/gbrain@[A-Za-z0-9._-]+' \
127:   "$ROOT/README.md" "$ROOT/BOOTSTRAP_FOR_AGENTS.md" "$ROOT/INSTALL_FOR_AGENTS.md" "$ROOT/docs" 2>/dev/null \
128:   | sed -E 's/^([^:]+):([0-9]+):.*(plugin marketplace add garrytan\/gbrain@[A-Za-z0-9._-]+).*/\1:\2:\3/' || true)
129:
130: if [ "$fail" -ne 0 ]; then
131:   exit 1
132: fi
133: if [ "$checked" -eq 0 ]; then
134:   echo "check-bootstrap-tag: ok (no bootstrap entry docs present yet — all checks skipped)"
135:   echo "GBRAIN_CHECK_SKIPPED: no bootstrap entry docs present"
136: else
137:   echo "check-bootstrap-tag: ok ($checked doc(s) on the '$SANCTIONED' distribution ref)"
138: fi
```

### E:official-unreadable-tests

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:test/doctor-not-verified-5432.test.ts`

Observed selected output:

```text
54:   test('missing root -> root_unreadable; an empty dir is clean', async () => {
55:     const empty = tmp('empty');
56:     const result = await findMisroutedPages(engine, [
57:       { id: 'src-missing', local_path: join(tmpdir(), 'gbrain-5432-does-not-exist') },
58:       { id: 'src-empty', local_path: empty },
59:     ]);
60:     expect(result.unreadable_sources).toEqual([{ source_id: 'src-missing', reason: 'root_unreadable', dirs: 1 }]);
61:     const check = multiSourceDriftCheck(result, 2, 'local');
62:     expect(check.status).toBe('warn');
63:     expect(check.details?.code).toBe('not_verified');
64:     expect(check.message).toContain('src-missing (root unreadable)');
65:     expect(check.message).not.toContain('No cross-source slug drift detected.');
66:
67:     const clean = await findMisroutedPages(engine, [{ id: 'src-empty', local_path: empty }]);
68:     expect(multiSourceDriftCheck(clean, 1, 'local')).toMatchObject({ status: 'ok', message: 'No cross-source slug drift detected.' });
69:   });
70:
71:   test('an unreadable subdirectory is reported, not silently skipped', async () => {
72:     const root = tmp('subdir');
73:     mkdirSync(join(root, 'locked'));
74:     writeFileSync(join(root, 'locked', 'page.md'), 'x\n');
75:     chmodSync(join(root, 'locked'), 0o000);
76:     try {
77:       const result = await findMisroutedPages(engine, [{ id: 'src-locked', local_path: root }]);
78:       expect(result.unreadable_sources).toEqual([{ source_id: 'src-locked', reason: 'subdirs_unreadable', dirs: 1 }]);
79:       expect(multiSourceDriftCheck(result, 1, 'remote').status).toBe('warn');
80:     } finally {
81:       chmodSync(join(root, 'locked'), 0o700);
82:     }
83:   });
84:
85:   test('GBRAIN_DRIFT_LIMIT bounds the walk when opts do not', async () => {
86:     const root = tmp('limit');
87:     for (let i = 0; i < 12; i++) writeFileSync(join(root, `p-${i}.md`), 'x\n');
88:     const result = await withEnv({ GBRAIN_DRIFT_LIMIT: '5', GBRAIN_DRIFT_TIMEOUT_MS: '4000' },
89:       () => findMisroutedPages(engine, [{ id: 'src-limit', local_path: root }]));
90:     expect(result.walk_truncated).toBe(true);
91:     expect(result.limit).toBe(5);
92:     expect(result.timeout_ms).toBe(4000);
93:     const check = multiSourceDriftCheck(result, 1, 'local');
94:     expect(check.status).toBe('warn');
95:     expect(check.message).toContain('5 files / 4000 ms');
96:     expect(check.message).toContain('GBRAIN_DRIFT_LIMIT=<files>');
97:   });
98:
99:   test('a failed drift check is reported as not verified', () => {
100:     const check = multiSourceDriftNotVerified(new Error('relation "sources" does not exist'));
101:     expect(check).toMatchObject({ name: 'multi_source_drift', status: 'warn' });
102:     expect(check.details).toMatchObject({ code: 'not_verified', reason: 'relation "sources" does not exist' });
103:   });
```

### E:covered-policy

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/search/sql-ranking.ts`

Observed selected output:

```text
163:  *
164:  * The alias arms are inside the SAME `EXISTS (… src …)` as the exact match, so
165:  * the `src.source_id = a.source_id` and `src.type <> 'atom'` guards still
166:  * apply: a prefix collision against a page in a different source, or against
167:  * another atom page, never counts as coverage.
168:  *
169:  * Corpus-faithful and read-only: the subquery re-evaluates the live `pages`
170:  * and `page_links` tables on every query (per-atom source_id correlation)
171:  * rather than snapshotting the corpus; no index/embedding mutation side
176:  * @returns a raw SQL fragment (with leading space) or empty string
177:  */
178: export function buildCoveredAtomExclusionClause(slugColumn: string): string {
179:   const sourceSlug = `(a.frontmatter ->> 'source_slug')`;
180:   // Exact current slug, plus one de-prefixed alias arm per verified rename.
181:   const srcSlugMatch = [
182:     `src.slug = ${sourceSlug}`,
183:     ...LEGACY_SOURCE_SLUG_PREFIXES.map(
184:       prefix =>
185:         `(${sourceSlug} LIKE ${buildLikePrefixLiteral(prefix)} AND src.slug = substring(${sourceSlug} from ${prefix.length + 1}))`,
186:     ),
187:   ].join(' OR ');
189:   return `AND NOT (${slugColumn} = ANY (
190:     SELECT a.slug FROM pages a
191:     WHERE a.type = 'atom'
192:       AND a.deleted_at IS NULL
193:       AND (
194:         EXISTS (SELECT 1 FROM pages src
195:                  WHERE (${srcSlugMatch})
196:                    AND src.deleted_at IS NULL
197:                    AND src.type <> 'atom'
198:                    AND src.source_id = a.source_id)
199:         OR EXISTS (SELECT 1 FROM page_links pl
200:                     INNER JOIN pages t ON t.id = pl.to_page_id
201:                       AND t.deleted_at IS NULL
202:                       AND t.type <> 'atom'
203:                       AND t.source_id = a.source_id
204:                    WHERE pl.from_page_id = a.id)
205:       )
206:   ))`;
207: }
208:
209: /**
210:  * v0.26.5 — Build the soft-delete + archived-source visibility filter.
```

### E:alias-policy

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/atom-slug-alias.ts`

Observed selected output:

```text
26:
27: /**
28:  * De-prefixed alias for a frozen source slug, or `null` when the slug carries
29:  * no verified legacy prefix. Prefix-only: at most the leading allow-listed
30:  * segment is stripped, never a basename or fuzzy match.
31:  */
32: export function aliasSourceSlug(slug: string): string | null {
33:   for (const prefix of LEGACY_SOURCE_SLUG_PREFIXES) {
34:     if (slug.startsWith(prefix) && slug.length > prefix.length) {
35:       return slug.slice(prefix.length);
36:     }
37:   }
38:   return null;
39: }
40:
41: /**
42:  * Candidate live slugs for a frozen `source_slug`: the exact slug first, then
43:  * one de-prefixed alias arm per matching verified rename. Mirrors the arms
44:  * `buildCoveredAtomExclusionClause` builds, so page resolution means the same
45:  * thing in retrieval and in provenance classification.
46:  */
47: export function sourceSlugCandidates(slug: string): string[] {
48:   const out = [slug];
49:   for (const prefix of LEGACY_SOURCE_SLUG_PREFIXES) {
50:     if (slug.startsWith(prefix) && slug.length > prefix.length) {
51:       out.push(slug.slice(prefix.length));
52:     }
53:   }
54:   return out;
55: }
```

### E:quarantine-hash

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/search/mode.ts`

Observed selected output:

```text
910:   includeCoveredAtoms?: boolean;
911:   /**
912:    * v=30 (quarantine exact-slug parity): the per-call `includeQuarantined`
913:    * opt-in for this query. Folded so a cache row written under the DEFAULT
914:    * posture (quarantined pages re-marked and dropped from the exact-slug
915:    * identity tier) can never be served to an internal
916:    * `includeQuarantined:true` lookup that expects them, and vice versa.
917:    * Absent and explicit-false hash identically (both mean "default posture"),
918:    * so a legacy caller that doesn't thread the flag can still share a bucket
919:    * with an explicit default write. Internal-only flag — operator recovery is
920:    * a direct get_page, not a search-cache caller.
921:    */
922:   includeQuarantined?: boolean;
923:   /**
924:    * v=27 (2026-08 fix wave, E5b): the RESOLVED adaptive-return gate for this
925:    * call — params + the query's resolved intent class (classifier-
926:    * deterministic, computed pre-lookup by hybridSearchCached). Enabled folds
1167:     `mbg=${knobs.metadata_boost_gate ?? DEFAULT_METADATA_BOOST_GATE}`,
1168:     // v=30 addition (quarantine exact-slug parity, append-only): the
1169:     // includeQuarantined opt-in. A default-posture write (quarantined pages
1170:     // dropped from the exact-slug identity tier) must never be served to an
1171:     // internal includeQuarantined:true lookup that expects them, and vice
1172:     // versa. Strict `=== true` keeps absent and explicit-false hashing
1173:     // identically (both default). Internal-only flag — operator recovery is a
1174:     // direct get_page, not a search-cache caller.
1175:     `iq=${ctx?.includeQuarantined === true ? 1 : 0}`,
1176:   ];
1177:   const h = createHash('sha256');
1178:   h.update(parts.join('|'));
1179:   return h.digest('hex').slice(0, 16);
```

### E:provenance-reader

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:src/core/cycle/provenance-status.ts`

Observed selected output:

```text
105:   if (input.liveSourceBody == null) {
106:     return { status: 'source_gone', quotePresent: false, resolvedSlug: null };
107:   }
108:   const quote = input.sourceQuote ?? '';
109:   const present =
110:     quote.trim().length > 0 &&
111:     normForGrounding(input.liveSourceBody).includes(normForGrounding(quote));
112:   return {
113:     status: present ? 'quote_present_in_live_page' : 'quote_orphaned',
114:     quotePresent: present,
115:     resolvedSlug: input.resolvedSlug ?? null,
116:   };
117: }
118:
119: export interface ClassifyAtomProvenanceOptions {
120:   /**
121:    * The caller already knows every record is drifted (hash does not resolve) —
122:    * skip the live-hash probe entirely. Used by the doctor, which derives the
123:    * drifted set from its own aggregate before asking only about quotes.
124:    */
125:   assumeDrifted?: boolean;
126: }
127:
128: /**
129:  * Batched, read-only classification. Two small SELECTs: the live-hash prefixes
130:  * for the involved sources, and the live non-atom bodies for the candidate
131:  * slugs. Best-effort callers (search) should wrap this and never let it break
132:  * retrieval.
133:  */
134: export async function classifyAtomProvenanceRecords(
135:   engine: BrainEngine,
136:   records: readonly AtomProvenanceRecord[],
137:   opts: ClassifyAtomProvenanceOptions = {},
138: ): Promise<AtomProvenanceVerdict[]> {
139:   if (records.length === 0) return [];
140:   const sourceIds = [...new Set(records.map((r) => r.sourceId))];
141:
142:   const hashesBySource = new Map<string, Set<string>>();
143:   if (!opts.assumeDrifted) {
144:     const hashRows = await engine.executeRaw<{ sid: string; sh: string }>(
145:       `SELECT DISTINCT source_id AS sid, substring(content_hash from 1 for 16) AS sh
146:          FROM pages
147:         WHERE deleted_at IS NULL AND content_hash IS NOT NULL
148:           AND ${quarantineFilterFragment('pages')}
149:           AND source_id = ANY($1::text[])`,
150:       [sourceIds],
151:     );
152:     for (const row of hashRows) {
153:       let set = hashesBySource.get(row.sid);
154:       if (!set) { set = new Set(); hashesBySource.set(row.sid, set); }
155:       set.add(row.sh);
156:     }
157:   }
158:
159:   // Candidate (source_id, slug) pairs still needing a live body.
160:   const needSlugsBySource = new Map<string, Set<string>>();
161:   const candidatesByRecord: string[][] = records.map((r) => {
162:     const slug = normalizeSlug(r.sourceSlug);
163:     if (slug == null) return [];
164:     if (!opts.assumeDrifted) {
165:       const set = hashesBySource.get(r.sourceId);
166:       if (r.sourceHash != null && set?.has(r.sourceHash)) return []; // fresh
167:     }
168:     const candidates = sourceSlugCandidates(slug);
169:     let need = needSlugsBySource.get(r.sourceId);
170:     if (!need) { need = new Set(); needSlugsBySource.set(r.sourceId, need); }
171:     for (const c of candidates) need.add(c);
172:     return candidates;
173:   });
174:
175:   const bodyByKey = new Map<string, string>();
176:   for (const [sid, slugs] of needSlugsBySource) {
177:     const rows = await engine.executeRaw<{ slug: string; body: string | null }>(
178:       `SELECT slug, compiled_truth AS body
179:          FROM pages
180:         WHERE deleted_at IS NULL AND type <> 'atom'
181:           AND ${quarantineFilterFragment('pages')}
182:           AND source_id = $1 AND slug = ANY($2::text[])`,
183:       [sid, [...slugs]],
184:     );
185:     for (const row of rows) bodyByKey.set(`${sid}\u0000${row.slug}`, row.body ?? '');
186:   }
187:
188:   return records.map((record, i) => {
189:     let resolvedSlug: string | null = null;
190:     let body: string | null = null;
191:     for (const candidate of candidatesByRecord[i]) {
192:       const got = bodyByKey.get(`${record.sourceId}\u0000${candidate}`);
193:       if (got != null) { resolvedSlug = candidate; body = got; break; }
194:     }
195:     return classifyAtomProvenance({
196:       sourceSlug: record.sourceSlug,
197:       sourceHash: record.sourceHash,
198:       sourceQuote: record.sourceQuote,
```

### E:codegraph-tool

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:tools/codegraph-probe.ts`

Observed selected output:

```text
1: /**
2:  * codegraph-probe.ts — LOCAL-ONLY, disposable-brain code-graph probe.
3:  *
4:  * Purpose: build the native GBrain tree-sitter call graph for a checkout's
5:  * source tree inside a throwaway PGLite brain (never the live brain), then
6:  * exercise the native code-intel operations (code_callers / code_blast) and a
7:  * raw multi-hop caller expansion against that graph.
8:  *
9:  * Safety: reads only files under CG_ROOT inside this worktree; writes only to
10:  * the PGLite data dir named by CG_DB. No network, no embeddings (noEmbed:true),
11:  * no live-source imports, no extraction. Safe to delete the CG_DB dir.
12:  *
13:  * Usage:
14:  *   CG_DB=<pglite data dir> [CG_ROOT=src] [CG_SOURCE=default] [CG_OUT=out.json] \
15:  *     bun tools/codegraph-probe.ts build
16:  *   ... bun tools/codegraph-probe.ts query <symbol>
17:  *   ... bun tools/codegraph-probe.ts all   <symbol>
18:  *
19:  * Env:
20:  *   CG_DB      PGLite data dir (e.g. $GBRAIN_HOME/.gbrain/brain.pglite). Required.
21:  *   CG_ROOT    dir to index, relative to worktree root. Default 'src'.
22:  *   CG_SOURCE  source id to index/query. Default 'default'.
23:  *   CG_OUT     path to write the JSON result. Optional.
24:  *   CG_DEPTH   transitive hop cap for the raw expansion. Default 6.
25:  */
26: import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
27: import { join, relative } from 'path';
```

### E:rss-tool

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:scripts/persistence/read-workload.ts`

Observed selected output:

```text
19: export interface ReadWorkloadOptions {
20:   engine?: 'pglite' | 'postgres'; databaseUrl?: string; pages?: number; queries?: number; writers?: number; writesPerWriter?: number;
21:   /**
22:    * Scoped RSS reader. Defaults to `() => process.memoryUsage().rss`, so the
23:    * benchmark still measures real resident memory. Tests inject a deterministic
24:    * reader instead of mutating the `process.memoryUsage` global, which leaks
25:    * across tests when a workload does not reach its own cleanup (timeout/kill).
26:    */
27:   observeRss?: () => number;
28: }
29:
30: export interface ResidentMemoryObservation {
31:   rss_bytes: number | null; peak_rss_bytes: number | null; unavailable_samples: number;
32: }
33:
34: /**
35:  * Fold one RSS reading into the running observation. Only Bun's known
36:  * unavailability signal (`Failed to get memory usage`) is tolerated and counted;
37:  * any other error is a real failure and must propagate unchanged. Kept as a pure
38:  * function so the accounting (unavailable count, null sample, peak) is testable
39:  * deterministically without a workload or a process-global mutation.
40:  */
41: export function observeResidentMemory(read: () => number, previous: ResidentMemoryObservation): ResidentMemoryObservation {
42:   try {
43:     const rss = read();
44:     return { rss_bytes: rss, peak_rss_bytes: Math.max(previous.peak_rss_bytes ?? 0, rss), unavailable_samples: previous.unavailable_samples };
45:   } catch (error) {
46:     if (!(error instanceof Error) || error.message !== 'Failed to get memory usage') throw error;
47:     return { rss_bytes: null, peak_rss_bytes: previous.peak_rss_bytes, unavailable_samples: previous.unavailable_samples + 1 };
48:   }
49: }
50: const queries = ['lorem ipsum', 'consequat', 'voluptatem', 'aspernatur', 'magna', 'reprehenderit', 'commodo',
```

### E:official-rss

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:scripts/persistence/read-workload.ts`

Observed selected output:

```text
132:       sampleStage = 'metrics_rss';
133:       let rss: number | null;
134:       try { rss = process.memoryUsage().rss; }
135:       catch (error) {
136:         if (!(error instanceof Error) || error.message !== 'Failed to get memory usage') throw error;
137:         rss = null; rssUnavailable++;
138:       }
139:       peakQueueAge = Math.max(peakQueueAge, Number(row.age)); peakRecovery = Math.max(peakRecovery, Number(row.recovery));
```

### E:official-quarantine-hash

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:src/core/search/mode.ts`

Observed selected output:

```text
909:  * mean stale cache rows silently reading the wrong shape.
910:  */
911: export const KNOBS_HASH_VERSION = 30;
912:
913: /**
914:  * v0.36 (D8 / CDX-2) — second-arg context for the cache key. The
915:  * embedding column + provider live OUTSIDE ResolvedSearchKnobs because
1021: ): string {
1022:   // Fixed-order key list. Adding a knob here REQUIRES bumping
1023:   // KNOBS_HASH_VERSION and is a breaking change for any persisted cache.
1024:   const parts = [
1025:     `v=${KNOBS_HASH_VERSION}`,
1026:     `mode=${knobs.resolved_mode}`,
1027:     `cache=${knobs.cache_enabled ? 1 : 0}`,
1028:     `sim=${knobs.cache_similarity_threshold.toFixed(4)}`,
1029:     `ttl=${knobs.cache_ttl_seconds}`,
```

## Negative discovery checks (not standalone equivalence proof)

Executed from the staging tree with frozen official revision:

```text
git grep -n -E 'includeCoveredAtoms|include_covered_atoms|buildCoveredAtomExclusionClause' 0460af288227a193c2031eca2e6a64f808cbd8bd -- src
Observed: exit 1; zero output lines.
git grep -n -E 'opencodeGoSessionHeaders|x-opencode-session|OPENCODE_GO_SESSION' 0460af288227a193c2031eca2e6a64f808cbd8bd -- src
Observed: exit 1; zero output lines.
git grep -n -E 'atom_disposition|classifyAtomProvenanceRecords|quote_present_in_live_page' 0460af288227a193c2031eca2e6a64f808cbd8bd -- src
Observed: exit 1; zero output lines.
git grep -n -E 'operator-quarantine|quarantine-set' 0460af288227a193c2031eca2e6a64f808cbd8bd -- src
Observed: exit 1; zero output lines.
```

These checks corroborate the inspected execution seams above; they do not prove absence of every possible differently named equivalent. Frozen official sources, not the prior patch-ID roster, determine the classifications.

## Regression source catalog

Commands: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:TEST_PATH`. Observed selected test/describe declarations below are for the deployed source revision, not candidate results. Each table row links its corresponding files. Missing tests are disclosed above.

### test/ai/opencode-go-session.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/ai/opencode-go-session.test.ts`

```text
50: describe('opencodeGoSessionHeaders — scoped to the GO lanes', () => {
51: test('deepseek recipe on an opencode.ai base URL yields a nonempty session header', () => {
60: test('litellm recipe on an opencode.ai base URL yields a nonempty session header', () => {
69: test('opencode.ai sub-domain (e.g. zen subdomain) is matched', () => {
75: test.each([
85: test('a non-GO recipe pointed at opencode.ai still gets NO session header (scope is the two lanes only)', () => {
94: test('malformed base URL does not throw; returns undefined', () => {
102: describe('opencodeGoSessionHeaders — stable, non-secret session value', () => {
103: test('uses OPENCODE_GO_SESSION env when present', () => {
112: test('falls back to a documented literal (stable across restarts) when env is unset', () => {
120: test('literal fallback handles a missing HOSTNAME gracelessly', () => {
127: describe('applyResolveAuth — the session header rides the unified auth path', () => {
128: test('deepseek on GO: the resolved SDK headers include a nonempty session header', () => {
136: test('deepseek on DIRECT api.deepseek.com: no session header rides through applyResolveAuth', () => {
142: test('litellm on GO: the resolved SDK headers include a nonempty session header', () => {
148: test('distinct from the auth header: GO session header never shadows Authorization', () => {
```

### test/atom-disposition-cache-hit.serial.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/atom-disposition-cache-hit.serial.test.ts`

```text
152: describe('cache-hit atom_disposition re-enrichment', () => {
153: test('a cache hit re-enriches stored atom rows with CURRENT data', async () => {
```

### test/atom-disposition.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/atom-disposition.test.ts`

```text
151: describe('computeAtomBodySha256 / isSafeSlugShape (pure)', () => {
152: it('hashes compiled_truth with stable known vectors', () => {
158: it('accepts canonical slugs and rejects paths / schemes / traversal', () => {
169: describe('resolveAtomDisposition (pure decision)', () => {
179: it('absent (no candidate with this atom_id) → undefined', () => {
184: it('exact single match → historical disposition', () => {
192: it('stale (frozen body/hash mismatch) → fail closed', () => {
198: it('conflicting valid statuses → fail closed', () => {
204: it('same-status duplicates are not a conflict; latest assessed_at wins', () => {
213: it('malformed candidate (atom_id matches, fields invalid) → fail closed', () => {
220: describe('loadAtomDispositions (batched, same-source, visible)', () => {
221: it('surfaces a valid disposition with a safe same-source evidence reference', async () => {
235: it('absent companion → no disposition', async () => {
241: it('ignores a companion page in a DIFFERENT source (source_id isolation)', async () => {
249: it('honors a same-source companion when the atom itself is in a non-default source', async () => {
256: it('hides a private companion page for untrusted callers, honors it otherwise', async () => {
267: it('never reads a quarantined companion page', async () => {
274: it('drops unsafe / unresolved references (paths, traversal, private, missing)', async () => {
294: it('a valid record whose source_id disagrees with the atom is stale (fail closed)', async () => {
303: describe('stampAtomDispositions (search surface, read-only, best-effort)', () => {
304: it('stamps atom results and clears a stale disposition on every row', async () => {
321: it('clears a stale disposition even when no fresh assessment exists', async () => {
329: it('is best-effort: a throwing engine never breaks retrieval', async () => {
336: describe('loadAtomDispositionForPage (get_page helper)', () => {
337: it('returns the disposition for an atom page', async () => {
351: describe('get_page op surfaces atom_disposition', () => {
352: it('returns the top-level atom_disposition for an assessed atom', async () => {
365: it('does not add atom_disposition to a non-atom page', async () => {
371: it('still surfaces the disposition to an untrusted reader (non-private assessment)', async () => {
```

### test/atom-provenance-status.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/atom-provenance-status.test.ts`

```text
108: describe('atom-slug-alias (single-prefix, allow-listed)', () => {
109: it('is the ONE allow-list shared with the covered-atom retrieval predicate', () => {
114: it('de-prefixes exactly the allow-listed root and nothing else', () => {
129: describe('classifyAtomProvenance (pure)', () => {
130: it('slug_unbound when there is no source_slug (or only whitespace)', () => {
139: it('fresh when the hash still resolves, before any quote test', () => {
148: it('source_gone when no live source page resolves', () => {
154: it('quote_present vs quote_orphaned uses the shared grounding fold', () => {
171: it('an alive source with no stored quote is orphaned (not present)', () => {
178: describe('classifyAtomProvenanceRecords (batched, read-only)', () => {
179: it('resolves the single-prefix alias within the atom source_id', async () => {
192: it('never resolves a cross-source page (source_id isolation)', async () => {
205: describe('quarantine-aware provenance (no mutation)', () => {
206: it('held exact source cannot shadow a visible legacy alias', async () => {
221: it('a hash carried only by a held page is not fresh evidence', async () => {
233: it('held atoms do not inflate the searchable provenance inventory', async () => {
242: describe('computeAtomProvenanceDriftCheck — status classification', () => {
243: it('renamed source: frozen hermes-moncho/<X> resolves to the live <X>, quote present', async () => {
256: it('renamed source with a lost quote is quote_orphaned, still source_changed', async () => {
267: it('duplicate quotes: several atoms sharing one quote both resolve, no fan-out', async () => {
278: it('duplicate live content_hash pages do not inflate the quote-present count', async () => {
288: it('draft-only: drafts/readme is NOT de-prefixed into readme (exact allow-list only)', async () => {
301: it('changed page: an edited source whose quote no longer resolves is quote_orphaned', async () => {
315: it('source_id isolation: a hash match in another source is not fresh', async () => {
326: it('warn message tells the truth: no false "no current page contains" claim', async () => {
342: it('is READ-ONLY: running the check never rewrites source_hash', async () => {
359: describe('stampAtomProvenance (search surface, read-only)', () => {
360: it('stamps provenance_status on atom results only', async () => {
377: it('is best-effort: a throwing engine never breaks retrieval', async () => {
```

### test/autopilot-global-maintenance.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/autopilot-global-maintenance.test.ts`

```text
41: describe('cycle phase partition (#2194 fix #3)', () => {
42: test('SOURCE ∪ MIXED ∪ GLOBAL == ALL_PHASES, no overlap', () => {
50: test('every GLOBAL phase is PHASE_SCOPE==="global"; embed is global, lint is not', () => {
64: test('source freshness excludes LLM-backed/background source work', () => {
75: test('implicit source cycles are freshness-only; explicit phase lists are honored verbatim', () => {
91: test('default-like source opt-in runs a full implicit cycle without changing explicit phases (#4700)', () => {
96: test('exclusion skip-records never dilute failure status into a stampable partial (#4250 ship-stage P1)', () => {
118: test('implicit source cycle reports excluded non-freshness phases instead of silently omitting them', async () => {
143: describe('isGlobalMaintenanceStale', () => {
145: test('null/unparseable → stale (must run)', () => {
149: test('older than floor → stale; within floor → fresh', () => {
155: describe('dispatchGlobalMaintenance — single-flight gate', () => {
170: test('stale (never run) → dispatches one global job with single-flight opts', async () => {
189: test('fresh → does NOT dispatch', async () => {
196: test('coalesced submission → coalesced-aware return + dispatch_coalesced event (never claims a dispatch that did not insert)', async () => {
218: describe('dispatchPerSource — per-source jobs carry SOURCE phases only', () => {
219: test('each per-source job excludes mixed and global phases', async () => {
243: describe('autopilot-global-maintenance handler stamps last_global_at (PGLite)', () => {
256: test('autopilot-cycle handler normalizes a legacy per-source payload down to freshness phases', async () => {
280: test('an all-rejected queued payload is an explicit no-op, not an implicit freshness run', async () => {
311: test('an explicit empty phase list with a sourceId runs nothing and never stamps freshness', async () => {
327: test('a maintenance job with NO phases payload defaults to MAINTENANCE_PHASES (mixed included), not GLOBAL_PHASES', async () => {
346: test('runs global phases (no source_id) and stamps autopilot.last_global_at on success', async () => {
```

### test/brain-allowlist.serial.test.ts <!-- repo-paths: historical -->

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/brain-allowlist.serial.test.ts`

```text
51: describe('BRAIN_TOOL_ALLOWLIST', () => {
52: test('every name exists in src/core/operations.ts OPERATIONS', () => {
58: test('contains delegated page tools and excludes local-only attachments', () => {
83: test('does NOT contain destructive ops', () => {
91: describe('buildBrainTools', () => {
92: test('produces one ToolDef per allow-listed op that exists in operations.ts', () => {
99: test('tool names are brain_<op> and match Anthropic constraint', () => {
107: test('tools are flagged idempotent in v0.15', () => {
112: test('tools carry the op description verbatim', () => {
119: test('put_page schema is namespace-wrapped per subagent', () => {
132: test('non-put_page tools do NOT get a pattern on slug', () => {
140: test('execute() names a missing required parameter instead of crashing', async () => {
149: test('execute() rejects a type mismatch and an unknown enum value by name (wave review)', async () => {
157: test('execute() normalizes optional absent idioms (null / "") before validation and the handler (wave review)', async () => {
168: test('execute() on put_page with valid namespace slug succeeds', async () => {
179: test('execute() on put_page with out-of-namespace slug throws permission_denied', async () => {
194: test('execute() on put_page writes to the configured sourceId (#1586)', async () => {
225: test('buildBrainTools rejects a malformed sourceId at build time (#1586)', () => {
232: describe('filterAllowedTools', () => {
233: test('passes prefixed names through', () => {
239: test('accepts un-prefixed names as a convenience', () => {
245: test('rejects unknown tool names (no silent ignore)', () => {
250: test('deduplicates when both prefixed + unprefixed given', () => {
256: test('empty array yields empty registry', () => {
262: describe('sanitizeToolName', () => {
263: test('returns within 64 chars', () => {
269: test('replaces non-conforming chars with _', () => {
280: describe('brain_put_page pins undeclared model-authored types (#4852)', () => {
293: test('explicit undeclared type under a slug allow-list → note + frontmatter.legacy_type', async () => {
309: test('same request UUID replays frozen normalized content after the active pack changes', async () => {
330: test('scoped normalization retains raw-size and sanitized YAML rejection guards', async () => {
347: test('declared type is stored untouched (no legacy_type)', async () => {
357: test('declared alias is normalized to its canonical type (no legacy_type)', async () => {
374: test('no explicit type → pack inference untouched', async () => {
384: test('same write WITHOUT a slug allow-list (legacy agents namespace) rejects the undeclared type and persists nothing', async () => {
```

### test/by-mention-quarantine.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/by-mention-quarantine.test.ts`

```text
21: test('quarantined wrong-root names cannot outrank canonical live names', async () => {
29: test('aliases of quarantined entities are excluded as well as their titles', async () => {
37: test('quarantine-key presence mirrors search visibility even for a null marker', async () => {
42: test('flagged-but-live entities remain eligible and clearing quarantine restores aliases', async () => {
```

### test/covered-atom-source-alias.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/covered-atom-source-alias.test.ts`

```text
101: describe('covered-atom clause: source-alias arms', () => {
102: test('carries the exact-match arm PLUS a prefix-only de-prefix alias arm', () => {
116: test('does NOT use similarity/basename matching or the slug_aliases table', () => {
124: test('a source_slug with no verified prefix is untouched (0 canonical regression)', () => {
139: describe('covered-atom source-alias coverage (PGLite)', () => {
140: test('A: atom whose hermes-moncho/<X> source now lives at <X> IS covered', async () => {
156: test('B: draft-only atoms remain visible (drafts path + stripped drafts/readme)', async () => {
173: test('C: a similarly named page in ANOTHER source does NOT cover the atom', async () => {
186: test('D: a similarly named ATOM page does NOT cover the atom', async () => {
202: test('E: pre-existing exact-match and link coverage paths still work', async () => {
224: test('F: get_page on a covered atom is unaffected (search-only exclusion)', async () => {
```

### test/doctor-atom-provenance-drift.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/doctor-atom-provenance-drift.test.ts`

```text
71: describe('computeAtomProvenanceDriftCheck', () => {
72: it('is ok on a brain with no atoms', async () => {
79: it('does not flag an atom whose source_hash still resolves', async () => {
87: it('counts an edited source as source_changed, not source_gone', async () => {
98: it('counts a removed source page as source_gone', async () => {
108: it('excludes in-flight pending: markers', async () => {
116: it('stays ok below the absolute-count floor even at 100% drift', async () => {
124: it('tolerates a malformed extracted_at (one bad row must not abort the whole check)', async () => {
147: it('still reports oldest_drifted_days from the well-formed rows when a malformed one exists', async () => {
173: it('stays ok when the count floor is met but the ratio is under 10% (26 drifted of 300)', async () => {
193: it('a throwing executeRaw degrades to a warn that names the check — never throws, never fails doctor', async () => {
204: it('does not count transcript-minted (file-bound) atoms as drift (#4806)', async () => {
239: it('resolves provenance via materialized same-source lookup sets, not per-atom correlated EXISTS (#4937)', () => {
255: it('does not fan out an atom whose source hash is carried by two live pages (#4937)', async () => {
270: it('warns once both the ratio and the count are exceeded', async () => {
281: it('does not count a slug-unbound atom (source_path only, no source_slug) as source_gone — or as drift at all (#4806)', async () => {
310: it('treats an empty-string source_slug like a missing one — slug-unbound, not page-bound (#4806)', async () => {
326: it('omits the slug-unbound bucket from the warn message when every drifted atom is slug-bound', async () => {
337: it('names the slug-unbound bucket in the warn message without letting it drive the WARN or the denominator (#4806)', async () => {
```

### test/doctor-drift-coverage-note.test.ts <!-- repo-paths: historical -->

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/doctor-drift-coverage-note.test.ts`

```text
4: test('unresolved git-root coverage is disclosed rather than described as unimplemented', () => {
```

### test/doctor-not-verified-5432.test.ts

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:test/doctor-not-verified-5432.test.ts`

```text
43: describe('#5432 multi_source_drift is not verified when it could not read', () => {
54: test('missing root -> root_unreadable; an empty dir is clean', async () => {
71: test('an unreadable subdirectory is reported, not silently skipped', async () => {
85: test('GBRAIN_DRIFT_LIMIT bounds the walk when opts do not', async () => {
99: test('a failed drift check is reported as not verified', () => {
106: describe('#5432 onboard embed_staleness', () => {
107: test('counts with the embed worker predicate (countStaleChunks), not raw SQL', async () => {
117: test('a failed count warns not verified instead of "No stale chunks"', async () => {
131: describe('#5432 push status is scoped to this workspace', () => {
158: test('another root stale + this root fresh and dirty -> never a current-root FAIL', async () => {
171: test('this root stale + dirty -> FAIL naming this root and its own timestamp', async () => {
185: test('bootstrap status last_push reports this root only, both directions', async () => {
201: describe('#5432 subagent_capability no_tools', () => {
206: test('explicit models.subagent without tool calling is refused at dispatch, not a fallback', async () => {
```

### test/e2e/dream-allow-list-pglite.test.ts
<!-- repo-paths: historical -->

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/e2e/dream-allow-list-pglite.test.ts`

```text
42: // test/brain-allowlist.serial.test.ts (#4852).
51: describe('E2E allow-list — trusted-workspace path', () => {
52: test('ALLOW: subagent put_page within allow-list writes the page', async () => {
69: test('REJECT: subagent put_page outside allow-list throws permission_denied', async () => {
93: test('Multiple prefixes: each slug evaluated independently', async () => {
109: describe('E2E allow-list — legacy namespace fallback', () => {
110: test('REGRESSION GUARD: when allow-list is unset, put_page rejects writes outside wiki/agents/<id>/', async () => {
133: test('When allow-list unset, slug under wiki/agents/<id>/ is allowed', async () => {
148: describe('E2E allow-list — provenance via tool execution rows (Codex #2)', () => {
149: test('subagent_tool_executions captures slug for each put_page call', async () => {
```

### test/e2e/multi-source-drift-postgres.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/e2e/multi-source-drift-postgres.test.ts`

```text
12: describe.skipIf(!hasDatabase())('multi-source drift PostgreSQL parity', () => {
21: test('Git prefix finds default-only row; no source pin mutation', async () => {
29: test('same slug at intended source is clean, not a misroute', async () => {
33: test('missing root is unknown even when another source is verified', async () => {
38: test('server statement cancellation becomes explicit unknown coverage', async () => {
57: test('unauthorized comparison scope remains unknown rather than reading excluded source', async () => {
```

### test/e2e/operator-quarantine-postgres.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/e2e/operator-quarantine-postgres.test.ts`

```text
145: test('apply writes an object marker, preserves content/chunks/aliases, keeps projection ready', async () => {
224: test('restores projection-job state for a page that was pending before apply', async () => {
253: test('plan dry-run reports exactly 5 eligible DB-only rows without mutating', async () => {
```

### test/extract-atoms-embed-cost-gate.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/extract-atoms-embed-cost-gate.test.ts`

```text
46: describe('resolveExtractAtomsCostGate', () => {
47: test('priced chat + priced embed → cap enforced', () => {
52: test('free local chat + no embedding configured → cap enforced (nothing unpriced bills)', () => {
56: test('free local chat + free local embed → cap enforced at $0', () => {
60: test('unpriced chat model BLOCKS the phase (fail-closed) and names the chat model', () => {
70: test('free local chat + UNPRICED embed BLOCKS the phase (was the fail-open defect)', () => {
80: test('an operator pricing override for the embed model restores the cap', () => {
86: test('override lookup is case-insensitive, matching BudgetTracker.reserve()', () => {
96: test('an unpriced embed BLOCKS even with an explicit operator budget (no $0 pretend)', () => {
106: test('an unpriced CHAT model BLOCKS (never $0-priced; the cap exists for this call)', () => {
117: describe('extract_atoms with a $0 chat model and an unpriced embedding model (PGLite round-trip)', () => {
160: test('the unpriced embed with a DEFAULT budget now FAILS CLOSED: 0 atoms, 0 spend, blocked', async () => {
185: test('an explicit cycle.extract_atoms.budget_usd canNOT pretend to cap the unpriced embed — still FAILS CLOSED', async () => {
214: test('with a $0 pricing override for the embed model the cap stays on and the run still extracts', async () => {
```

### test/extract-atoms-hardening.test.ts <!-- repo-paths: historical -->

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/extract-atoms-hardening.test.ts`

```text
63: describe('resolveExtractAtomsCostGate — FAIL CLOSED on an unpriced billable model', () => {
64: test('priced chat + priced embed → cap enforced (default budget)', () => {
68: test('priced chat + priced embed → cap enforced', () => {
72: test('no embedding configured → cap enforced (nothing unpriced bills)', () => {
76: test('unpriced CHAT model → BLOCKED (never $0-priced; the cap is for this call)', () => {
86: test('unpriced EMBED → BLOCKED (no operator budget can change this)', () => {
100: test('a formally zero-cost local embed (ollama) is priceable → cap enforced at $0', () => {
104: test('an operator pricing override for the embed model restores the cap (not blocked)', () => {
112: describe('runExtractAtomsDrain — a blocked phase stops immediately, no hot loop', () => {
113: test('a zero-progress (blocked) batch stops at no_progress after one batch', async () => {
131: test('a preflight-blocked batch is retriable, not a false-green completion', async () => {
207: describe('extract_atoms FAILS CLOSED with zero inference when a billable model is unpriced', () => {
208: test('unpriced EMBED + default budget → blocked, 0 chat, 0 embed', async () => {
240: test('unpriced CHAT model → blocked, 0 chat calls', async () => {
255: test('unpriced EMBED + EXPLICIT budget_usd=0.25 → STILL FAILS CLOSED, 0 chat, 0 embed', async () => {
278: test('control: an operator pricing override makes the route runnable and capped', async () => {
322: describe('quarantined pages are excluded from atom extraction', () => {
323: test('discoverExtractablePages excludes a quarantined page', async () => {
331: test('countExtractAtomsBacklog excludes a quarantined page (doctor number)', async () => {
340: test('a page quarantined BETWEEN list and execution never reaches the model', async () => {
366: test('control: a non-quarantined listed page still extracts', async () => {
390: describe('drain --dry-run makes zero inference calls', () => {
391: test('runDream --drain --dry-run --json: 0 chat, 0 embed, batches 0', async () => {
427: describe('quarantine re-check fails closed when its query errors', () => {
428: test('quarantinedSlugsAmong THROWS (never returns an empty "none quarantined" set)', async () => {
438: test('a listed page + a failing re-check → phase BLOCKED, 0 chat, 0 embed', async () => {
```

### test/extract-by-mention-rebuild.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/extract-by-mention-rebuild.test.ts`

```text
110: describe('extract links --by-mention --rebuild (#3674)', () => {
111: test('quarantined origins lose derived mentions without changing manual links or content', async () => {
125: test('rebuild removes the stale mention the additive path leaves behind', async () => {
145: test('rebuild sweeps a page whose body no longer mentions anything', async () => {
156: test('still-valid typed_ner rows survive; stale typed_ner rows die', async () => {
178: test('other link_sources are untouched by the rebuild sweep', async () => {
191: test('--rebuild without --by-mention is rejected with exit 2', async () => {
197: test('summary reports removed count', async () => {
206: test('removeLinksByPagesAndSource: empty page list is a no-op', async () => {
```

### test/forward-port-semantics.test.ts <!-- repo-paths: historical -->

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/forward-port-semantics.test.ts`

```text
37: describe('forward-port: canonical put_page types', () => {
38: test('a declared canonical type classifies as canonical', () => {
43: test('a declared alias classifies as alias_of with canonical + directory', () => {
52: test('an undeclared explicit type classifies as undeclared', () => {
56: test('canonicalTypeRejectMessage names the declared vocabulary so the caller self-corrects', () => {
65: test('canonicalTypeRejectMessage handles an empty pack gracefully', () => {
83: describe('forward-port: sync.exclude root guard', () => {
84: test('comma + newline separated roots are split, trimmed, filtered', () => {
90: test('trailing-slash roots become subtree globs; bare roots match literal', () => {
95: test('a slug under an excluded subtree root is rejected (matchesAnyGlob)', () => {
101: test('a slug outside the excluded roots is allowed', () => {
106: test('empty / null config fail-open (nothing scoped, nothing rejected)', () => {
112: test('a bare prefix root matches only that path segment subtree', () => {
114: // `secret/x` must NOT match it (matchesAnyGlob is segment-aware).
122: describe('forward-port: exclude_slug_prefixes retrieval seam', () => {
123: test('buildHardExcludeClause unions caller prefixes into the SQL AND-clause', () => {
130: test('covered-atom clause (adapt 4) is appended to the hard-exclude clause when opt-out absent', () => {
143: describe('forward-port: covered-atom default exclusion clause', () => {
144: test('excludes atoms whose source_slug resolves to a live non-atom page', () => {
155: test('knobsHash folds includeCoveredAtoms opt-out into the hash (ica bit)', () => {
```

### test/import-file-slug.test.ts <!-- repo-paths: historical -->

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/import-file-slug.test.ts`

```text
28: describe('resolveImportSlug — path-authoritative slug selection', () => {
29: test('matching path slug: no error, no fallback', () => {
38: test('parse error rejects with the path slug and the frontmatter error', () => {
49: test('empty path slug + frontmatter slug -> fallback (path slugified empty)', () => {
59: test('empty path slug + no frontmatter slug -> "no usable slug" error', () => {
67: test('normalization-equivalent frontmatter slug -> identity restore', () => {
77: test('frontmatter slug claiming a different page -> mismatch error (anti-spoof)', () => {
86: describe('resolveImportSlug — integration through parseMarkdown', () => {
87: test('real frontmatter slug with a normalization-equivalent spelling restores identity', () => {
96: test('invalid YAML frontmatter is rejected before any slug is minted', () => {
105: describe('invalidYamlFrontmatterError', () => {
106: test('returns null when there is no YAML_PARSE error', () => {
```

### test/multi-source-drift-compiled.serial.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/multi-source-drift-compiled.serial.test.ts`

```text
9: describe.skipIf(!binary)('compiled multi_source_drift doctor', () => {
10: test('prefixed drift, clean mapping and missing-root unknown survive CLI process reopen without page/source mutation', async () => {
```

### test/multi-source-drift-coverage.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/multi-source-drift-coverage.test.ts`

```text
37: describe('multi-source drift coverage honesty', () => {
38: test('missing root is unknown, never verified clean', async () => {
46: test('a regular file used as local_path is a coverage error', async () => {
50: test('an actually unreadable root records native filesystem failure', () => {
60: test.skipIf(process.getuid?.() === 0)('an unreadable nested directory does not disappear behind a clean sibling', async () => {
70: test('invalid YAML, unsupported strategy and slug collisions cannot be certified clean', async () => {
78: test('clean accessible empty directory is verified, not a missing root', async () => {
83: test('partial Git skip alongside clean source remains WARN locally and remotely', async () => {
93: test('roster database failure is visible in actual local and remote doctor', async () => {
103: test('source pin read errors are unknown rather than an omitted check', async () => {
109: test('candidate-query errors retain the failure reason', async () => {
115: test('one globally shared file budget accounts for unvisited sources', async () => {
122: test('exact limit on the final source does not falsely claim truncation', async () => {
126: test('invalid budgets never claim a clean verification', async () => {
132: test('a stuck database read returns deadline/unknown, not a clean zero', async () => {
142: test('default doctor budget survives real IO above five seconds while explicit deadlines remain fail-closed', async () => {
167: test('a caller without the comparison grant does not query default pages', async () => {
180: describe('sync identity and eligibility parity', () => {
181: test('normalization-equivalent frontmatter restores exact imported slug', async () => {
187: test('frontmatter cannot spoof another path-authoritative page', async () => {
194: test('empty path-derived identity uses the importer frontmatter fallback', async () => {
200: test('stored source_path resolves legacy slugs and prevents filename collision advice', async () => {
208: test('a legacy default-side source_path identity is detectable', async () => {
215: test('duplicate active source_path is unknown, not first-row-wins', async () => {
223: test('persisted exclude, hidden waiver, underscore files and canonical metafiles match sync', async () => {
```

### test/multi-source-drift.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/multi-source-drift.test.ts`

```text
79: describe('findMisroutedPages — heuristic correctness', () => {
80: test('case 1: no non-default sources → returns empty result (caller skips check)', async () => {
89: test('case 2: multi-source brain, no misroutes → count=0', async () => {
109: test('case 3: multi-source brain, 2 misrouted slugs → warn with sample', async () => {
135: test('case 4: healthy same-slug-across-sources is NOT a false positive (OV4 redesign)', async () => {
158: test('case 5: FS walk hits limit → walk_truncated=true', async () => {
172: test('case 6 (OV13): unreadable local_path does NOT crash; returns empty', async () => {
181: test('case 7 (OV13): .mdx files are walked alongside .md', async () => {
198: test('case 8 (#4712): git-root-pinned source is checked with its prefixed slug, not skipped', async () => {
225: test('case 8b (#4712): correctly-routed git-root-pinned source → no false positive', async () => {
248: test('case 8c (#4712): git-root pin whose git root cannot be resolved → fail closed (skipped)', async () => {
270: test("case 8d (#4712): git-root pin on the repo ROOT itself → prefix '' (shapes coincide), still checked", async () => {
291: test('case 9 (#4712): git-root and source-root siblings are both verified', async () => {
319: test('Readwise-shaped nested scope normalizes spaces, punctuation and mdx without walking siblings', async () => {
339: test('symlinked local_path uses physical Git scope, not the alias basename', async () => {
354: test('explicit source-root pin inside Git stays unprefixed and is never rewritten', async () => {
370: test('unresolvable Git root does not hide real drift on a checked sibling', async () => {
387: test('linked Git worktree resolves its own scope, not the common repository directory', async () => {
406: test('slow Git discovery exhausts the shared deadline, discloses skip and never queries candidates', () => {
```

### test/operator-quarantine-set.serial.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/operator-quarantine-set.serial.test.ts`

```text
23: * Fresh PGLite per test (resetPgliteState) + a temp source root on disk.
84: // Fresh source root per test (a previous test may have materialized a
138: describe('operator quarantine-set — manifest parsing (fail-closed)', () => {
139: test('parses JSONL and preserves a comma-containing source_path verbatim', () => {
146: test('rejects a line missing content_hash', () => {
151: test('rejects a duplicate id', () => {
156: test('rejects an empty manifest', () => {
160: test('hard cap is declared and positive', () => {
169: describe('operator quarantine-set — plan / apply / search / rollback', () => {
170: test('dry-run plan finds exactly 5 eligible DB-only rows', async () => {
184: test('apply writes only the marker; content_hash/chunks/aliases unchanged; generation + clock advance', async () => {
226: test('quarantine filter hides the page from keyword AND vector search', async () => {
257: test('rollback from snapshot removes only the operator marker', async () => {
273: test('rollback refuses when the live marker provenance no longer matches the snapshot', async () => {
284: describe('operator quarantine-set — fail-closed guards', () => {
285: test('rejects a canonical-file-backed page (file exists under the source root)', async () => {
300: test('rejects a content_hash mismatch (stale manifest)', async () => {
308: test('rejects a source_path mismatch', async () => {
317: describe('operator quarantine-set — owner-gate semantics', () => {
318: test('applies without creating a worktree binding or persistence request (not the coordinator path)', async () => {
336: test('snapshot round-trips through disk (before-state is durable)', async () => {
349: describe('operator quarantine-set — CLI end-to-end', () => {
350: test('gbrain quarantine set --yes applies, then rollback --yes clears', async () => {
376: test('refuses an unknown --reason before touching the DB', async () => {
407: //   - every text/keyword search hides it (currentTextProjectionFilter), and
433: describe('operator quarantine-set — projection visibility (apply + rollback)', () => {
434: test('apply keeps targets projection-ready; rollback restores keyword search and readiness', async () => {
462: test('rollback heals a page left unsealed with no job by the pre-fix lane (restores search)', async () => {
492: test('a pre-existing pending projection is preserved, not silently sealed', async () => {
525: describe('operator quarantine-set — concurrency + persistence guards', () => {
526: test('apply refuses a row that drifts between plan and apply, atomically (no marker written)', async () => {
541: test('refuses apply and rollback when persistence_brain.enabled=true (raw metadata UPDATE)', async () => {
561: describe('operator quarantine-set — manifest scale + artifact safety', () => {
570: test('accepts the exact 6915-row incident manifest and rejects beyond the hard cap', () => {
579: test('CLI archives the manifest with its sha and writes the snapshot 0600', async () => {
```

### test/persistence-performance.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/persistence-performance.test.ts`

```text
11: describe('read-load evidence', () => {
14: test.each([false, true])('RSS accounting exposes failures and recovery (all=%s)', all => {
31: test('unavailability after successful samples retains the measured peak', () => {
37: test('unexpected RSS failures propagate instead of counting as unavailable', () => {
46: test('rejects invalid workload sizes before opening a datastore', async () => {
49: test('late completion cannot hide an idle interval in the middle of reads', () => {
54: test('warmup reset retains separate, deduplicated admission and terminal timings', () => {
77: test('compares independent medians and preserves the 50 percent boundary', () => {
83: test(`CLI advisory policy preserves measured failure and rejects invalid work (${informational}, ${valid})`, () => {
108: test('a fast invalid or incomplete sample always fails', () => {
```

### test/persistence-rss-workload.serial.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/persistence-rss-workload.serial.test.ts`

```text
13: describe('read-load RSS integration', () => {
14: test.each([false, true])('unavailable RSS stays explicit without invalidating real reads and writes (all=%s)', async all => {
```

### test/scripts/serial-files.test.ts

Command: `git show 0460af288227a193c2031eca2e6a64f808cbd8bd:test/scripts/serial-files.test.ts`

```text
2: * Regression test (e): scripts/run-serial-tests.sh discovery + concurrency=1.
38: describe('run-serial-tests.sh contract', () => {
42: const offenders = serialFiles.filter(f => !/\.serial\.test\.ts$/.test(f));
54: .filter(f => /\.serial\.test\.ts$/.test(f) && !f.startsWith('test/e2e/'));
73: describe('EXCLUSIVE_FILES (pooled-runner opt-out) guards', () => {
101: describe('scripts/serial-files.tsv (serial lane manifest)', () => {
103: .split('\n').map(f => f.trim()).filter(f => /\.serial\.test\.ts$/.test(f) && !f.startsWith('test/e2e/') && existsSync(resolve(REPO_ROOT, f)));
```

### test/search-mode.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/search-mode.test.ts`

```text
22: describe('SEARCH_MODES + MODE_BUNDLES canonical shape', () => {
23: test('SEARCH_MODES is exactly the 3 expected values', () => {
27: test('DEFAULT_SEARCH_MODE is balanced (matches v0.31.x current default surface)', () => {
31: test('MODE_BUNDLES is frozen (cannot be mutated)', () => {
57: test('conservative bundle values are canonical', () => {
98: test('balanced bundle values are canonical', () => {
141: test('tokenmax bundle values are canonical (NOTE: limit=50, NOT current=20)', () => {
182: test('cache_enabled is true in every mode (free win)', () => {
188: test('intentWeighting is true in every mode (zero-LLM cost)', () => {
194: test('tokenBudget escalates: 4000 → 12000 → undefined', () => {
200: test('searchLimit escalates: 10 → 25 → 50', () => {
207: describe('isSearchMode', () => {
208: test('accepts every documented mode', () => {
213: test('rejects unknown strings, numbers, null, undefined', () => {
223: describe('resolveSearchMode resolution chain', () => {
224: test('no inputs → balanced bundle (fallback)', () => {
233: test('valid mode picked, no overrides → bundle values pass through', () => {
241: test('invalid mode string → balanced fallback (mode_valid=false)', () => {
248: test('mode string case-normalized (TokenMax → tokenmax)', () => {
254: test('per-key override wins over mode bundle (CDX-5 chain)', () => {
265: test('per-call override wins over per-key override', () => {
274: test('per-call false-y values (false / 0) still beat fallback', () => {
283: test('undefined fields in perCall fall through (not coerced to false)', () => {
293: describe('v0.40.6.1 — reranker_timeout_ms threads recipe default through resolution', () => {
300: test('llama-server-reranker resolves to 30000ms recipe default (no override)', () => {
309: test('config override beats recipe default', () => {
320: test('per-call override beats config override AND recipe default', () => {
332: test('Voyage (no recipe default) regression: still gets bundle default of 5000ms', () => {
342: test('unknown provider id falls through to bundle default', () => {
351: describe('attributeKnob source attribution', () => {
352: test('per-call source labeled correctly', () => {
360: test('override source labels the REAL config key path, not the knob name (#4605)', () => {
376: test('mode source labels the mode name', () => {
384: test('fallback source labels the unset state explicitly', () => {
394: describe('knobsHash determinism + cross-mode separation (CDX-4)', () => {
395: test('hash is deterministic across calls', () => {
402: test('different modes produce different hashes', () => {
411: test('per-call override changes the hash (cache key bifurcates)', () => {
417: test('hash is short (16 hex chars) and stable shape', () => {
422: test('KNOBS_HASH_VERSION constant exposed for migrations to bump on schema change', () => {
500: test('#3515: detail set vs unset produces DIFFERENT hashes (cache contamination prevention)', () => {
538: test('#4352 follow-up: excludePrivate true vs false produces DIFFERENT hashes (cache contamination prevention)', () => {
555: test('quarantine exact-slug parity: includeQuarantined true vs default produces DIFFERENT hashes (cache contamination prevention)', () => {
577: test('#4415 (wave-g): salience/recency modes produce DIFFERENT hashes (cache contamination prevention)', () => {
595: test('#4415 (wave-g): intent-pattern config fingerprint produces DIFFERENT hashes (config-edit invalidation)', () => {
611: test('T1 (codex): floor_ratio set vs unset produces DIFFERENT hashes (cache contamination prevention)', () => {
620: test('T1 (codex): different floor_ratio values produce different hashes', () => {
629: test('same floor_ratio produces same hash (idempotent cache key)', () => {
636: describe('loadOverridesFromConfig flat-map parser', () => {
637: test('empty config map → empty overrides', () => {
642: test('cache.enabled accepts 1 / 0 / true / false strings', () => {
650: test('numeric keys parse and clamp', () => {
657: test('invalid numerics are ignored (not coerced to NaN/0)', () => {
670: test('similarity_threshold rejects values outside (0, 1]', () => {
676: test('v0.35.6.0: floor_ratio parses valid 0..1 values', () => {
683: test('v0.35.6.0: floor_ratio rejects out-of-range values silently', () => {
691: describe('SEARCH_MODE_CONFIG_KEYS is the full reset surface', () => {
692: test('every key starts with search. prefix (gbrain config unset --pattern search.* compatibility)', () => {
698: test('every ModeBundle field has a config key (consistency check)', () => {
708: describe('Type-only smoke test (compiler sees SearchMode union)', () => {
```

### test/search/alias-hop.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/search/alias-hop.test.ts`

```text
29: describe('applyAliasHop', () => {
30: test('a page made private after retrieval cannot add alias metadata or boost', async () => {
42: test('alias-injected excerpts strip every protected take fence', async () => {
50: test('injects an absent canonical when the query matches its alias', async () => {
64: test('romanization/CJK alias also resolves', async () => {
71: test('boosts (does not duplicate) a canonical already in results', async () => {
82: test('P0 source-isolation: alias hop boosts only the aliased source, not the same slug in another source', async () => {
104: test('no alias match → input unchanged', async () => {
110: test('long query is skipped (clearly prose, not a chosen name)', async () => {
117: test('collision: two pages claim one alias → both injected, capped + deterministic', async () => {
126: test('quarantine parity: a quarantined canonical is never alias-injected (hidden at alias resolution)', async () => {
143: describe('ingest projection (importFromContent)', () => {
144: test('frontmatter aliases: land in page_aliases on import', async () => {
152: test('removing an alias from frontmatter clears it on re-import', async () => {
```

### test/search/exact-lookup.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/search/exact-lookup.test.ts`

```text
51: describe('isSlugShapedQuery', () => {
52: test('slug-shaped tokens qualify; prose and bare words do not', () => {
61: describe('structuralExactLookup (#1663)', () => {
62: test('private exact slugs cannot bypass retrieval privacy; local and public controls survive', async () => {
72: test('injected excerpts strip protected sections before truncating', async () => {
79: test('slug-shaped query resolves the page directly (evidence → exists)', async () => {
92: test('exact-title equality matches off the provided title arm (no extra query)', async () => {
108: test('a PARTIAL title match never qualifies (equality, not phrase)', async () => {
117: test('non-lookup-shaped queries are a pure no-op', async () => {
126: test('supersession filter: a superseded page never wins the identity slot', async () => {
137: test('source isolation: scoped probe never resolves another source', async () => {
148: describe('#4480 — shape-filter gating (type/types/excludeSlugs)', () => {
149: test('excludeSlugs drops a slug-probe hit the caller filtered out', async () => {
162: test('types gate drops hits whose type is outside the filter; matching type passes', async () => {
178: test('scalar type gate applies to title-arm hits too', async () => {
195: describe('applyExactLookupTier (#1663)', () => {
196: test('injects an absent identity match at rank-1 above scored organics', async () => {
208: test('promotes and collapses an identity match repeated by chunk results', async () => {
227: test('no identity match → input unchanged', async () => {
234: describe('applyExactLookupTier chunk-collapse — three chunks, tie, ordering, foreign source (ship-review)', () => {
235: test('three chunks of the identity page collapse to ONE (the strongest), even when the weaker chunks precede it', async () => {
254: test('a three-way score tie keeps the FIRST chunk in input order', async () => {
271: test('a same-slug row from ANOTHER source (team-b) is never merged into the collapse — it survives with its score', async () => {
298: describe('applyExactLookupTier collapse — tie-break, interleaving, source isolation (#4531 review)', () => {
299: test('a score tie between two chunks of the identity page keeps the FIRST chunk', async () => {
315: test('interleaved identity chunks collapse safely (highest-index-first splice keeps the others intact)', async () => {
334: test('a same-slug row from ANOTHER source_id is not collapsed, promoted, or stamped', async () => {
366: describe('quarantine parity — exact-slug probe', () => {
367: test('default: a quarantined exact slug is NOT injected by the slug probe', async () => {
373: test('includeQuarantined: the same slug resolves again (explicit opt-in)', async () => {
384: test('default: a NON-quarantined exact slug is unaffected (no over-reach)', async () => {
397: test('direct get_page still returns a quarantined page (search-only fix)', async () => {
404: test('a content_flag (WARN, not HIDE) page is still injected — only quarantine hides', async () => {
415: describe('quarantine parity — applyExactLookupTier', () => {
416: test('default drops the quarantined identity hit; includeQuarantined injects it at rank-1', async () => {
```

### test/search/knobs-hash-reranker.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/search/knobs-hash-reranker.test.ts`

```text
47: describe('KNOBS_HASH_VERSION + version invariants', () => {
48: test('version is 30 (…; 24→25 keywordOrFallback knob kof= #3617; 25→26 salience/recency + intent_patterns fold #4415; 26→27 adaptive-return gate + intent fold E5b/F11; 27→28 compiledTruthBoost synthetic-row suppression #4256/#3695; 28→29 evb= expansion variant budget fold; 29→30 iq= includeQuarantined fold)', () => {
108: test('hash is 16 hex chars regardless of reranker config', () => {
116: describe('Each reranker field flips the hash (cache-row separation)', () => {
117: test('reranker_enabled false vs true → different hash', () => {
123: test('reranker_model differs → different hash', () => {
130: test('reranker_top_n_in differs → different hash', () => {
136: test('reranker_top_n_out null vs 10 → different hash', () => {
142: test('reranker_timeout_ms differs → different hash (CDX2-F14)', () => {
152: describe('mid-deploy invariant (CDX2-F12)', () => {
153: test('tokenmax-with-reranker vs tokenmax-without-reranker → distinct hashes', () => {
165: test('conservative vs balanced vs tokenmax → 3 distinct hashes', () => {
173: describe('determinism + stability', () => {
174: test('same input → same hash (re-call)', () => {
179: test('same mode bundle → same hash across resolveSearchMode calls', () => {
185: test('top_n_out=null renders as "none" in parts[] (no NaN)', () => {
196: describe('append-only convention (CDX2-F13)', () => {
197: test('parts[] order in source: reranker fields appear AFTER the existing 9', async () => {
212: test('v=3 additions: col= and prov= appear AFTER the reranker block', async () => {
228: test('v=3 fields participate: column flip changes the hash', () => {
235: test('v=3 fields participate: same column + different provider → different hash', () => {
242: test('v=3 fields fall back to embedding/default when ctx undefined', () => {
253: describe('v=12 hard-exclude participation (#2825)', () => {
254: test('different exclude lists → different hashes', () => {
261: test('include (opt-back-in) changes the hash too', () => {
268: test('same prefixes in different input order → SAME hash (normalization)', () => {
275: test('undefined hardExcludes is stable (legacy-caller fallback)', () => {
286: describe('v0.48.2 reranker default flip re-keys the cache (rrm= is folded unconditionally)', () => {
287: test('per mode: hash(DEFAULT voyage) !== hash(synthetic model) even with the reranker OFF', () => {
298: describe('ranker wave (R1): relational_rerank_pin participates in the hash (rrp=)', () => {
299: test('pin 3 (bundle) vs 0 (off) vs 1 → three distinct hashes; a partial-knobs literal hashes as the bundle default', () => {
309: describe('ranker wave (Phase E2): keyword_arm_confidence_floor participates in the hash (kacf=)', () => {
310: test('off (bundle null) vs 0.6 vs 0.5 → three distinct hashes; a partial-knobs literal hashes as off', () => {
321: describe('ranker wave (Phase E3): metadata_boost_gate participates in the hash (mbg=)', () => {
322: test('always vs lexical (bundle) → distinct hashes; a partial-knobs literal hashes as always', () => {
```

### test/search/quarantine-exact-slug-hybrid.serial.test.ts

Command: `git show e90ad6eddce9414d262e11bbc01ce63cf6235de8:test/search/quarantine-exact-slug-hybrid.serial.test.ts`

```text
62: describe('hybridSearchCached — quarantine parity for exact-slug lookups', () => {
63: test('default: a quarantined exact slug never appears in search results', async () => {
69: test('default: a clean exact slug is still returned (no over-reach)', async () => {
75: test('includeQuarantined: true: the quarantined slug is returned again (explicit opt-in)', async () => {
```
