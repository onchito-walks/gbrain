# Stage 3 behavior checkpoint — t_4dd80505

Status: PARTIAL. Stage 3 is NOT complete and Stage 4 must remain dependency-gated.

Base: 559d9dae8f41c5e575188cc256b5994c0474e1ad (Stage 2).
Frozen official ancestry: 0460af288227a193c2031eca2e6a64f808cbd8bd.
Implementation worktree: /srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3-behaviors
Branch: upgrade/stage3-behaviors-isolated
Staging integration: fast-forwarded upgrade/official-v060178-reconciled to 2d6541816102302998b56c05a1e5a46f771445ba after clean status and exact base checks.

## Completed behaviors (one focused passing behavior per commit)

- B06: 476a5d6709aff13c449793dafe8da8688207be29. GO session header merged into existing unified auth, preserving recipe defaults and auth-shadow refusal. Helper is a small sibling, not an old gateway wholesale port. Real SDK transport is exercised with hermetic fetch for each unified auth touchpoint on deepseek/litellm; direct and lookalike hosts excluded. 8 tests / 24 expectations. No actual provider request or credential changes.
- B14: b1776e5befb9b31aad23d2d6f27c8fec94f9fcc5. Global job queue is maintenance; source cycles remain default. Native single-flight, coalesced reporting, timeout and resume behavior retained. Focused upstream suite: 44 / 325 expectations, three files.
- B07: 0410f31c6568e715ed7c988a619f089d0671f7ae. Exact-slug tier checks quarantine; single shared lexical-stage options feed all hybrid return paths. Internal opt-in retained. Direct engine recovery reads intentionally remain readable. New hermetic hybrid/alias/content-flag fixture plus official exact/alias suites: 35 / 109 expectations, three files. This is not a claim that every automatic processing path is integrated.
- B08: 2dea58e6c18198a30ee3bdf60187102e41dcf0fb. Optional iq=1 key part separates recovery posture; absent/false default keys unchanged. Uses upstream opt-in-only append convention like decide/planner, preserving official version 30 (which owns its exact-title epoch); does not copy the old local version-30 bump. Semantic response reuse remains disabled. 196 / 444 expectations, four files.
- B16: 96382c2ec6227b7aa2966216b79b9dda1c8b8641. Shared quarantine SQL fragment added to official source-pack-aware title and alias gazetteer queries. Null marker, aliases, clearing and flagged-live controls exercised. 61 / 142 expectations, two files.
- B17: 506c4c33596d25b6873e1ee0d73ffef0f18d6f67. Additive mode preserves native skip; rebuild reconciles quarantined origins with empty text. Removes scanner-owned links only; manual links and original bodies preserved. Official title-inclusive matching for live pages retained. 9 / 22 expectations, one file.

Follow-up acceptance fix: 2d6541816102302998b56c05a1e5a46f771445ba. Test fetch explicitly typed for Bun fetch's preconnect extension; no production transport change. Extract stays inside original ceiling. Reviewer-visible module accounting: hybrid interface +2 lines, mode context/hash +4 lines. Guard remains enabled; no function ceiling or timeout assertion changed.

## Actual final execution

Fenced Bun 1.4.3, ubuntu, isolated worktree at code SHA 2d6541816102302998b56c05a1e5a46f771445ba:

`bun test test/ai/opencode-go-session.test.ts test/autopilot-global-maintenance.test.ts test/autopilot-global-maintenance-resume-4578.test.ts test/autopilot-fanout-wiring.test.ts test/search/quarantine-exact-slug-hybrid.serial.test.ts test/search/exact-lookup.test.ts test/search/alias-hop.test.ts test/search/knobs-hash-reranker.test.ts test/search-mode.test.ts test/search-alias-resolved-boost.test.ts test/cross-modal-phase1.test.ts test/by-mention-quarantine.test.ts test/by-mention.test.ts test/extract-by-mention-rebuild.test.ts`

Observed: 353 pass, 0 fail, 1066 expectations, 14 files, 43.19 seconds, exit 0.

`bun run typecheck`, `bun run check:module-size`, `bun run check:function-size`, `bun run check:windows-hide`, `git diff --check`: exit 0 after follow-up. First typecheck timed out at 180 seconds, longer run exposed one test fetch type error; repaired and rerun successfully. First size check failed for three modules; extract growth removed and exact interface/hash accounting committed. No skipped failing acceptance relabeled green.

Installation used `GBRAIN_UPGRADE_OWNS_MIGRATIONS=1` with fenced Bun/PATH. Postinstall reported migrations deferred. PGLite tests used disposable in-memory databases. No deployment, restart, production DB mutation, routing/grant/firebreak changes, build or external publication in this stage checkpoint.

## Exact unfinished inventory

Runtime: B01, B02, B03, B04, B05, B09, B10, B11, B12, B13, B15, B27.
Tooling: B24, B25, B26.
B23 serving environment value remains rollout-owned as recorded by Stage 2.

The remaining set is too large for this bounded run. Smallest sensible continuation cohorts:
1. B01/B02: put_page canonical vocabulary and sync.exclude admission with actual-operation refusal/no-side-effect tests.
2. B03/B04/B05/B09/B10/B27: coupled read/retrieval overlays, same-source/alias/visibility/companion assessment engine fixtures.
3. B11/B12/B13: native extraction cost/refusal/quarantine execution-boundary and drain truthfulness.
4. B15/B24/B25/B26: guarded operator lane and verification tooling. Do not bypass managed-writer refusal; adapt native contracts.

Re-use Stage 1 classification and these commits. Do not reconstruct history, deploy, or release Stage 4 as if Stage 3 were finished. Whole-candidate matrix, PostgreSQL E2E, compiled caller, migration rehearsal and live acceptance remain later-stage gates.

## Stage 3A continuation — B01 committed, B02 not started (task t_7686aa20)

Isolated worktree /srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3a-admission,
branch upgrade/stage3a-admission-isolated, forked from exact staging SHA
0f478c9e967b2373ea0ad50ee3e5beb130305bd6. Shared staging untouched and clean at that SHA.

B01 — committed 79a8a2ccac908108dc1549657d015bcc1cdf58a0 (one behavior, focused regression).
  Files: src/core/persistence/put-page-vocabulary.ts (new; canonicalPutPageContent +
  putPageVocabularyContent), src/core/ops/pages.ts (dry-run enforcement),
  src/core/persistence/page-mutations.ts (admission preflight before registration, terminal-UUID
  replay preserved, intent.content normalized once), src/core/persistence/page-prepare.ts
  (publication canonicalization on the locked snapshot), test/put-page-vocabulary.serial.test.ts
  (new), test/put-page-type-warning.test.ts (refusal replaces the upstream #5880 warning contract).
  Actual put_page operation tests, not helper-only: refusal matrix remote x dry run asserts
  rejection with equal disk+DB snapshot over 13 tables and no provider fetch; valid controls
  prove canonical + alias ('project-card') persistence as type: initiative through the native
  writer, byte-stable terminal-UUID replay, revision-preserving replacement refusal, implicit-type
  preservation of the curated type, and best-effort verbatim writes under an unresolvable pack.
  Fixture scope: the disposable vault is git-init'ed so discovery cannot climb into the ancestor
  Hermes checkout (that climb produced 'The stable coordination lock must live outside the
  canonical checkout'); state() settles the consumer so effect rows are comparable.
  Commands (fenced bun 1.4.3, ubuntu, TMPDIR node_modules/.cache/stage3a-tmp inside the worktree):
    bun test --timeout 120000 test/put-page-vocabulary.serial.test.ts test/put-page-type-warning.test.ts
    -> 11 pass / 0 fail / 37 expect() calls / 2 files / 12.13s / exit 0
    bun run typecheck -> exit 0
  No physical-root ownership guard was weakened; no deployment, build, restart, live DB write,
  routing/grant/firebreak change or publication. No edits to /srv/minio/hermes/home/src/gbrain.

B02 — NOT implemented. No canonical sync.exclude admission guard exists in either the staging
  tree or the deployed 0.58.1.0 source for the put_page live-write path (grep of page-mutations.ts /
  page-prepare.ts in /srv/minio/hermes/home/src/gbrain at e90ad6edd found none; only the #6368
  tombstone-purge exclusion exists, page-prepare.ts:190-193 and :283-293), so B02 is new work that
  needs its own design, actual-operation tests (local/remote x live/dry) and focused commit.
  install/registry check: /srv/minio/hermes-native/.hermes/scripts/gbrain-overlay-registry.json
  carries no B01/B02 patch body to reuse.

Remaining after this checkpoint: B02 (this cohort) plus B03/B04/B05/B09/B10/B11/B12/B13/B15/
  B24/B25/B26/B27 and B23 rollout config. Stage 3 is NOT complete. This run exhausted its own
  iteration budget (24/24 for profile monchobotjr, not the ~90 assumed by the brief) before B02
  could be implemented and committed.

## Stage 3A continuation — B02 committed (task t_7686aa20, run 83, monchobot)

Isolated branch upgrade/stage3a-admission-isolated at $WT (shared staging untouched at 0f478c9e967b2373ea0ad50ee3e5beb130305bd6 unless the integration note below says otherwise).

B02 committed 66a62759177fcba913a38f0aac9b5ba7023ccb14: sync.exclude admission guard on put_page including dry run. New src/core/persistence/put-page-exclude.ts reads the persisted globs through the canonical syncExcludePatterns (comma/newline split, trimmed, trailing "/" widened to a "/**" subtree glob) and matches the lowercased slug with the walkers' own matchesAnyGlob, so write-path scope and walker scope cannot drift. Refusal is permission_denied naming the patterns; an unreadable config is logged once and lets the write through (retained logged fail-open boundary). Roots only, never pages: no existing page is removed, modified or purged, and non-matching slugs are untouched. The check runs in the shared pre-admission preflight (renamed and exported preflightPutPageAdmission) beside B01's vocabulary check, before registration/journaling and before any disk or embedding effect; the dry run reaches the same preflight through the peeled ops/put-page-dry-run.ts, so a preview refuses exactly what the live write refuses. A terminal request_id still replays its accepted intent (same treatment B01 has). Retained-scope deviation to disclose: the retained 0.58.1 fork (origin f2676d1fe / f16347062) called the guard inline in the put_page op handler; here it is one shared preflight entry for dry run and live write, with identical pre-dry-run and pre-journaling coverage. put_pages batch and capture keep upstream behavior.

Ratchet/typecheck repair committed 689a392b26916ae340ec4194cfba2467591aac10 (no behavior change): B01 had left src/core/ops/pages.ts at 685 lines against its 683 module-size ceiling, preparePageMutation at 304 lines against the 300 function-size limit, and a typecheck error (`screen.status === 'refused'` left the 'published' arm so `screen.parsed` did not exist on every arm). The put_page dry-run body moved into ops/put-page-dry-run.ts (pages.ts 675), preparePageMutation's remote protected facts/takes block moved into preserveRemoteProtectedFences (299), and canonicalPutPageContent now normalizes only an 'importable' screen, which is what it did at runtime. B01 commit 79a8a2ccac908108dc1549657d015bcc1cdf58a0 and receipt 86635643fdff24a42f652aba7e0cb236e0aeb676 are unchanged.

ACTUAL put_page operation tests, test/put-page-exclude.serial.test.ts (5 cases, no helper-only acceptance): refusal matrix local/remote x live/dry proves rejection with identical disk + 13-table DB snapshot and zero provider fetch; a control slug still commits and persists its file; excluding a root leaves the existing page, revision and file untouched; a terminal request_id replay survives a later exclusion; the guard's own failure boundary (unreadable config -> one named log line, no refusal) is sealed at the module because mocking engine getConfig on a live put_page also breaks the background persistence consumer for unrelated reasons (observed: write deadline_exceeded in refresh_roots).

Evidence, fenced Bun 1.4.3 as ubuntu, TMPDIR=/tmp/gbrain-stage3a-tmp (see the environment note):
  bun test test/put-page-exclude.serial.test.ts test/put-page-vocabulary.serial.test.ts test/put-page-type-warning.test.ts -> 16 pass / 0 fail / 66 expect() calls / 3 files / 17.70s / exit 0 (B02 alone 5 pass / 0 fail / 29 expect / 7.89s)
  bun test test/persistence-import-batch.test.ts test/pages-purge-artifact.test.ts test/fence-marker-code-context.test.ts -> 304 pass / 0 fail / 1312 expect() calls / 3 files / 24.85s / exit 0
  bun run typecheck -> exit 0 (after the ratchet repair and again after B02)
  check:module-size, check:function-size, check:windows-hide, check:layering, check:test-isolation, check:test-names, check:test-placeholders, check:newlines, git diff --check -> all exit 0
  before the ratchet repair, at 79a8a2cca: check:module-size FAIL 685 > 683; check:function-size FAIL preparePageMutation 304 > 300; typecheck exit 2 (put-page-vocabulary.ts 'published' arm).

Environment note for the next continuation (no code defect, do not "fix" by deleting markers): durable physical-root reservations exist for /srv/minio/hermes-native/.hermes (created 2026-09-20) and for this worktree /srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3a-admission (created 2026-10-12 ~19:35 by a purged/import touched-area test run whose source root climbed to the worktree git root while TMPDIR was inside the worktree). Any test whose temp root sits under either reserved path refuses in claimPhysicalRoot with recovery_required ("The stable coordination lock must live outside the canonical checkout"). That is what produced a 283 pass / 21 fail touched-area run that was byte-identical at baseline 0f478c9e9 in a detached worktree under the same TMPDIR (283 pass / 21 fail / 1194 expect) - i.e. environment, not this code. Run tests with TMPDIR outside both trees (for example /tmp/gbrain-stage3a-tmp). Also: a terminal command promoted to background inherits DATABASE_URL and the test preload refuses to start, so run test commands in the foreground.

Remaining: B03/B04/B05/B09/B10/B11/B12/B13/B15/B24/B25/B26/B27 and the B23 rollout configuration. Stage 3 is NOT complete; t_4dd80505 owns final acceptance and stays gated, t_e8aff02d releases on this task's completion. No deployment, build, service restart, live DB write, credential/routing/grant/firebreak change, publication or edit under /srv/minio/hermes/home/src/gbrain; deploy_authorized=false remains.

### Stage 3A integration onto staging (task t_7686aa20)

Integration note: shared staging /srv/minio/native/ubuntu-root-offload/gbrain-port/wt-upgrade-v060178 was clean and exactly at 0f478c9e967b2373ea0ad50ee3e5beb130305bd6 when checked; upgrade/stage3a-admission-isolated is a strict descendant, so it was fast-forwarded (git merge --ff-only) and now reads 071d7b3644c54c17249c837bbbbce45ac89e1638 with a clean worktree. Same code, re-verified at the integrated SHA in the staging worktree: bun test test/put-page-exclude.serial.test.ts test/put-page-vocabulary.serial.test.ts test/put-page-type-warning.test.ts -> 16 pass / 0 fail / 66 expect() calls / 13.12s / exit 0 (TMPDIR=/tmp/gbrain-stage3a-tmp). No rebase, reset, force or history rewrite was used; B01 79a8a2cca and receipt 86635643f are unchanged ancestors. Stage 3B (t_e8aff02d) forks from this head ("current staging SHA" at dispatch) and inherits B01/B02.

## Stage 3D — B24 + B15 + B25 + B26 committed in isolation (task t_efe12bf4, run 88)

Isolated worktree /srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3d-operator,
branch upgrade/stage3d-operator-isolated, forked from staging SHA
c08d2c167bdd6db54504872fd92447c074b6c59f. Shared staging untouched, clean, still at
that SHA. Fenced Bun 1.4.3 as ubuntu, TMPDIR=/tmp/gbrain-stage3d-tmp (outside the
reserved physical roots /srv/minio/hermes-native/.hermes and the worktrees). NOT
integrated onto staging and NOT pushed — the parent integrates serially after all
three Stage 3 cohorts report.

HEAD 105651f50 test(persistence): scoped RSS observer and intact serial persistence workloads (B26)
  33fe033de tools(codegraph): local-only disposable-brain codegraph probe + regression (B25)
  b164bb877 feat(quarantine): operator quarantine-set/rollback lane with exact-row guards (B15)
  ed1250c3a fix(serial-runner): B24 exact unsharded scheduler permutation, fail-closed shards

- ed1250c3a — B24 (committed by the crashed first run of this task, re-verified here, no
  change needed). Lane-aware membership: UNSHARDED (1/1) requires the scheduler's stdout to
  be an exact permutation of the discovered pool — missing, unexpected or duplicated entries
  fall back to deterministic discovery order with a loud warning (refusing would drop the
  whole lane); SHARDED honors a successful EMPTY shard and fails the run CLOSED on scheduler
  failure, because the fallback there would run the whole corpus inside one shard; bad
  weights stay advisory in both lanes via --fallback-on-error. Contract test runs the real
  script in a sandbox against a stubbed `bun scripts/sharding.ts`.
- b164bb877 — B15 operator quarantine-set/rollback lane. Ported (origin fc1f16d0a,
  ab677151f, 25705e88e, flag registry 8902d5e63) as NEW code fitted to the v0.60.178
  contracts; 101 changed lines against the 666-line retained file, the bulk being the
  executeRawJsonb raw-object binding that fixes the postgres.js `$N::jsonb` double-encode
  (#2339) that PGLite masks. Manifest identity gates (id, slug, source_id, content_hash,
  source_path under a real source root; rejections named, never silently skipped), FOR UPDATE
  capture, guarded affected-row count, projection-job snapshot/reseal/orphan-seal, set-based
  reversible rollback, private 0600 snapshot archived with its sha256, managed-persistence
  refusal up front AND at the core mutation boundary, thin-client host-bound hint, regenerated
  flag registry. `gbrain quarantine set|rollback` are new subcommands.
- 33fe033de — B25 local-only disposable-brain codegraph probe + a regression that runs the
  real tool as a subprocess over a two-file fixture and pins source-qualified provenance
  (every attributed caller edge carries from_slug; beta/alpha edges land on the alpha.ts page,
  the entry() edge on beta.ts) plus the native code_callers/code_blast answers.
- 105651f50 — B26 scoped RSS observer: `observeRss` injection + pure `observeResidentMemory`
  (unavailable-sample count and measured peak kept per workload; only Bun's known
  `Failed to get memory usage` is tolerated, every other error propagates), which removes the
  process-global `spyOn(process, 'memoryUsage')` that could contaminate later tests in the
  same process. Both ORIGINAL full PGLite workloads (4 pages, 200 queries per phase, 1 writer,
  writesPerWriter 100, unchanged 60 s bound) are retained in the new serial file; upstream
  harness.samplePeakRss is untouched and still used by scripts/persistence/worker.ts.

Evidence at HEAD 105651f50 (fenced Bun 1.4.3, ubuntu, TMPDIR outside all reserved roots):

    bun test --timeout 300000 test/operator-quarantine-set.serial.test.ts \
      test/persistence-rss-workload.serial.test.ts test/persistence-performance.test.ts \
      test/codegraph-probe.test.ts test/scripts/serial-files.test.ts \
      test/scripts/serial-runner-scheduler-contract.test.ts
    -> 57 pass / 0 fail / 721 expect() calls / 6 files / 66.65s / exit 0
       (per file at its own commit: B15 24 pass / 0 fail / 156 expect / 15.04s;
        B24 contract 6 pass / 0 fail / 20 expect; B25 2 pass / 0 fail / 16 expect / 21.77s;
        B26 serial 2 pass / 0 fail / 25 expect / 45.74s; B26 fast lane 12 pass / 0 fail /
        68 expect / 3.08s; serial manifest 11 pass / 0 fail / 426 expect)
    bun run typecheck -> exit 0
    check:module-size, check:function-size, check:windows-hide, check:layering,
    check:test-isolation, check:test-names, check:test-placeholders, check:newlines,
    git diff --check -> all exit 0

Honest boundaries and disclosures:

1. test/e2e/operator-quarantine-postgres.test.ts is DATABASE_URL-gated and was NOT executed
   (no disposable Postgres probe DB is authorized in this cohort). Real-Postgres engine parity
   stays a later-stage gate with the whole-candidate matrix, compiled caller, migration
   rehearsal and live acceptance. Do not read the green PGLite-oracle serial suite as Postgres
   parity.
2. Manifest repair disclosed: the frozen base c08d2c167 FAILS test/scripts/serial-files.test.ts
   (11 tests, 1 fail) because four serial files added by earlier Stage 3 cohorts
   (test/multi-source-drift-compiled.serial.test.ts, test/put-page-exclude.serial.test.ts,
   test/put-page-vocabulary.serial.test.ts, test/search/quarantine-exact-slug-hybrid.serial.test.ts)
   had no row in scripts/serial-files.tsv. Those four rows plus the new operator-quarantine
   serial file are registered in b164bb877, which is why that commit also touches the manifest.
   Nothing else in it is a repair; the manifest guard is green from b164bb877 onward.
3. The crashed first run (run 86, SIGTERM during `bun test test/codegraph-probe.test.ts`)
   left one uncommitted assertion that cannot hold: `every(from_slug.endsWith('alpha'))` —
   probe slugs are `<root>-alpha-ts`, and the transitive walk legitimately includes the
   beta.ts caller `entry()`. Corrected to per-caller provenance assertions, then committed.
4. b164bb877 and 33fe033de are re-authored SHAs of the crashed run's local B15/B25 work. No
   retained history was rewritten: origin fc1f16d0a/ab677151f/25705e88e/8902d5e63 (and every
   official/upstream commit) are unchanged ancestors, and the port is new code, not a
   wholesale copy.
5. No deployment, build, service restart, live DB write, routing/credential/grant/firebreak
   change, publication or edit under /srv/minio/hermes/home/src/gbrain in this cohort;
   deploy_authorized=false stands. Dependency lifecycle was never run against the deployed
   gbrain in this cohort.

Exact remaining Stage 3 inventory for the original owner (t_4dd80505): runtime B03, B04, B05,
B09, B10, B11, B12, B13, B27 (B01/B02 landed in Stage 3A; B06/B07/B08/B14/B16/B17 in the
Stage 3 behavior cohort), plus the B23 = 30000 ms drift-budget rollout configuration. Tooling
B15/B24/B25/B26 are committed on upgrade/stage3d-operator-isolated only. Stage 3 is NOT
complete and Stage 4 stays dependency-gated.

Handoff: upgrade/stage3d-operator-isolated is a strict descendant of c08d2c167 and contains
no Stage 3B/3C work, so it integrates independently; the parent must recheck staging's HEAD
and clean status before fast-forward or cherry-pick (the three cohorts diverge from the same
base).

## Stage 3D integration onto staging — done by the parent (orchestrator), ahead of the merge point

Staging precondition checked: HEAD was exactly c08d2c167bdd6db54504872fd92447c074b6c59f with a
clean worktree, and upgrade/stage3d-operator-isolated was a strict descendant, so `git merge
--ff-only` applied with no rebase, reset, force or history rewrite. Staging HEAD is now
29d534148 ("docs(upgrade): record Stage 3D B15/B24/B25/B26 commits and verification"); all five
Stage 3D commits (ed1250c3a B24, b164bb877 B15, 33fe033de B25, 105651f50 B26, 29d534148 receipt)
entered as unchanged ancestors. Worktree clean after the merge.

Why integrated early: the remaining Stage 3 cohorts have repeatedly stopped on iteration
budgets, and five finished, verified commits sitting on a branch are exactly the work most at
risk of being re-derived. Integration is additive and does not touch 3B/3C worktrees.

Parent re-verification AT the integrated SHA 29d534148 (not a re-run of the cohort's own claim):

    bun test --max-concurrency=4 --timeout 300000 test/operator-quarantine-set.serial.test.ts \
      test/persistence-rss-workload.serial.test.ts test/persistence-performance.test.ts \
      test/codegraph-probe.test.ts test/scripts/serial-files.test.ts \
      test/scripts/serial-runner-scheduler-contract.test.ts
    -> 57 pass / 0 fail / 721 expect() calls / 6 files / 100.97s / exit 0
    bun run typecheck -> rc=0, zero "error TS" lines
    check:module-size, check:function-size, check:layering, check:test-isolation,
    check:test-names, check:test-placeholders -> all exit 0
    git status --porcelain -> 0 lines

Matches the cohort's recorded 57/0/721 exactly. `--max-concurrency=4` was used deliberately:
every Hermes worker runs in a hard 4 GiB cgroup
(tools/process_registry._WORKER_MEMORY_MAX_CAP_BYTES) and `bun test` defaults to 20 concurrent
tests, which is what OOM-killed this cohort's first run.

Still open from Stage 3D and NOT resolved by this integration: test/e2e/operator-quarantine-postgres.test.ts
is DATABASE_URL-gated and has still never been executed; real-Postgres engine parity remains a
later-stage gate and the green PGLite-oracle serial suite must not be read as parity.

Integration order note for t_4dd80505: staging has advanced past c08d2c167, so upgrade/stage3b-retrieval-isolated
and upgrade/stage3c-extraction-isolated are no longer fast-forwardable and will need cherry-pick
(or a rebase onto 29d534148) when they report. The manifest rows added by b164bb877 are additive;
expect them to be the most likely conflict site if 3B/3C also register serial files.
