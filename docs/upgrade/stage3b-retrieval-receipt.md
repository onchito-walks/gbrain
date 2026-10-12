# Stage 3B continuation receipt — retrieval, aliases, provenance, assessments (task t_e8aff02d)

Status: COMPLETE for this cohort — all 6 coupled behaviors (B03/B04/B05/B09/B10/B27) are
implemented, committed and verified on an isolated branch. Stage 3 as a whole is NOT complete and
t_4dd80505 owns final Stage 3 closure; Stage 4 remains dependency-gated.

- Branch: `upgrade/stage3b-retrieval-isolated`
- Worktree: `/srv/minio/native/ubuntu-root-offload/gbrain-port/wt-stage3b-retrieval`
- Base: exact staging SHA `c08d2c167bdd6db54504872fd92447c074b6c59f` (Stage 3A head), which sits on
  the frozen official base `0460af288227a193c2031eca2e6a64f808cbd8bd` and the Stage 1/2/3A
  inventory + drift overlay ancestry.
- Commits (oldest first, one behavior per commit):
  - `0eb6d6b37` B03 public `exclude_slug_prefixes` plumbing (authored by an earlier run of this
    task; re-verified here: 8 pass / 0 fail / 25 expect at the committed SHA)
  - `40f5d38d9` B04 default covered-atom retrieval policy with opt-out and cache identity
  - `a0562321d` B05 verified legacy source-root alias for frozen atom bindings
  - `282239a5d` B09 read-time atom provenance quote status (search + doctor)
  - `8f86e6427` B10 quarantine visibility in the provenance populations
  - `62ac5fd6d` **B27 read-time atom_disposition enrichment from companion assessments** (this run)
- Code tip: `62ac5fd6d07446bce0c95e256c479fc8b0cfd845`. Tree clean; no rebase/reset/force/history
  rewrite anywhere.

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
- **B27** (this run) surfaces a validated `atom_disposition` on atom `search` results and on
  `get_page`, read at READ time from SEPARATE canonical companion notes
  (`operations/atom-evidence-repair-20261011/assessments-*` carrying a frontmatter
  `atom_assessments[]` array). The disposition is accepted only when the record binds field-exactly
  to the live atom row — `atom_id`, `atom_slug`, `source_id`, `frozen_source_hash`,
  `frozen_source_slug` and the exact UTF-8 sha256 of `compiled_truth` — and only when the companion
  page (and every referenced slug) is a live, non-deleted, non-quarantined page in the atom's OWN
  source (plus non-private for an untrusted caller). Stale, conflicting or malformed records FAIL
  CLOSED: no status is presented, only `status: 'untrusted'` with a warning code
  (`assessment_stale` / `assessment_conflict` / `assessment_untrusted`). Every disposition is
  `historical: true` / `certified: false` with an honest warning — informational evidence, never a
  certification of the atom, and never part of ranking, coverage or filtering. References are
  sanitized twice over: only a well-formed canonical slug that resolves to a live SAME-source page
  is exposed, so a filesystem path, an absolute/`~` path or a private evidence path can never
  surface. The stamp clears any stale value before re-enriching, so cached rows are never served
  with an out-of-date assessment. The module makes no model calls and never writes: the original
  atom body, its `content_hash`, its frozen `source_hash`/`source_slug` and its sync authority are
  untouched (asserted in the focused test).

## Verification (actual runs, fenced Bun 1.4.3, as ubuntu, TMPDIR=/tmp/gbrain-stage3b-tmp)

All runs foreground, one heavy command at a time, `--max-concurrency<=2` (the inherited 4 GiB
cgroup ceiling; no command was OOM-killed in this run).

- B03+B04 focused: 14 pass / 0 fail / 52 expect (re-verified at `40f5d38d9`).
- B04 touched area: 10 search files -> 263 pass / 0 fail / 654 expect / 39.30s.
- B05 focused: `test/covered-atom-source-alias.test.ts` -> 8 pass / 0 fail / 21 expect.
- B05+B03+B04 touched area (11 files) -> 271 pass / 0 fail / 675 expect / 39.29s.
- B09 focused: `test/atom-provenance-status.test.ts` -> 4 pass / 0 fail / 26 expect (real classifier
  SELECTs, the public search op, the real doctor check).
- B09+B10 with the official doctor suite -> 24 pass / 0 fail / 115 expect; the 11-file touched area
  at `282239a5d` -> 274 pass / 0 fail / 721 expect / 41.03s.
- **B27 focused at the committed tip `62ac5fd6d`**: `test/atom-disposition.test.ts`
  -> **6 pass / 0 fail / 28 expect**; `test/atom-disposition-cache-hit.serial.test.ts`
  -> **1 pass / 0 fail / 6 expect** (a serial file forcing the real `hybridSearchCached` cache-HIT
  branch with a mocked cache module, proving stored atom rows are re-enriched against CURRENT data
  and that a non-atom row never carries a disposition).
- **B27 touched area at `62ac5fd6d`**: 16 files -> **183 pass / 0 fail / 644 expect / 81.34s**
  (`atom-disposition`, 6 `get-page-*` + `cli-format-get-page-json`, `covered-atom-policy`,
  `covered-atom-source-alias`, `atom-provenance-status`, `doctor-atom-provenance-drift`,
  `ops-search-types`, `search/cached-wrapper-roundtrips`, `search/exclude-filters-hybrid`,
  `query-cache`, `cache-scope-key`).
- Guards at `62ac5fd6d`, all exit 0: `check:module-size`, `check:function-size`,
  `check:windows-hide`, `check:newlines`, `check:layering`, `check:test-isolation`,
  `check:test-names`, `check:test-placeholders`, `git diff --check`, and `bun run typecheck`.
- Every behavior test drives real code: `dispatchToolCall` -> op handler ->
  hybrid/keyword/cache-hit retrieval -> PGLite SQL on a disposable in-memory engine; real
  multi-source fixtures, real link rows, real frontmatter bindings, the real doctor check. No
  string-only or helper-only acceptance.

## Reviewer-visible size accounting (guards stay enabled)

Cumulative for this cohort (as previously recorded, plus this run):

- B04: `src/core/types.ts` 2292 -> 2304 (SearchOpts.includeCoveredAtoms interface field + doc);
  `src/core/search/mode.ts` 1598 -> 1613 (KnobsHashContext field + doc + the append-only v30 `ica=`
  part).
- B09: `src/core/types.ts` 2304 -> 2318 (SearchResult.provenance_status + doc);
  `src/core/search/hybrid.ts` 1634 -> 1702 (the new `stampAtomProvenance` beside its peer stampers).
- B27: `src/core/types.ts` 2318 -> 2333 (+15: `SearchResult.atom_disposition` and its doc — an
  interface field that the guard says cannot move, so the ceiling is raised with a rationale row in
  `scripts/module-size-limits.tsv`, edited in the same commit).
  B27's wiring deliberately added **zero** growth to the other ratcheted modules by moving each
  insertion into the sibling that already owns that seam:
  - the cache-HIT re-enrichment lives in `src/core/search/hybrid/cache-stages.ts` (which owns the
    hit tail) rather than in `hybrid.ts` — so `hybrid.ts` stays at exactly **1702/1702**;
  - the `get_page` spread lives in `src/core/ops/get-page-projection.ts`'s reading shape (which owns
    the response shape and already spreads `resolved_slug`/`content_flag`/`file_held` there) rather
    than around its return — so `ops/pages.ts` grows 675 -> 682 (**683** ceiling, untouched) and the
    `content_only` round-trip shape stays minimal, as documented;
  - the op keyword tail's one call line keeps `ops/search.ts` at exactly **1500/1500**, the unlisted
    cap (no TSV row added for it).
  Unlisted, well under cap: `ops/get-page-projection.ts` 141 -> 149, `cache-stages.ts` 369 -> 375,
  `hybrid/keyword-only.ts` +7, `hybrid/rank.ts` +4.
- No guard was disabled, widened or skipped; `scripts/module-size-limits.tsv` is edited in the same
  commit as each growth, per the check's own contract. `check:function-size` reported 0 raises.

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
3. **B27 landed in this run from the preserved draft port, and the draft was WRONG in one place.**
   The earlier run had reached "4 of 5 focused tests green" locally and reverted rather than commit
   red, which hid the defect: the draft's `ops/search.ts` wiring called
   `stampAtomDispositions(..., { ...scope, excludePrivate })` inside `stampKeywordRows`, where
   `excludePrivate` is NOT a variable in scope (it is a property of the `scope` parameter), so
   every `match: 'keyword'` search threw `ReferenceError: excludePrivate is not defined`. The
   earlier 4-of-5 run never exercised that route, and neither did the focused file — it was caught
   only by running the wider touched area (`test/ops-search-types.test.ts`, 5 failures) before
   committing. Fixed by passing `scope` itself, and now pinned by a new focused case on that exact
   route ("the direct keyword path (match: keyword) also carries the disposition"). This is the
   concrete reason the touched-area regression is part of the acceptance surface and not optional.
   The previous claim that "the two remaining failures were the `get_page` response spread and the
   atom-heavy ceiling overruns" was inaccurate about the get_page spread: the drafted spread worked
   as soon as the wiring patch was actually applied (5/5 focused green on first run here); only the
   ceilings and the keyword-tail defect were real.
4. The draft's `get_page` wiring spread the disposition over BOTH projection shapes. It now rides
   the reading shape only, so the documented `content_only` round-trip contract is unchanged.
5. The B27 test file is a 6-case rewrite (5 ported cases + the new keyword-route case) rather than
   the reference's 378-line file verbatim; the cache-hit serial file IS verbatim from `aead2484a`
   and passes unmodified against this tree's sibling-owned wiring — direct evidence that the port is
   behaviour-compatible, not just self-consistent.

## Remaining (exact)

Nothing remains in this cohort. Stage 3 work outside it is unchanged and still open: B11/B12/B13
(extraction — integrated on staging by the Stage 3C cohort), B15/B24/B25/B26 (guarded operator +
tooling — integrated by Stage 3D), the B23 `GBRAIN_DRIFT_TIMEOUT_MS=30000` rollout configuration,
and final acceptance by `t_4dd80505`. The preserved draft
`/srv/minio/hermes-native/.hermes/profiles/monchobot/scripts/references/stage3b-b27-saved/` is now
superseded by the committed code; it is retained, not deleted, as the provenance of this port.

## Scope compliance

No deployment, build, service restart, production DB write, credential, routing, source-grant or
firebreak change, no external publication, no edit under `/srv/minio/hermes/home/src/gbrain`, no
updater/overlay-registry repoint. Local commits only, as ubuntu (uid 1001). Dependency installs
were not re-run in this run (fenced Bun 1.4.3 used in place); any install must keep
`GBRAIN_UPGRADE_OWNS_MIGRATIONS=1` and the fenced PATH. `deploy_authorized=false` remains.

Environment caveat inherited and re-confirmed: durable physical-root reservations for
`/srv/minio/hermes-native/.hermes` (2026-09-20) and for the sibling `wt-stage3a-admission`
worktree make any test whose temp root sits under them refuse in `claimPhysicalRoot`; all runs in
this task used `TMPDIR=/tmp/gbrain-stage3b-tmp` (outside both), and background-promoted terminal
commands trip the test preload's `DATABASE_URL` refusal, so test commands were run in the
foreground. Do not delete the reservations.

## Integration onto staging (NOT performed here — owed to t_4dd80505)

The branch is a strict descendant of the staging head recorded at dispatch
(`c08d2c167bdd6db54504872fd92447c074b6c59f`), but the shared staging worktree advanced
independently to `1bc6071daa21ca03afa9842fbdd96278b4dd93c0`, which already carries the Stage 3C
cohort (B11/B12/B13: `4d76268fc`, `de290719f`, `490535857`, `1bc6071da`) and the Stage 3D
integration note.

An earlier run attempted `git merge --ff-only upgrade/stage3b-retrieval-isolated` in the staging
worktree: refused by git ("Not possible to fast-forward, aborting"). Staging was left UNTOUCHED —
no merge commit, no rebase, no reset, no history rewrite, no partial state. `c08d2c167` IS still an
ancestor of the staging head; this branch's tip is NOT (the two lineages diverge at `c08d2c167`).

Integration for the Stage 3 owner (`t_4dd80505`) — exact instruction: bring
**`0eb6d6b37..62ac5fd6d`** onto the then-current staging head by merge or cherry-pick. That range is
the six behavior commits (`0eb6d6b37`, `40f5d38d9`, `a0562321d`, `282239a5d`, `8f86e6427`,
`62ac5fd6d`); everything after it on this branch is documentation only (receipt commits). A
`--ff-only` integration is possible only if staging is ever back at `c08d2c167`. No Stage 3B commit
touches a file the Stage 3C/3D cohorts changed except `src/core/ops/search.ts`,
`src/core/search/hybrid.ts`, `src/core/types.ts` and `scripts/module-size-limits.tsv` — expect
textual conflicts in exactly those four if the other cohorts edited them after `c08d2c167`
(`hybrid.ts` and `types.ts` are now confirmed conflict sites: B27 raises `types.ts` to 2333 and the
B09 growth already touched `hybrid.ts`).

Verified at the branch tip `62ac5fd6d07446bce0c95e256c479fc8b0cfd845`: worktree clean;
`test/atom-disposition.test.ts` 6/0/28, `test/atom-disposition-cache-hit.serial.test.ts` 1/0/6,
16-file touched area 183/0/644, all guards + typecheck exit 0.
