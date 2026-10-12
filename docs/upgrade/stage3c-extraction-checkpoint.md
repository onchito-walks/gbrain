# Stage 3C continuation — extraction refusal + quarantine hardening (task t_7e96fdd1)

Status: PARTIAL. B11 and B12 are implemented, tested and committed on an isolated
branch. **B13 is NOT implemented.** Stage 3 is NOT complete; Stage 4 stays gated;
t_4dd80505 still owns final Stage 3 acceptance.

## Isolation (per the parent's concurrency notice)

- Worktree: `/srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3c-extraction`
- Branch: `upgrade/stage3c-extraction-isolated`, created with
  `git worktree add -b upgrade/stage3c-extraction-isolated <path> c08d2c167bdd6db54504872fd92447c074b6c59f`
  (fork base = staging HEAD, which was clean at that moment).
- Shared staging `/srv/minio/native/ubuntu-root-offload/gbrain-port/wt-upgrade-v060178`
  was **read only** for inspection (`git status --short` empty, branch
  `upgrade/official-v060178-reconciled`, HEAD `c08d2c167bdd6db54504872fd92447c074b6c59f`).
  No checkout, reset, fast-forward, rebase, force or push was performed on it, and
  per the parent's hard rule the cohort did **not** integrate onto staging.
  **Integration is still owed to the parent.**
- No deployment, build, service restart, live DB write, credential/routing/grant/
  firebreak change, publication, or edit under `/srv/minio/hermes/home/src/gbrain`.
- `node_modules` in this worktree is a **symlink** to the staging worktree's
  installed tree (same lockfile, same revision) — no `bun install` was run, so no
  dependency lifecycle/migration could fire. If the parent wants a real install,
  use fenced Bun 1.4.3 with `GBRAIN_UPGRADE_OWNS_MIGRATIONS=1`.

## Commits on the branch

| Behavior | Commit | Subject |
|---|---|---|
| B11 | `d04dd23f2` | fix(extract_atoms): B11 refuse an unpriced chat/embed route under the default cap too |
| B12 | `89a6eeec3` | feat(extract_atoms): B12 quarantine filter in discovery/backlog + fail-closed execution-boundary re-check |
| B13 | *(none)* | NOT implemented |

Disclosure: B11 was first committed as `820bd7112` with an unconditional gate. Running the
wider extract-atoms suite then surfaced (a) upstream `test/extract-atoms-explicit-cap-no-pricing.test.ts`
case `default extract_atoms cap + unpriced model > warns and runs (#5825)`, which asserts the old
default-cap behavior, and (b) that the gate is shared with the Life Chronicle phase
(`src/core/cycle/chronicle.ts`, `src/core/chronicle/job.ts`), whose default-cap "warns and runs,
spend marked unpriced" behavior is deliberate and tested. Both were resolved before finalizing
B11, which was then **amended** to `d04dd23f2` (same isolated branch, unpushed; `820bd7112` no
longer exists as an ancestor). The B11 body now scopes the refusal to extract_atoms through a new
`unpricedPolicy: 'refuse' | 'uncapped'` option, with chronicle explicitly choosing `'uncapped'`.

## B11 — unpriced chat/embed refusal + truthful accounting (`d04dd23f2`)

Change: `resolveExtractAtomsCostGate` no longer drops the default cap for an unpriced billable
route. An unpriced chat **or** embed model under a default cap now refuses exactly as it already
did under an operator cap: zero model calls, the native `no_pricing` guidance, and the same
doctor-visible receipt (`cycle.extract_atoms.no_pricing.<source>` + the expected-limit rollup).
`explicitBudget` no longer decides whether it refuses — it only labels which cap was
unenforceable via the new gate field `unpricedCapSource` (carried into the receipt and the phase
details as `cap_source`), so neither the message nor the doctor record implies the operator set a
cap. Rationale recorded in the code: an uncapped run still sends the unpriced call, and
`BudgetTracker.record()` adds nothing for an unpriced served model, so the phase's
`estimated_spend_usd` would read like "$0 — this route is free". No new spend ceiling, no
routing/credential change, no list-rate-as-invoice claim; `pricing.overrides` (0 only for
something that genuinely costs nothing) restores the cap and clears the receipt.

Evidence (fenced Bun 1.4.3, ubuntu, `TMPDIR=/tmp/gbrain-stage3c-tmp`):

```
bun test --timeout 120000 test/extract-atoms-embed-cost-gate.test.ts
  -> 13 pass / 0 fail / 51 expect() calls / 1 file / 11.37s / exit 0
bun test --timeout 120000 test/extract-atoms-explicit-cap-no-pricing.test.ts \
  test/extract-atoms-embed-cost-gate.test.ts test/chronicle-auto-phase.test.ts
  -> 39 pass / 0 fail / 156 expect() calls / 3 files / 101.48s / exit 0
```

The `#5825` case was rewritten (tightened), not deleted: it now asserts the refusal — 0 chat
calls, 0 atoms, `reason: no_pricing`, `cap_source: 'default'`, the recorded receipt and
`{halt:0, expected:1, completed:0}` instead of the old 1 call / 1 atom. A new pure case pins
chronicle's `unpricedPolicy: 'uncapped'` contract. Guards at the amended tree: check:module-size,
check:function-size, check:windows-hide, check:layering, check:test-isolation, check:test-names,
check:test-placeholders, check:newlines, `git diff --check` — all exit 0.

## B12 — quarantine filter + fail-closed execution-boundary re-check (`89a6eeec3`)

- Selection: `discoverExtractablePages` and `countExtractAtomsBacklog` (scoped and brain-wide)
  carry `quarantineFilterFragment('p')` — the same fragment the search/doctor paths use — so a
  quarantined page is never an extraction candidate and the phase's `remaining` agrees with
  doctor's own backlog number.
- Execution boundary: new `src/core/cycle/extract-atoms-quarantine.ts` re-checks the listed page
  batch in ONE query, drops the pages that were quarantined between listing and execution,
  and FAILS CLOSED when the re-check cannot be answered (status `skipped`, `blocked: true`,
  `blocked_reason: 'quarantine_recheck_failed'`, zero model calls for pages **and** transcripts).
  The refusal claims no cap (`budget_usd: null`, because it runs before the cost gate resolves
  `cycle.extract_atoms.budget_usd`) and deliberately does not set `budget_exhausted`, so a refusal
  can never be read as a cap stop. Read-only: no writes, no lock of its own (the caller already
  holds the source's cycle lock), and the managed atom session/writer is untouched.
- Details gain `pages_excluded_quarantined`; `pages_total` and the summary count only the pages
  the phase actually considered.
- Move-only peel: the dual-source merge (type + dedup + page-first interleave, comment included)
  moved unchanged to `src/core/cycle/extract-atoms-work.ts`, which keeps `runPhaseExtractAtoms`
  inside its function-size row while the re-check adds its call site. No module-size ceiling edit
  was needed (`extract-atoms.ts` measures 1646 <= its committed 1654 ceiling).

Evidence (same toolchain/TMPDIR):

```
bun test --timeout 120000 test/extract-atoms-quarantine.test.ts
  -> 9 pass / 0 fail / 38 expect() calls / 1 file / 14.43s / exit 0
bun test --timeout 120000 [test/extract-atoms-page-discovery.test.ts,
  test/extract-atoms-unpriced-model.test.ts,
  test/extract-atoms-explicit-cap-no-pricing.test.ts,
  test/extract-atoms-embed-cost-gate.test.ts,
  test/extract-atoms-quarantine.test.ts,
  test/cycle/extract-atoms-work-interleave.test.ts,
  test/doctor-extract-atoms-backlog.test.ts, test/cycle/extract-atoms-batch.test.ts,
  test/cycle/extract-atoms-reconcile.test.ts, test/eval-v041_2-scaffolds.test.ts]
  -> 92 pass / 0 fail / 309 expect() calls / 10 files / 52.05s / exit 0
  (the 1 failure in the first pass of this set was the #5825 expectation fixed by B11)
```

`check:module-size` and `check:function-size` exit 0 at this commit.

## B13 — NOT implemented (the remaining gap in this cohort)

Required behavior: a blocked extraction drain (unpriced cost gate / fail-closed quarantine
re-check) must become a **visible retryable failure instead of a false-green**, while the native
expected-budget stop stays distinguishable from a provider outage, with no unbounded hot retry.

Why it is still open, precisely:

- The upstream drain adapter (`src/core/cycle/extract-atoms-drain.ts`,
  `runExtractAtomsDrainForSource`) derives `providerFailure` from
  `failures.length > 0 && itemsSucceeded === 0`. The B11 refusal returns `status: 'warn'` with
  `reason: 'no_pricing'`, `atoms_extracted: 0`, `failures: []` and no `pages_skipped_budget`, and
  the B12 refusal returns `blocked: true` with `failures: []`. **Both therefore fall through to
  the zero-progress path: the drain recounts an unchanged backlog and completes `status: 'ok'` /
  `stopped: 'no_progress'` — the false-green B13 exists to prevent.**
- Planned change (designed, not written): add a `'blocked'` member to `DrainStop` and to
  `ExtractAtomsDrainResult.status`, plus `blocked_reason`; latch it in the pure loop (break after
  one batch — same hot-loop guard as `providerFailure`); export a pure
  `deriveExtractAtomsBatchOutcome(details)` classifier used by the adapter that maps
  `details.blocked === true || details.reason === 'no_pricing'` to the blocked batch (and must NOT
  key off `budget_exhausted`, which the native `no_pricing` receipt sets to true — that is exactly
  the "expected stop vs outage" conflation to avoid); and handle `status === 'blocked'` in
  `src/core/minions/handlers/extract-atoms-drain.ts` so the durable job retries (plain `Error`
  before the deadline, `UnrecoverableError` past it) with a refusal-specific message rather than
  the provider-outage text. Needed because both refusal shapes also set `blocked_reason`/`reason`
  that a consumer must be able to tell apart from a real outage, and the budget-skip path
  (`pages_skipped_budget > 0` -> `stopped: 'budget'`, `status: 'ok'`) must stay untouched.
- Not started because this run reached its iteration budget (~90 tool calls) after B11/B12.

## Environment notes for the next continuation

- Run tests with `TMPDIR` outside the reserved trees (`/tmp/gbrain-stage3c-tmp` worked). A temp
  root under `/srv/minio/hermes-native/.hermes` or under a worktree whose git root is reserved
  makes `claimPhysicalRoot` refuse with `recovery_required`. Do not delete those reservations.
- A terminal command promoted to background inherits `DATABASE_URL` and the test preload refuses
  to start even after `unset DATABASE_URL` in the script; run test commands in the **foreground**
  (batches of files that fit the ~180s foreground window), or set
  `GBRAIN_TEST_ALLOW_DATABASE_URL=1` deliberately.
- Foreground command windows observed at ~180s in this session regardless of the requested
  timeout; longer suites must be split.
- `bun run typecheck` on a cold tree takes ~6-10 minutes here. Result on the **final** tree
  (B11 `d04dd23f2` + B12 `89a6eeec3` + this receipt): exit 0
  (`/tmp/gbrain-stage3c-tmp/typecheck-stage3c.log` -> `TYPECHECK_RC=0`).

## Exact unfinished inventory after this cohort

Runtime: B03, B04, B05, B09, B10, B13, B15, B27.
Tooling: B24, B25, B26. Configuration: B23 (rollout-owned value).
Integrated into the shared staging branch by this task: **nothing** (isolation rule).
`deploy_authorized=false` remains; Stage 4 (`t_70f96b71`) stays dependency-gated.
