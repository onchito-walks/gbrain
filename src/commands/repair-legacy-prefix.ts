/**
 * gbrain repair-legacy-prefix — normalize DB-only pages whose slug carries a
 * legacy source-root prefix (e.g. `hermes-moncho/`) without ever touching the
 * vault filesystem.
 *
 * Background (doctor check `undeclared_db_only_pages`, issue #2784): a page with
 * no backing file that sits outside every declared/default `db_only` path is
 * invisible to file-lane backup/recovery reasoning. Legacy slugs such as
 * `hermes-moncho/architecture/oracle-arm-container` were written under an
 * extracted source-root prefix the vault never used — the vault stores the same
 * content with the prefix stripped. Because `hermes-moncho/` is neither
 * file-backed nor declared, the doctor flags all 23 of them.
 *
 * Strategy: rewrite ONLY the slug, never a file. No raw SQL, no
 * sync/import/export into the vault, no canonical-file write/delete. Per legacy
 * page we compute the unprefixed target slug and classify:
 *
 *   SAFE_RENAME             no unprefixed DB page AND no vault file at target →
 *                           write content to the target slug (supported
 *                           `putPage`), then soft-delete the legacy row (the
 *                           reversible delete — 72h purge window).
 *   COLLAPSE_IDENTICAL_DB   unprefixed DB page exists with byte-identical
 *                           compiled_truth → the legacy row is a true
 *                           duplicate → soft-delete it; canonical retained.
 *   COLLAPSE_TIMELINE_ONLY_DB
 *                           unprefixed DB page differs from legacy ONLY by the
 *                           canonical page's auto-generated Timeline appendix
 *                           and its matching `timeline` frontmatter metadata
 *                           (a pure append-only Timeline section with no other
 *                           content delta) → legacy is a duplicate of the
 *                           file-backed canonical → soft-delete it. Never
 *                           fires when any other content or frontmatter
 *                           difference exists (e.g. bounty-market-reality stays
 *                           blocked); does NOT normalize arbitrary content.
 *   COLLAPSE_IDENTICAL_FILE vault file exists at target whose body (frontmatter
 *                           normalized) is identical to the legacy compiled_truth
 *                           → soft-delete the legacy duplicate row.
 *   BLOCK_DIVERGENT_DB      unprefixed DB page exists with different content →
 *                           NEVER mutated. Divergent legacy content preserved +
 *                           surfaced for operator reconciliation.
 *   BLOCK_DIVERGENT_FILE    vault file at target differs → NEVER mutated; surfaced.
 *   BLOCK_EMPTY_TARGET      slug === prefix (nothing to strip) → surfaced.
 *   BLOCK_AMBIGUOUS_TARGET  two legacy pages resolve to one target → surfaced.
 *
 * Dry-run by default (prints the plan, changes nothing). `--apply` executes
 * ONLY the three always-reversible outcomes (SAFE_RENAME, both COLLAPSE_*);
 * every BLOCK_* outcome is never applied. Each applicable item is re-verified
 * immediately before mutation (TOCTOU guard) and skipped if the world changed.
 *
 * Usage:
 *   gbrain repair-legacy-prefix                     # dry-run plan (default)
 *   gbrain repair-legacy-prefix --prefix hermes-moncho/
 *   gbrain repair-legacy-prefix --vault /path/to/vault
 *   gbrain repair-legacy-prefix --source default
 *   gbrain repair-legacy-prefix --apply             # apply ONLY safe + reversible
 *   gbrain repair-legacy-prefix --json
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine, SourceRow } from '../core/engine.ts';
import type { Page, PageInput } from '../core/types.ts';
import { slugifyPath } from '../core/sync.ts';

export const SAFE_RENAME = 'SAFE_RENAME';
export const COLLAPSE_IDENTICAL_DB = 'COLLAPSE_IDENTICAL_DB';
export const COLLAPSE_TIMELINE_ONLY_DB = 'COLLAPSE_TIMELINE_ONLY_DB';
export const COLLAPSE_IDENTICAL_FILE = 'COLLAPSE_IDENTICAL_FILE';
export const BLOCK_DIVERGENT_DB = 'BLOCK_DIVERGENT_DB';
export const BLOCK_DIVERGENT_FILE = 'BLOCK_DIVERGENT_FILE';
export const BLOCK_EMPTY_TARGET = 'BLOCK_EMPTY_TARGET';
export const BLOCK_AMBIGUOUS_TARGET = 'BLOCK_AMBIGUOUS_TARGET';

export type RepairOutcome =
  | typeof SAFE_RENAME
  | typeof COLLAPSE_IDENTICAL_DB
  | typeof COLLAPSE_TIMELINE_ONLY_DB
  | typeof COLLAPSE_IDENTICAL_FILE
  | typeof BLOCK_DIVERGENT_DB
  | typeof BLOCK_DIVERGENT_FILE
  | typeof BLOCK_EMPTY_TARGET
  | typeof BLOCK_AMBIGUOUS_TARGET;

export interface RepairItem {
  slug: string;
  sourceId: string;
  target: string;
  outcome: RepairOutcome;
  legacyLen: number;
  canonLen?: number;
  canonicalSlug?: string;
  reason?: string;
}

export interface RepairPlan {
  prefix: string;
  vaultRoot: string | null;
  vaultResolved: boolean;
  items: RepairItem[];
  counts: Partial<Record<RepairOutcome, number>>;
  applicable: RepairItem[];
  blocked: RepairItem[];
}

export const APPLICABLE_OUTCOMES: readonly RepairOutcome[] = [
  SAFE_RENAME,
  COLLAPSE_IDENTICAL_DB,
  COLLAPSE_TIMELINE_ONLY_DB,
  COLLAPSE_IDENTICAL_FILE,
] as const;

/** Strip a leading YAML frontmatter block so a file's body can be compared to
 *  the DB page's `compiled_truth` (which is body-only). */
export function stripYamlFrontmatter(s: string): string {
  const t = s.replace(/^\uFEFF/, '');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(t);
  return (m ? t.slice(m[0].length) : t).trim();
}

/**
 * Detect + strip a verified auto-generated Timeline appendix from the END of a
 * compiled_truth body. The auto-generated Timeline section (produced by the
 * canonical write/serialize path) is a terminal block that looks like:
 *
 *     ...real content...
 *
 *     ---
 *
 *     ## Timeline
 *     - **YYYY-MM-DD** | first entry
 *     - **YYYY-MM-DD** | second entry
 *
 * (The canonical serialize path also emits the same entries as a NON-bold
 * form — `- YYYY-MM-DD | first entry` — when the timeline entries were
 * generated without the historical double-star date markup. Both exact
 * generated grammars are accepted; see the entry-bullet regex below.)
 *
 * This helper is deliberately CONSERVATIVE: it returns `null` (i.e. "do not
 * treat as timeline-only") unless EVERY line after the `## Timeline` heading is
 * a timeline entry bullet of a documented generated shape
 * (`- YYYY-MM-DD | ...` or `- **YYYY-MM-DD** | ...`, with an optional leading
 * `* `/`- ` marker and `|`/`-`/`--`/`–`/`—` separator)
 * (or a blank/continuation line belonging to an entry). Any other content is
 * left untouched — the caller then correctly classifies the case as a real
 * divergence (BLOCK_DIVERGENT_DB). The section is only ever the trailing
 * appendix, never interior content.
 *
 * The date is non-negotiable: a bullet must START with a real `YYYY-MM-DD`
 * (bold or not) before the separator, so arbitrary bullet lists and headings
 * under the heading are never mistaken for a generated timeline.
 */
export function stripGeneratedTimelineAppendix(body: string): string | null {
  const lines = body.split('\n');
  // Find the LAST line that is a bare `## Timeline` (or `## History`) heading.
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (/^#{1,2}\s*(Timeline|History)\s*$/i.test(t)) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx < 0) return null;

  // Probe the heading's own line — it must be the section opener.
  if (!/^#{1,2}\s*(Timeline|History)\s*$/i.test(lines[headingIdx].trim())) return null;

  let sawEntry = false;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    const t = ln.trim();
    if (t.length === 0) continue; // blank/separator whitespace allowed
    // A timeline entry bullet: `- YYYY-MM-DD | ...` (generated non-bold form)
    // or `- **YYYY-MM-DD** | ...` (historical bold form). Allow an optional
    // leading `* `/`- ` then an ISO date (double-star bold markers OPTIONAL,
    // matching the generated grammar) then `|`/`-`/`--`/`–`/`—`.
    // The leading date is required so arbitrary bullets/headings never match.
    if (/^-?\s*-?\s*(?:\*\*)?\d{4}-\d{2}-\d{2}(?:\*\*)?\s*[|\-–—]+/.test(t)) {
      sawEntry = true;
      continue;
    }
    // A continuation line (indented detail under a prior entry) is acceptable.
    if (sawEntry && /^\s+/.test(ln)) continue;
    // Anything else → NOT a pure generated timeline appendix. Leave untouched.
    return null;
  }
  if (!sawEntry) return null; // heading with no entries → not a generated appendix

  // Strip the appendix from the trailing heading line onward. Also drop the
  // separator (`---`) and surrounding blank lines that serializeMarkdown emits
  // between the real content and the Timeline section.
  let base = lines.slice(0, headingIdx).join('\n').replace(/\s+$/, '');
  // Drop a preceding standalone `---` separator line (and any blank gap).
  base = base.replace(/\n?---\r?\n?$/, '').replace(/\s+$/, '').trimEnd();
  return base;
}

/** Deep-compare two JSON-like frontmatter values (objects/arrays/scalars). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as unknown[]).length) return false;
    return (a as unknown[]).every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Return a copy of frontmatter with the `timeline` metadata field removed. */
function stripTimelineFrontmatter(frontmatter: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!frontmatter) return {};
  const { timeline: _ignore, ...rest } = frontmatter;
  return rest;
}

/**
 * Strip a legacy-only `validate: false` frontmatter flag from the LEGACY
 * candidate, and only then. The flag is removed ONLY when it is present as
 * exactly boolean `false` on the legacy side AND entirely absent from the
 * canonical side (a legacy write-process artifact the canonical file-backed
 * page dropped). `validate: true`, any other `validate` value, and any other
 * key are NEVER ignored — they still block equivalence.
 */
function stripLegacyValidateFalseOnly(
  legacy: Record<string, unknown> | null | undefined,
  canonical: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged = { ...(legacy ?? {}) };
  const canon = canonical ?? {};
  if (merged['validate'] === false && !Object.prototype.hasOwnProperty.call(canon, 'validate')) {
    delete merged['validate'];
  }
  return merged;
}

/**
 * Conservative semantic-equivalence check. Returns true ONLY when the canonical
 * compiled_truth is byte-identical to the legacy body once the canonical's
 * verified auto-generated Timeline appendix (a pure append-only Timeline
 * section, matched by stripGeneratedTimelineAppendix) is removed, AND the two
 * frontmatters are equal once the auto-generated `timeline` metadata field is
 * removed from each. Nothing else is normalized — any other content or
 * frontmatter difference yields false.
 */
export function semanticallyTimelineOnly(
  opts: {
    canonicalBody: string;
    legacyBody: string;
    canonicalFrontmatter?: Record<string, unknown> | null;
    legacyFrontmatter?: Record<string, unknown> | null;
  },
): boolean {
  const base = stripGeneratedTimelineAppendix(opts.canonicalBody);
  if (base === null) return false;
  // The core content (real body) must agree exactly. The only allowed
  // frontmatter deltas are the auto-generated `timeline` metadata field (on
  // either page) and the legacy-only `validate: false` flag (stripped ONLY
  // when present on legacy and absent on canonical). Everything else — real
  // content, validate:true/other validate values, arbitrary frontmatter —
  // still yields false.
  if (base !== opts.legacyBody) return false;
  if (!deepEqual(
    stripTimelineFrontmatter(opts.canonicalFrontmatter),
    stripTimelineFrontmatter(
      stripLegacyValidateFalseOnly(opts.legacyFrontmatter, opts.canonicalFrontmatter),
    ),
  )) return false;
  return true;
}

/** Map a loaded Page back to a PageInput so `putPage` can reproduce it. */
export function pageToInput(p: Page): PageInput {
  return {
    type: p.type,
    title: p.title,
    compiled_truth: p.compiled_truth,
    timeline: p.timeline ?? '',
    frontmatter: p.frontmatter ?? {},
    content_hash: p.content_hash,
    page_kind: 'markdown',
    effective_date: p.effective_date ?? undefined,
    effective_date_source: p.effective_date_source ?? undefined,
    import_filename: p.import_filename ?? undefined,
  };
}

/** Walk a vault (source repo) and return slug -> relative path for markdown files. */
export function walkVault(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.gbrain' || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (/\.mdx?$/i.test(e.name)) map.set(slugifyPath(childRel), childRel);
    }
  }
  return map;
}

/** Read a vault file's frontmatter-normalized body. Null if unreadable. */
function readVaultBody(root: string, relPath: string): string | null {
  try {
    return stripYamlFrontmatter(readFileSync(join(root, relPath), 'utf-8'));
  } catch {
    return null;
  }
}

/** Resolve the source repo (vault) root: explicit flag, or a single local source. */
export async function resolveVaultRoot(
  engine: BrainEngine,
  explicit?: string | null,
): Promise<string | null> {
  if (explicit && explicit.trim()) return explicit.trim();
  if (!(typeof engine.listAllSources === 'function')) return null;
  const sources: SourceRow[] = await engine.listAllSources({ localPathOnly: true });
  const paths = [...new Set(sources.map(s => s.local_path).filter(Boolean) as string[])];
  return paths.length === 1 ? paths[0] : null;
}

/** Classify a single legacy page given resolved target facts. Pure + unit-testable. */
export function classifyRepair(
  opts: {
    slug: string;
    sourceId: string;
    legacyBody: string;
    /** Unprefixed DB page in the same source (null if absent). */
    canonDb: { slug: string; body: string; frontmatter?: Record<string, unknown> | null } | null;
    /** Frontmatter-normalized body of the vault file at target (null if none). */
    vaultBody: string | null;
    /** Number of legacy pages resolving to this same target. */
    targetCount: number;
    /** Legacy page's frontmatter (used by the timeline-only semantic check). */
    legacyFrontmatter?: Record<string, unknown> | null;
  },
): { outcome: RepairOutcome; reason?: string; canonLen?: number } {
  const { targetCount } = opts;
  if (opts.canonDb) {
    const identical = opts.canonDb.body === opts.legacyBody;
    if (identical) {
      return {
        outcome: 'COLLAPSE_IDENTICAL_DB',
        canonLen: opts.canonDb.body.length,
        reason: 'unprefixed DB page is byte-identical; legacy row is a duplicate',
      };
    }
    // Conservative semantic-equivalence: canonical differs ONLY by an
    // auto-generated Timeline appendix + its matching `timeline` frontmatter
    // metadata. Strips ONLY that verified appendix — nothing else is
    // normalized. Real content differences (e.g. bounty-market-reality) stay
    // blocked.
    if (semanticallyTimelineOnly({
      canonicalBody: opts.canonDb.body,
      legacyBody: opts.legacyBody,
      canonicalFrontmatter: opts.canonDb.frontmatter ?? null,
      legacyFrontmatter: opts.legacyFrontmatter ?? null,
    })) {
      return {
        outcome: 'COLLAPSE_TIMELINE_ONLY_DB',
        canonLen: opts.canonDb.body.length,
        reason: 'unprefixed DB page differs only by auto-generated Timeline appendix + matching frontmatter timeline metadata; legacy is a duplicate of the file-backed canonical',
      };
    }
    return {
      outcome: 'BLOCK_DIVERGENT_DB',
      canonLen: opts.canonDb.body.length,
      reason: 'unprefixed DB page differs in content; legacy preserved and blocked',
    };
  }
  if (opts.vaultBody !== null) {
    const identical = opts.vaultBody.trim() === opts.legacyBody.trim();
    return {
      outcome: identical ? COLLAPSE_IDENTICAL_FILE : BLOCK_DIVERGENT_FILE,
      reason: identical ? 'vault file body (frontmatter-normalized) is identical; legacy row is a duplicate' : 'vault file differs from DB body; legacy preserved and blocked',
    };
  }
  if (targetCount > 1) {
    return { outcome: 'BLOCK_AMBIGUOUS_TARGET', reason: `${targetCount} legacy pages resolve to this target` };
  }
  return { outcome: 'SAFE_RENAME', reason: 'no unprefixed DB page or vault file; safe to strip prefix' };
}

export interface BuildRepairPlanOpts {
  prefix: string;
  vaultRoot?: string | null;
  sourceId?: string | null;
}

/** Read-only plan builder. Deterministic; drives both dry-run and apply. */
export async function buildRepairPlan(
  engine: BrainEngine,
  opts: BuildRepairPlanOpts,
): Promise<RepairPlan> {
  const prefix = opts.prefix;
  const legacyPages = await engine.listPages({ slugPrefix: prefix, sourceId: opts.sourceId ?? undefined });

  const items: RepairItem[] = [];
  // Cache canonical DB lookups and vault bodies per unique target.
  const canonCache = new Map<string, { slug: string; body: string; frontmatter?: Record<string, unknown> | null } | null>();
  const vaultBodyCache = new Map<string, string | null>();
  const targetCounts = new Map<string, number>();

  for (const p of legacyPages) targetCounts.set(p.slug.slice(prefix.length), (targetCounts.get(p.slug.slice(prefix.length)) ?? 0) + 1);

  const vaultRoot = opts.vaultRoot !== undefined ? opts.vaultRoot : null;
  const vaultMap = vaultRoot && existsSync(vaultRoot) ? walkVault(vaultRoot) : null;
  const vaultResolved = vaultMap !== null;

  for (const p of legacyPages.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const target = p.slug.slice(prefix.length);

    let canon: { slug: string; body: string; frontmatter?: Record<string, unknown> | null } | null = null;
    if (target) {
      if (!canonCache.has(target)) {
        const cp = await engine.getPage(target, { sourceId: p.source_id });
        canonCache.set(target, cp ? { slug: cp.slug, body: cp.compiled_truth, frontmatter: cp.frontmatter ?? null } : null);
      }
      canon = canonCache.get(target) ?? null;

      if (!canon && vaultMap && !vaultBodyCache.has(target)) {
        const rel = vaultMap.get(target);
        vaultBodyCache.set(target, rel ? readVaultBody(vaultRoot!, rel) : null);
      }
    }

    const vaultBody = vaultMap ? (vaultBodyCache.get(target) ?? null) : null;
    let cls: { outcome: RepairOutcome; reason?: string; canonLen?: number };
    if (!target) {
      cls = { outcome: 'BLOCK_EMPTY_TARGET', reason: 'slug equals prefix; nothing to strip' };
    } else {
      cls = classifyRepair({
        slug: p.slug,
        sourceId: p.source_id,
        legacyBody: p.compiled_truth,
        canonDb: canon,
        legacyFrontmatter: p.frontmatter ?? null,
        vaultBody: vaultBody,
        targetCount: targetCounts.get(target) ?? 1,
      });
    }
    items.push({
      slug: p.slug,
      sourceId: p.source_id,
      target,
      outcome: cls.outcome,
      legacyLen: p.compiled_truth.length,
      canonLen: cls.canonLen,
      canonicalSlug: cls.outcome.startsWith('BLOCK_DIVERGENT_DB') || cls.outcome === 'COLLAPSE_IDENTICAL_DB' || cls.outcome === 'COLLAPSE_TIMELINE_ONLY_DB' ? target : undefined,
      reason: cls.reason,
    });
  }

  const counts: Partial<Record<RepairOutcome, number>> = {};
  for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
  const applicable = items.filter(i => (APPLICABLE_OUTCOMES as readonly string[]).includes(i.outcome));
  const blocked = items.filter(i => !(APPLICABLE_OUTCOMES as readonly string[]).includes(i.outcome));

  return { prefix, vaultRoot, vaultResolved, items, counts, applicable, blocked };
}

/** Apply the reversible subset. Re-verifies each item's classification first. */
export async function applyRepair(
  engine: BrainEngine,
  plan: RepairPlan,
): Promise<Array<{ slug: string; target: string; action: string; detail?: string }>> {
  const vaultMap = plan.vaultRoot && existsSync(plan.vaultRoot) ? walkVault(plan.vaultRoot) : null;
  const results: Array<{ slug: string; target: string; action: string; detail?: string }> = [];
  for (const item of plan.items) {
    if (!(APPLICABLE_OUTCOMES as readonly string[]).includes(item.outcome)) continue;

    // TOCTOU guard: re-classify from current state (DB + vault) before mutating.
    const legacy = await engine.getPage(item.slug, { sourceId: item.sourceId });
    if (!legacy) {
      results.push({ slug: item.slug, target: item.target, action: 'SKIPPED', detail: 'legacy row no longer present' });
      continue;
    }
    const canon = await engine.getPage(item.target, { sourceId: item.sourceId });
    let vaultBody: string | null = null;
    if (vaultMap) {
      const rel = vaultMap.get(item.target);
      vaultBody = rel ? readVaultBody(plan.vaultRoot!, rel) : null;
    }
    const targetCount = plan.items.filter(x => x.target === item.target).length;
    const re = classifyRepair({
      slug: item.slug,
      sourceId: item.sourceId,
      legacyBody: legacy.compiled_truth,
      canonDb: canon ? { slug: canon.slug, body: canon.compiled_truth, frontmatter: canon.frontmatter ?? null } : null,
      legacyFrontmatter: legacy.frontmatter ?? null,
      vaultBody,
      targetCount,
    });
    if (re.outcome !== item.outcome) {
      results.push({ slug: item.slug, target: item.target, action: 'SKIPPED', detail: `reclassification changed to ${re.outcome} since plan built — no action` });
      continue;
    }

    if (item.outcome === SAFE_RENAME) {
      // Double-check the target is still free in this source (canonical DB check
      // already done; a same-source page would have changed re.outcome).
      await engine.putPage(item.target, pageToInput(legacy), { sourceId: item.sourceId });
      await engine.softDeletePage(item.slug, { sourceId: item.sourceId });
      results.push({ slug: item.slug, target: item.target, action: 'RENAMED', detail: `${item.slug} -> ${item.target}` });
    } else {
      await engine.softDeletePage(item.slug, { sourceId: item.sourceId });
      results.push({ slug: item.slug, target: item.target, action: 'COLLAPSED', detail: `duplicate of ${item.target}; legacy row soft-deleted` });
    }
  }
  return results;
}

function formatPlan(plan: RepairPlan): string {
  const lines: string[] = [];
  lines.push(`repair-legacy-prefix (dry-run)  prefix="${plan.prefix}"  vault=${plan.vaultRoot ?? 'UNRESOLVED'}${plan.vaultResolved ? '' : ' (file-collision detection disabled)'}`);
  for (const i of plan.items) {
    const c = i.canonLen !== undefined ? ` (canon len ${i.canonLen})` : '';
    lines.push(`  ${i.outcome.padEnd(26)} ${i.slug} -> ${i.target}${c}`);
    if (i.reason) lines.push(`      reason: ${i.reason}`);
  }
  const byOutcome = Object.entries(plan.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  lines.push(`\n${plan.items.length} legacy page(s). ${byOutcome}`);
  lines.push(`Applicable (reversible): ${plan.applicable.length} — run with --apply to execute. Blocked: ${plan.blocked.length}`);
  return lines.join('\n');
}

// --- CLI entry point ---

export async function runRepairLegacyPrefix(engine: BrainEngine, args: string[]) {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const prefix = flag('--prefix') ?? 'hermes-moncho/';
  const vaultFlag = flag('--vault');
  const sourceFlag = flag('--source');
  const apply = args.includes('--apply');
  const json = args.includes('--json');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain repair-legacy-prefix [options]

Normalize DB-only pages whose slug carries a legacy source-root prefix (e.g.
hermes-moncho/) without touching the vault. Dry-run by default.

Options:
  --prefix <str>   Legacy prefix to strip (default: hermes-moncho/)
  --vault <path>   Source repo / vault root for file-collision detection
                   (default: resolved from the single local source)
  --source <id>    Scope to one source (default: all sources)
  --apply          Execute ONLY the reversible cases (SAFE_RENAME, both
                   COLLAPSE_* incl. the timeline-only semantic case).
                   Divergent collisions are never mutated.
  --json           Emit the plan / apply results as JSON
  --help, -h       Show this help
`);
    return;
  }

  if (apply && !vaultFlag) {
    // Ensure file-collision detection is available before we trust SAFE_RENAME.
    const resolved = await resolveVaultRoot(engine, vaultFlag);
    if (!resolved) {
      console.error('repair-legacy-prefix: --apply requires a resolvable vault (--vault) so SAFE_RENAME can confirm no canonical file is being shadowed. Run dry-run first.');
      return;
    }
  }

  const vaultRoot = await resolveVaultRoot(engine, vaultFlag);
  const plan = await buildRepairPlan(engine, { prefix, vaultRoot, sourceId: sourceFlag });

  if (apply) {
    if (!plan.vaultResolved) {
      console.error('repair-legacy-prefix: refusing --apply — vault not resolvable; file-collision detection would be blind.');
      return;
    }
    const results = await applyRepair(engine, plan);
    if (json) {
      console.log(JSON.stringify({ plan, results }, null, 2));
    } else {
      console.log(formatPlan(plan));
      console.log('\nApplied:');
      for (const r of results) console.log(`  [${r.action}] ${r.slug} => ${r.detail}`);
      console.log(`\nBlocked (no action): ${plan.blocked.length} — reconcile separately.`);
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatPlan(plan));
  }
}
