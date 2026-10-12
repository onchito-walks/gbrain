# Stage 2 — drift overlay acceptance

Task: t_3b368cdd. Stage 2 implementation and focused acceptance complete; not whole-candidate acceptance or deployment approval.

## Revision and integration

Frozen official base: 0460af288227a193c2031eca2e6a64f808cbd8bd (v0.60.178.0).
Inventory-bearing starting SHA: b435967411dfabf1af099bf58253d8d4de6af632.
Existing reviewed overlay 818dc93edd26e7c0c7afc0313f6f08b5f3845e8f was already in this Git object database: no bundle was needed.
Isolated implementation worktree: /srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage2-drift, branch upgrade/stage2-drift-isolated.
Integrated by clean fast-forward onto /srv/minio/native/ubuntu-root-offload/gbrain-port/wt-upgrade-v060178, branch upgrade/official-v060178-reconciled. Stage 1 inventory preserved.

Commits:
- 5f6aa6d0b: reviewed cherry-pick of existing drift/identity overlay.
- f1086df96673d271354986bd1272131b9c645ad0: close null-engine, managed-policy deadline, invalid environment budget and native admission gaps; repair process import and typed fixtures.
- 47f2e294ef4a1ce685526945ae4f3610d284bd28: bootstrap marketplace parser correction with discriminating colon-path regression.

B20/B21/B22 integrated: one bounded verifier across roster, managed policy, config, Git discovery, filesystem and batched database reads; global file limit; persisted identity and sync eligibility; explicit incomplete coverage and authorized default-source comparison. Uses native sync classifiers, slug-root pin resolution, markdown hold classifier and process wrapper rather than copying the old deployed module wholesale. Retains upstream #5432 warning rendering and #5862/#6060 Git-root behavior; repo-top, nested, symlink and source-root controls all pass.
B23 remains configuration: inherit GBRAIN_DRIFT_TIMEOUT_MS=30000 with caller override precedence; do not set production environment in this stage. Explicit invalid environment budgets now report unknown rather than silently falling back.

## Actual acceptance at code SHA 47f2e294ef4a1ce685526945ae4f3610d284bd28

Bun: /srv/minio/native/ubuntu-root-offload/gbrain-port/toolchains/bun-v1.4.3/bun-linux-aarch64/bun, observed 1.4.3.
Run as ubuntu, not root; real unreadable-root and unreadable-subdirectory permission checks executed (not skipped).

Command:
`bun test test/multi-source-drift.test.ts test/multi-source-drift-coverage.test.ts test/doctor-not-verified-5432.test.ts test/bootstrap-tag-colon-path.test.ts test/check-bootstrap-guards.test.ts`

On isolated worktree: 105 pass, 0 fail, 297 expectations across 5 files, 29.02s, exit 0.
Repeated on staging checkout: 105 pass, 0 fail, 297 expectations across 5 files, 29.05s, exit 0.
These totals include bootstrap guard and other upstream #5432 cases; they are not 105 drift-only cases.

Also exit 0 on staging: `bun run typecheck`, `bun run check:windows-hide`, `bun run check:bootstrap-tag`, `bun run check:module-size`, `bun run check:function-size`, `git diff --check`.
Typecheck uses the repository's tsc command with its local node_modules cache. No module/function ceiling raised; no guard disabled.
Attempted `bun run check:core-imports` earlier: script does not exist; not counted as a pass or a required gate.

Coverage exercised: missing and unreadable roots, nested unreadable directories, readable empty roots, invalid YAML/ambiguous identity, slug and persisted-path collisions, unsupported strategy, configuration and roster failure, database lookup failure, engine-null local report, actual buildChecks and doctorReportRemote database-error paths, partial Git skips, exhausted/global/exact-final limits, stuck DB/managed-policy reads, invalid budgets, environment inheritance, override precedence and unauthorized comparison scope. Native malformed-path exclusion is explicit zero-candidate eligibility, not claimed verification of an excluded file.

Bootstrap fixture failed before the parser edit (expected exit 0, observed exit 1). After correction it accepts sanctioned refs in colon-containing paths with Markdown tails and rejects an unsanctioned ref even when another valid ref shares its line. Official README/INSTALL/CODEX pins were valid in a colon-free path; documentation was not rewritten.

## Limits and operational mistake

No full matrix, PostgreSQL E2E execution, compiled CLI execution, release build, migration rehearsal, publication, deployment or service restart. Imported PostgreSQL/compiled regression files remain later-stage gates, not passes from this run. Deadline bounds waiting, not cancellation of an engine read.

Dependency installs ran `bun install --frozen-lockfile`. The isolated install's lifecycle shell resolved old Bun 1.3.14, so postinstall refused before migration execution. The later staging install had fenced Bun on PATH; upstream scripts/postinstall.ts resolved installed gbrain and invoked `apply-migrations --yes --non-interactive`. This was an unintended live command outside the stage's no-production-write boundary. Output reported installed 0.58.1.0, migrations already up to date, migration v0.53.0 mechanical checks complete with host action pending, and no grants or bundle consent changes. Checkpoint/receipt mutation was not independently verified; do not claim this run made no production database writes. No attempt was made to reset or erase receipts. Prevent this in later installs with the existing supported `GBRAIN_UPGRADE_OWNS_MIGRATIONS=1` environment setting (postinstall.ts lines 50–55), keeping installation itself local.

## Next stage

Stage 3 carries B01–B17 and B27 plus separately scoped tooling B24–B26; do not re-port the completed B20–B22 overlay. B18/B19 remain upstream-equivalent, not separate patches. Set required B23 runtime environment only at authorized rollout. Preserve deploy_authorized=false until remaining behavior acceptance, migration rehearsal, complete gates and actual-caller acceptance close. Reuse the installed updater/registry machinery; this stage did not repoint its overlay registry.
