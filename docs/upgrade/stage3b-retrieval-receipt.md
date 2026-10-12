# Stage 3B continuation receipt — retrieval, aliases, provenance, assessments (task t_e8aff02d)

Status: PARTIAL — 5 of the 6 coupled behaviors in this cohort are implemented, committed and
verified; B27 is NOT implemented (its ported code is preserved, uncommitted, outside the repo —
see "Remaining"). Stage 3 is NOT complete; t_4dd80505 owns final Stage 3 closure and Stage 4
stays dependency-gated.

- Branch: `upgrade/stage3b-retrieval-isolated`
- Worktree: `/srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3b-retrieval`
- Base: exact staging SHA `c08d2c167bdd6db54504872fd92447c074b6c59f` (Stage 3A head), which sits on
  the frozen official base `0460af288227a193c2031eca2e6a64f808cbd8bd` and the Stage 1/2/3A
  inventory + drift overlay ancestry.
- Commits (oldest first, one behavior per commit):
  - `0eb6d6b37` B03 public `exclude_slug_prefixes` plumbing (authored by the previous run of this
    task; re-verified here: 8 pass / 0 fail / 25 expect at the committed SHA)
  - `40f5d38d9` B04 default covered-atom retrieval policy with opt-out and cache identity
  - `a0562321d` B05 verified legacy source-root alias for frozen atom bindings
  - `282239a5d` B09 read-time atom provenance quote status (search + doctor)
  - `8f86e6427` B10 quarantine visibility in the provenance populations
- Tree clean at the tip; no rebase/reset/force/history rewrite anywhere.

## What each behavior does (retained policy, not a module copy)

- **B03** exposes the engine-stable `SearchOpts.exclude_slug_prefixes` on the public `search` and
  `query` ops (`normalizeExcludeSlugPrefixesParam`: array-only, structural empties treated as
  absent like `types` #5390, malformed refused as `invalid_params`), forwarded to the keyword leg,
  the hybrid leg, the image-similarity leg and the CRAG escalation re-run; the generated CLI flag
  registry carries `--exclude-slug-prefixes`.
- **B04** hides an `atom` page by default when its content is already reachable through a LIVE
  non-atom page of the SAME source — its frozen `source_slug` resolves to one, or the atom's own
  OUTGOING link reaches one. Uncovered atoms (no `source_slug`, unresolved/soft-deleted/
  cross-source cover, inverse edge only) are always retained. `include_covered_atoms: true` opts
  out; the opt-out rides `SearchOpts.includeCoveredAtoms` through the hybrid request contract and
  the semantic cache key (append-only `ica=` knobsHash part + the cache-stages key field). One
  composer (`buildRetrievalExclusionClause`) is the single exclusion fragment every leg
  interpolates, so no leg can drift from its siblings. Read-only: no body or frozen provenance
  rewrite.
- **B05** adds ONE prefix-only de-prefixed alias arm per verified legacy rename
  (`hermes-moncho/`, the single allow-list in `src/core/atom-slug-alias.ts`) inside the SAME
  same-source / non-atom EXISTS, so atoms extracted before the historical whole-vault rename are
  judged covered instead of source-gone. Never a basename or fuzzy match, never the generic
  `slug_aliases` registry (empty on the affected brain, not guaranteed pre-v105), never a rewrite
  of the frozen field, never a cross-source resolution.
- **B09** adds a READ-ONLY read-time provenance classification
  (`src/core/cycle/provenance-status.ts`): fresh / quote_present_in_live_page / quote_orphaned /
  source_gone / slug_unbound, decided with the ONE grounding fold (`normForGrounding`) and the
  shared legacy alias, scoped to the atom's own `source_id`. Search stamps `provenance_status` on
  atom results (display-only, best-effort, at every `stampUnverifiedExtractions` site plus the
  keyword-only op surface). The `atom_provenance_drift` doctor check resolves sources alias-aware
  and runs a BOUNDED quote probe, reporting `fresh` / `quote_present_in_live_page` /
  `quote_orphaned` / `quote_probe` and an honest warn ("historical drift — a binding-freshness
  signal, not an integrity verdict"). It writes nothing: no `source_hash` rebind, no frontmatter
  edit, no `page_versions` write.
- **B10** makes the quarantine predicate (`quarantineFilterFragment`) part of every provenance
  population: the classifier's live-hash and live-body reads, and the doctor's atom / live_hashes
  / live_slugs sets. A quarantined page is not live evidence, so it can neither certify a quote
  nor pollute the counts.

## Verification (actual runs, fenced Bun 1.4.3, as ubuntu, TMPDIR=/tmp/gbrain-stage3b-tmp)

- B03+B04 focused: `bun test test/covered-atom-policy.test.ts test/search-slug-prefix-exclusion-op.test.ts`
  -> 14 pass / 0 fail / 52 expect (re-verified at `40f5d38d9`).
- B04 touched area: 10 search files -> 263 pass / 0 fail / 654 expect / 39.30s.
- B05 focused: `test/covered-atom-source-alias.test.ts` -> 8 pass / 0 fail / 21 expect.
- B05+B03+B04 touched area (11 files) -> 271 pass / 0 fail / 675 expect / 39.29s.
- B09 focused: `test/atom-provenance-status.test.ts` -> 4 pass / 0 fail / 26 expect (real classifier
  SELECTs, the public search op, the real doctor check).
- B09+B10 with the official doctor suite: `test/atom-provenance-status.test.ts`
  `test/doctor-atom-provenance-drift.test.ts` -> 24 pass / 0 fail / 115 expect; the 11-file
  touched area at `282239a5d` -> 274 pass / 0 fail / 721 expect / 41.03s.
- `bun run typecheck`, `check:module-size`, `check:function-size`, `check:windows-hide`,
  `check:newlines`, `git diff --check` -> exit 0 at each committed tip (module-size re-checked at
  `8f86e6427`: exit 0).
- Every behavior test drives real code: `dispatchToolCall` -> op handler -> hybrid/keyword
  retrieval -> PGLite SQL on a disposable in-memory engine; real multi-source fixtures, real link
  rows, real frontmatter bindings, the real doctor check. No string-only or helper-only acceptance.

## Reviewer-visible size accounting (guards stay enabled; 4 ceilings raised in total)

- B04: `src/core/types.ts` 2292 -> 2304 (SearchOpts.includeCoveredAtoms interface field + doc);
  `src/core/search/mode.ts` 1598 -> 1613 (KnobsHashContext field + doc + the append-only v30 `ica=`
  part).
- B09: `src/core/types.ts` 2304 -> 2318 (SearchResult.provenance_status + doc);
  `src/core/search/hybrid.ts` 1634 -> 1702 (the new `stampAtomProvenance` beside its peer stampers).
- No guard was disabled, widened or skipped; `scripts/module-size-limits.tsv` is edited in the same
  commit as each growth, per the check's own contract.

## Deviations and disclosures (explicit)

1. The `atom_provenance_drift` warn wording keeps the official "whose source page is gone" phrase
   rather than the reference's "absent or quarantined". B10's exclusion behaviour is implemented and
   tested; only that adjective differs, and updating it would have required churning two
   `test/doctor-atom-provenance-drift.test.ts` expectations in the same commit. Recorded as an
   intentional, reviewable wording delta.
2. The doctor's aggregate and quote probe were peeled into a new sibling
   `src/commands/doctor/checks/atom-provenance-drift.ts` (the guard's preferred shape: move new
   logic to a sibling rather than grow a ratcheted module). The `#4937` materialized-lookup-set test
   now reads that sibling — the property is unchanged, only its file location moved.
3. B27 was implemented in the worktree and reached 4 of 5 focused tests green, then was REVERTED
   to keep the committed branch green within this run's bounded iteration budget (the two
   remaining failures were the `get_page` response spread and the atom-heavy ceiling overruns).
   The work is preserved outside the repo — see "Remaining" — and no trace of it remains in the
   worktree (`grep` for `atom-disposition`/`stampAtomDispositions` in `src/` returns nothing; the
   tree is clean at `8f86e6427`).

## Remaining (exact)

Runtime still open in this cohort: **B27 only** — "Historical companion assessment enrichment on
search and direct page reads" (reference commit `aead2484a`, files `src/core/search/atom-disposition.ts`,
`src/core/ops/pages.ts`, `src/core/ops/search.ts`, `src/core/search/hybrid.ts`, `src/core/types.ts`,
tests `test/atom-disposition.test.ts`, `test/atom-disposition-cache-hit.serial.test.ts`).

Ported, uncommitted work saved durably for the next worker:
`/srv/minio/hermes-native/.hermes/profiles/monchobot/scripts/references/stage3b-b27-saved/`
  - `atom-disposition.ts` (516 lines, verbatim port of `aead2484a:src/core/search/atom-disposition.ts`; imports only `node:crypto`, engine types and `pageReadFilter`, whose 4-arg signature matches this tree)
  - `atom-disposition.test.ts` (162 lines; 4 of 5 cases green: validated same-source disposition with `historical: true` / `certified: false` and sanitized references, stale-binding fail-closed, conflict fail-closed + absent, stale-clearing stamp)
  - `b27-worktree-wiring.patch` (173 lines: `types.ts` field + import, `hybrid.ts` import/cache-hit/`ops/search.ts`/`ops/pages.ts`/`hybrid/keyword-only.ts`/`hybrid/rank.ts` wiring)
  Known remaining work if resumed: surface the disposition on the `get_page` response through
  `projectGetPage`'s caller (the projection contract needs the extra key spread explicitly — that
  is the one failing focused case), and settle the size ceilings that the wiring raises
  (`hybrid.ts` 1702 -> 1710, `types.ts` 2318 -> 2333, `ops/pages.ts` 683 -> 686, and keep
  `ops/search.ts` at or below its 1500 unlisted cap), then re-run typecheck + module-size +
  function-size before committing.

Other Stage 3 work outside this cohort is unchanged and still open: B11/B12/B13 (extraction),
B15/B24/B25/B26 (guarded operator + tooling), the B23 `GBRAIN_DRIFT_TIMEOUT_MS=30000` rollout
configuration, and final acceptance by `t_4dd80505`.

## Scope compliance

No deployment, build, service restart, production DB write, credential, routing, source-grant or
firebreak change, no external publication, no edit under `/srv/minio/hermes/home/src/gbrain`, no
updater/overlay-registry repoint. Local commits only, as ubuntu. Dependency installs were not
re-run in this run (fenced Bun 1.4.3 used in place); any install must keep
`GBRAIN_UPGRADE_OWNS_MIGRATIONS=1` and the fenced PATH. `deploy_authorized=false` remains.

Environment caveat inherited and re-confirmed: durable physical-root reservations for
`/srv/minio/hermes-native/.hermes` (2026-09-20) and for the sibling `wt-stage3a-admission`
worktree make any test whose temp root sits under them refuse in `claimPhysicalRoot`; all runs in
this task used `TMPDIR=/tmp/gbrain-stage3b-tmp` (outside both), and background-promoted terminal
commands trip the test preload's `DATABASE_URL` refusal, so test commands were run in the
foreground. Do not delete the reservations.

## Integration onto staging (attempted; NOT performed — staging advanced independently)

The branch is a strict descendant of the staging head recorded at dispatch
(`c08d2c167bdd6db54504872fd92447c074b6c59f`), but by the end of this run the shared staging
worktree was clean and sitting at `1bc6071daa21ca03afa9842fbdd96278b4dd93c0`, which already carries
the Stage 3C cohort (B11/B12/B13: `4d76268fc`, `de290719f`, `490535857`, `1bc6071da`) and the
Stage 3D integration note — i.e. staging advanced independently past this branch's base.

Attempted `git merge --ff-only upgrade/stage3b-retrieval-isolated` in the staging worktree: refused
by git ("Not possible to fast-forward, aborting"). Staging was therefore left UNTOUCHED — no merge
commit, no rebase, no reset, no history rewrite, no partial state. `c08d2c167` IS still an ancestor
of the staging head; this branch's tip `60abdec3d` is NOT (the two lineages diverge at
`c08d2c167`).

Integration for the Stage 3 owner (`t_4dd80505`) — exact instruction: bring
`0eb6d6b37..60abdec3d` (five behavior commits plus this receipt) onto the then-current staging head
by merge or cherry-pick (the commit range is the five behavior commits; the receipt commit is
documentation only). A `--ff-only` integration is possible only if staging is ever back at
`c08d2c167`. No Stage 3B commit touches a file the Stage 3C/3D cohorts changed except
`src/core/ops/search.ts`, `src/core/search/hybrid.ts`, `src/core/types.ts` and
`scripts/module-size-limits.tsv` — expect textual conflicts in exactly those four if the other
cohorts edited them after `c08d2c167`.

Verified at the branch tip `60abdec3d389ab7e62e85899384a76e6ca71a4ab` (the receipt commit; same code
as `8f86e6427`): worktree clean; `bun test test/atom-provenance-status.test.ts
test/doctor-atom-provenance-drift.test.ts test/covered-atom-policy.test.ts
test/covered-atom-source-alias.test.ts test/search-slug-prefix-exclusion-op.test.ts`
-> 46 pass / 0 fail / 188 expect across 5 files.
