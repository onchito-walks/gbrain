# Stage 3C — extraction refusal & quarantine hardening: acceptance receipt (task t_7e96fdd1)

Status: **cohort complete, NOT integrated.** B11, B12 and B13 are implemented,
tested and committed on the isolated branch `upgrade/stage3c-extraction-isolated`.
Stage 3 as a whole is **not** complete (behaviors owned by other cohorts remain);
Stage 4 stays gated; `t_4dd80505` owns final Stage 3 acceptance. Integration onto
the shared staging branch is **owed to the parent** — see the handoff below.

This receipt supersedes the "B13 NOT implemented" status in
`docs/upgrade/stage3c-extraction-checkpoint.md`.

## Isolation

- Worktree: `/srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3c-extraction`
- Branch: `upgrade/stage3c-extraction-isolated`, forked from staging HEAD
  `c08d2c167bdd6db54504872fd92447c074b6c59f` (clean at fork time).
- The shared staging worktree `/srv/minio/native/ubuntu-root-offload/gbrain-port/wt-upgrade-v060178`
  was read only: `git rev-parse HEAD`, `git status --short`, `git log`,
  `git diff --stat`, `git merge-tree`. No checkout, reset, rebase, fast-forward,
  force or push was performed on it.
- `node_modules` here is a symlink to the staging worktree's installed tree
  (same lockfile, same revision): no `bun install` was run, so no dependency
  lifecycle or migration could fire.
- No deployment, build, service restart, live DB write, credential / routing /
  grant / firebreak change, publication, or edit under
  `/srv/minio/hermes/home/src/gbrain`. `deploy_authorized=false` remains.

## Commits on the branch

| Behavior | Commit | Subject |
|---|---|---|
| B11 | `d04dd23f2` | fix(extract_atoms): refuse an unpriced chat/embed route under the default cap too |
| B12 | `89a6eeec3` | feat(extract_atoms): quarantine filter in discovery/backlog + fail-closed execution-boundary re-check |
| (docs) | `3b6a5970d` | Stage 3C checkpoint — B11/B12 committed, B13 open |
| B13 | `80f586b07` | feat(extract_atoms): a refused drain batch is a visible retryable stop, not a false-green |

Head: `80f586b072e19ab12935042b473d0ac49f86ec1a`.

## B13 — the behavior, and the defect it removes

The drain adapter (`runExtractAtomsDrainForSource`) derived `providerFailure`
from `failures.length > 0 && itemsSucceeded === 0`. Both refusal shapes added by
B11/B12 return an EMPTY `failures` array:

- B11 unpriced cost gate -> `status: 'warn'`, `details.reason: 'no_pricing'`,
  `atoms_extracted: 0`, `failures: []`, no `pages_skipped_budget`;
- B12 fail-closed quarantine re-check -> `blocked: true`,
  `blocked_reason: 'quarantine_recheck_failed'`, `failures: []`.

Neither latched anything, so both fell through to the ordinary zero-progress
branch: the drain recounted an unchanged backlog and returned
`status: 'ok'` / `stopped: 'no_progress'` — the durable Minion job completed, the
CLI exited 0, and the backlog was never touched. That is the false-green B13
removes. (The B11 refusal also sets `budget_exhausted: true` on its native
`no_pricing` receipt, which is precisely why that flag cannot be used as the
discriminator: it would conflate an expected cap with an outage, and would also
sweep in the ordinary budget-skip path.)

What changed (`src/core/cycle/extract-atoms-drain.ts`,
`src/core/minions/handlers/extract-atoms-drain.ts`, `src/commands/dream.ts`):

1. `DrainStop` gains `'blocked'`; `ExtractAtomsDrainResult.status` gains
   `'blocked'` and the result gains `blocked_reason` (present exactly when
   blocked). The pure loop latches the refusal, **breaks after that one batch**
   (the same hot-loop guard `providerFailure` uses, so a refusal cannot spin),
   and the final recount can no longer downgrade it to `'drained'`.
2. `deriveExtractAtomsBatchOutcome(details)` is a new exported PURE classifier:
   `details.blocked === true || details.reason === 'no_pricing'` -> blocked
   batch. It deliberately does **not** key off `budget_exhausted`. The native
   expected-budget stop (`pages_skipped_budget > 0` -> `stopped: 'budget'`,
   `status: 'ok'`, spend + cap reported) is untouched.
3. `formatDrainBlockedRefusal()` is its own message — never the provider-outage
   text — so the operator is not sent hunting an outage that never happened.
   The Minion handler throws it: plain `Error` before the job deadline,
   `UnrecoverableError` past it, so the durable job retries under its ordinary
   bounded attempt/backoff policy and dead-letters when exhausted instead of
   completing. `dream --drain` names the refusal on stderr ("this is a refusal,
   not a provider outage") and still exits 11 with a `resume_command`.

Deliberately NOT done, per the program constraints: no GO-subscription dollar
gate, no routing/credential change to silence a warning, and no claim that a
list-rate equivalent is an invoice charge.

## Verification (all at head `80f586b07`, ubuntu, fenced Bun `1.4.3`,
`TMPDIR=/tmp/gbrain-stage3c-tmp`, commands run in the FOREGROUND)

| Command | Result |
|---|---|
| `bun test --timeout 120000 --max-concurrency=1 test/extract-atoms-drain-blocked-refusal.test.ts` | 13 pass / 0 fail / 57 expect / 1 file / 4.51s / rc=0 |
| `bun test --timeout 120000 --max-concurrency=1 test/extract-atoms-drain-blocked-refusal.test.ts test/extract-atoms-drain.test.ts test/extract-atoms-drain-handler.test.ts` | 38 pass / 0 fail / 131 expect / 3 files / 12.90s / rc=0 |
| `bun test --timeout 180000 --max-concurrency=2 test/extract-atoms-drain-stops.test.ts test/extract-atoms-drain-errors.test.ts test/extract-atoms-drain-structural.test.ts test/extract-atoms-drain-attempt.test.ts test/extract-atoms-drain-wait.test.ts` | 35 pass / 0 fail / 133 expect / 5 files / 23.87s / rc=0 |
| `bun test --timeout 180000 --max-concurrency=2 test/cli-exit-drain.test.ts test/managed-atoms-retry.test.ts test/extract-atoms-quarantine.test.ts test/extract-atoms-embed-cost-gate.test.ts test/extract-atoms-explicit-cap-no-pricing.test.ts` | 35 pass / 0 fail / 202 expect / 5 files / 22.30s / rc=0 |
| `bun test --timeout 180000 test/dream-drain-failure-summary.serial.test.ts` (serial file, run ALONE) | 16 pass / 0 fail / 55 expect / 1 file / 4.24s / rc=0 |
| `bun test --timeout 180000 --max-concurrency=2 test/dream.test.ts test/dream-failed-phase-exit.test.ts test/dream-clean-status-skip-visibility.test.ts` | 60 pass / 0 fail / 302 expect / 3 files / 21.95s / rc=0 |
| `bun run typecheck` | rc=0 (6m41s; log `/tmp/gbrain-stage3c-tmp/typecheck-b13.log`) |
| `check:module-size`, `check:function-size`, `check:windows-hide`, `check:layering`, `check:test-isolation`, `check:test-names`, `check:test-placeholders`, `check:newlines`, `check:weight-coverage`, `check:test-env-opt-ins`, `git diff --check` | all rc=0 |

`build`, `restart`, deployment, live-DB writes and publication were NOT run (out
of scope for this task). `test/e2e/operator-quarantine-postgres.test.ts` is
DATABASE_URL-gated and remains unexecuted by every cohort; nothing here claims
PostgreSQL engine parity.

### B13 test coverage — what is actually exercised

`test/extract-atoms-drain-blocked-refusal.test.ts` (new, 13 cases):

- pure loop: a blocked batch latches `status`/`stopped`/`blocked_reason`, runs
  exactly ONE batch with an unchanged backlog, survives a zero final recount,
  names the reason `blocked` when the adapter supplied none, prefers the refusal
  arm when a batch reports blocked + providerFailure together, and leaves the
  native budget stop as `status: 'ok'` / `stopped: 'budget'` with spend;
- pure classifier: both refusal shapes map, `budget_exhausted` /
  `pages_skipped_budget` / `no_work` / `blocked: 'yes'` / `undefined` do not;
- formatter: the refusal text names the refusal, never "provider calls failed",
  drops "retrying" when final, and returns null for a non-blocked run;
- **the real control path**: an eligible page against an unpriced extraction
  route, driven through the real per-source cycle lock
  (`gbrain-cycle:default`), the real phase, the real adapter and the real Minion
  handler — asserting zero chat calls, `status: 'blocked'`, `reason: no_pricing`,
  an unchanged page count, a retryable `Error` (not `UnrecoverableError`) before
  the deadline, `UnrecoverableError` past it, and a free source lock afterwards.

`test/dream-drain-failure-summary.serial.test.ts` additionally pins the CLI
blocked stop: the refusal and its reason ride the `--json` payload, the run
exits 11 (never 0), stderr names the refusal, and the provider-outage text is
absent. That file's module stub now spreads the REAL module and overrides only
`runExtractAtomsDrainForSource`, so it can no longer drift from the pure helpers
`dream.ts` calls.

## Integration handoff (parent action — NOT performed here)

The parent's concurrency notice forbids this cohort from touching the shared
staging worktree, and the task's integration precondition ("clean **unchanged**
staging") no longer holds: staging advanced while this cohort worked.

- Staging is now at `b51c8ba64ab840159b1451956f0843fa43ad897a` (clean), which
  includes the Stage 3D fast-forward integration (`ed1250c3a` B24,
  `b164bb877` B15, `33fe033de` B25, `105651f50` B26, `29d534148`/`b51c8ba64`).
- This branch's base is the older `c08d2c167`, so it is **not** a strict
  descendant of staging and cannot be fast-forwarded. The parent's own note
  already predicts exactly this for 3B and 3C.
- The merge is textually clean and provably conflict-free:
  `git merge-tree --write-tree b51c8ba64ab840159b1451956f0843fa43ad897a upgrade/stage3c-extraction-isolated`
  -> rc=0, tree `b254e243728b2ccd3c189b028f317250f3f2a28b`.
- **Zero file overlap** with the 3D integration: `git diff --name-only c08d2c167..b51c8ba64`
  contains none of `src/core/cycle/extract-atoms-drain.ts`,
  `src/core/minions/handlers/extract-atoms-drain.ts`,
  `src/commands/dream.ts`, or either test file. This cohort also touched **no**
  `scripts/serial-files.tsv` row and **no** manifest row, so the conflict site
  the parent flagged for 3B/3C does not apply to 3C.
- To integrate: cherry-pick (or rebase) `d04dd23f2`, `89a6eeec3`, `3b6a5970d`,
  `80f586b07` onto the then-current staging HEAD, then re-run the focused set on
  the integrated SHA. A plain merge of the branch onto staging is equally clean.

## Environment notes for the next continuation (no code defect)

- **4 GiB worker cgroup.** One heavy command at a time; bound every multi-file
  `bun test` (`--max-concurrency=2`..`=4`). `bun run typecheck` alone took 6m41s
  here and is one concurrent test run away from an OOM kill.
- **Serial files must not share a process with other test files.** Running
  `test/dream-drain-failure-summary.serial.test.ts` in the same `bun test`
  invocation as `test/managed-atoms-retry.test.ts` fails the latter with
  `expect(f.calls()).toBe(1)` / received 0 — that file calls
  `mock.module('../src/core/cycle/extract-atoms-drain.ts', ...)`, which replaces
  the module process-wide and stubs the real drain loop out from under the other
  file. It passes alone and when run through the serial runner. This is
  pre-existing (the reason the file is `.serial`), not caused by B13; the
  failure was reproduced identically at `--max-concurrency=2` and `=1`, and the
  same 5-file set passes once the serial file is removed from the batch.
- A temp root under `/srv/minio/hermes-native/.hermes` or under a reserved
  worktree makes `claimPhysicalRoot` refuse with `recovery_required`. Keep
  `TMPDIR` outside both (e.g. `/tmp/gbrain-stage3c-tmp`).
- A terminal command promoted to background inherits `DATABASE_URL` and the test
  preload then refuses to start: run test commands in the FOREGROUND.

## Exact program state after this cohort

Integrated into the shared staging branch by this task: **nothing** (isolation
rule; integration is owed to the parent).

This cohort's scope (B11/B12/B13): **all three implemented, tested, committed,
not yet integrated.**

Still unfinished across Stage 3 (read from the shared
`docs/upgrade/stage3-behavior-checkpoint.md` at `b51c8ba64`; 3B's state is that
cohort's to report, not this one's to assert):

- Runtime: `B03`, `B04`, `B05`, `B09`, `B10`, `B27` (Stage 3B cohort,
  `upgrade/stage3b-retrieval-isolated`).
- Configuration: `B23` (rollout-owned value, per Stage 2).
- Stage 3D's open item, unresolved by its integration:
  `test/e2e/operator-quarantine-postgres.test.ts` is DATABASE_URL-gated and has
  never been executed; real-Postgres engine parity stays a later-stage gate.
- Later-stage gates unchanged: whole-candidate matrix, PostgreSQL E2E, compiled
  caller, migration rehearsal, live acceptance.

`deploy_authorized=false` remains. Stage 4 (`t_70f96b71`) stays dependency-gated;
`t_4dd80505` owns final Stage 3 acceptance.
