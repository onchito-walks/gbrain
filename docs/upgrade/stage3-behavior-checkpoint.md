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
