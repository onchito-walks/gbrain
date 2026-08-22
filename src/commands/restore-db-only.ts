/**
 * gbrain restore-db-only — safely materialize explicitly selected DB-only pages
 * as canonical markdown files in the vault.
 *
 * Background (doctor check `undeclared_db_only_pages`, issue #2784): a markdown
 * page with no backing file that sits outside every declared/default `db_only`
 * path is invisible to file-lane backup/recovery reasoning. The operator-level
 * fix is to materialize the page as its canonical vault file so it becomes
 * file-backed again.
 *
 * This command is intentionally NARROW and recurrence-safe:
 *   - It only ever WRITES a new markdown file into the vault. It never touches
 *     the DB: no putPage, no delete, no soft-delete, no sync/import/export.
 *   - Every target must be named explicitly via repeated `--slug <slug>`
 *     (an explicit allowlist). There is no blind/broad export path.
 *   - Dry-run by default: `--apply` is required to write, and `--apply`
 *     refuses if no `--slug` allowlist was supplied.
 *   - It refuses to overwrite: an existing target file is BLOCKED, never
 *     clobbered.
 *   - It hard-blocks the legacy `hermes-moncho/` slug prefix. Those rows are
 *     divergent legacy-prefix conflicts that must be reconciled separately and
 *     must NOT be materialized under a wrong vault path.
 *   - Writes use the engine's supported serializer (`serializeMarkdown`) and
 *     plain file writes (mkdir + writeFileSync) — the same mechanics as
 *     `gbrain export` — never raw SQL.
 *   - Every item is re-verified immediately before writing (TOCTOU guard):
 *     page still present and file still absent, else skipped.
 *
 * Usage:
 *   gbrain restore-db-only --slug a --slug b --vault /path/to/vault   # dry-run plan
 *   gbrain restore-db-only --slug a --slug b --vault /path/to/vault --apply   # write files
 *   gbrain restore-db-only --slug a --slug b --json
 *   gbrain restore-db-only --help
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { Page } from '../core/types.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { resolveVaultRoot } from './repair-legacy-prefix.ts';

/** Outcome: this page can be safely materialized. */
export const RESTORE_READY = 'RESTORE_READY';
/** Outcome: no non-deleted markdown page exists for the slug. PURE block. */
export const MISSING_PAGE = 'MISSING_PAGE';
/** Outcome: the target vault file already exists — never overwrite. PURE block. */
export const FILE_EXISTS = 'FILE_EXISTS';
/** Outcome: slug carries the legacy divergence prefix — never materialize. PURE block. */
export const LEGACY_PREFIX = 'LEGACY_PREFIX';
/** Outcome: slug resolved outside the vault root (path traversal). PURE block. */
export const UNSAFE_PATH = 'UNSAFE_PATH';

export type RestoreOutcome =
  | typeof RESTORE_READY
  | typeof MISSING_PAGE
  | typeof FILE_EXISTS
  | typeof LEGACY_PREFIX
  | typeof UNSAFE_PATH;

/** Legacy divergent slug prefix these rows must never be materialized under. */
export const LEGACY_DIVERGENT_PREFIX = 'hermes-moncho/';

export const APPLICABLE_OUTCOMES: readonly RestoreOutcome[] = [RESTORE_READY] as const;

export interface RestoreItem {
  slug: string;
  sourceId: string;
  /** Vault-relative file path that would be written, e.g. `architecture/foo.md`. */
  fileRel: string;
  outcome: RestoreOutcome;
  /** Length of the DB page's compiled_truth (for RESTORE_READY plan visibility). */
  bodyLen?: number;
  reason?: string;
}

export interface RestorePlan {
  vaultRoot: string | null;
  vaultResolved: boolean;
  items: RestoreItem[];
  counts: Partial<Record<RestoreOutcome, number>>;
  applicable: RestoreItem[];
  blocked: RestoreItem[];
}

/** Pure classify; deterministic + unit-testable. Order matters (first match wins). */
export function classifyRestore(opts: {
  slug: string;
  /** True when a non-deleted markdown page exists for this slug. */
  pageExists: boolean;
  /** True when the target vault file already exists on disk. */
  fileExists: boolean;
  /** True when the resolved target path escapes the vault root. */
  unsafePath: boolean;
}): { outcome: RestoreOutcome; reason: string } {
  if (!opts.pageExists) {
    return { outcome: MISSING_PAGE, reason: 'no non-deleted markdown page for this slug — nothing to materialize' };
  }
  if (opts.slug.startsWith(LEGACY_DIVERGENT_PREFIX)) {
    return {
      outcome: LEGACY_PREFIX,
      reason: `slug carries the legacy "${LEGACY_DIVERGENT_PREFIX}" prefix (divergent conflict) — never materialize; reconcile separately`,
    };
  }
  if (opts.unsafePath) {
    return { outcome: UNSAFE_PATH, reason: 'slug resolves to a path outside the vault root — refused' };
  }
  if (opts.fileExists) {
    return { outcome: FILE_EXISTS, reason: 'target vault file already exists — refusing to overwrite' };
  }
  return { outcome: RESTORE_READY, reason: 'DB page present and canonical vault file absent — safe to write' };
}

/** Compute the absolute target path and whether it stays inside the vault root. */
export function targetFile(vaultRoot: string | null, slug: string): { path: string; inside: boolean } {
  const fileRel = slug + '.md';
  if (!vaultRoot) return { path: fileRel, inside: true }; // caller must gate on vaultResolved
  const resolvedRoot = resolve(vaultRoot);
  const abs = resolve(join(vaultRoot, fileRel));
  const inside = abs === resolvedRoot || abs.startsWith(resolvedRoot + sep);
  return { path: abs, inside };
}

/** Read-only plan builder. Drives both dry-run and apply from the same code. */
export async function buildRestorePlan(
  engine: BrainEngine,
  opts: { slugs: string[]; sourceId?: string | null; vaultRoot?: string | null },
): Promise<RestorePlan> {
  const vaultRoot = opts.vaultRoot ?? null;
  const vaultResolved = Boolean(vaultRoot && existsSync(vaultRoot));
  const slugs = [...new Set(opts.slugs)].sort();
  const items: RestoreItem[] = [];

  for (const slug of slugs) {
    const page: Page | null = await engine.getPage(slug, { sourceId: opts.sourceId ?? 'default' });
    const pageExists = Boolean(page);
    const { path: fp, inside } = targetFile(vaultResolved ? vaultRoot! : null, slug);
    const fileExists = vaultResolved && existsSync(fp);
    const cls = classifyRestore({ slug, pageExists, fileExists, unsafePath: !inside });
    items.push({
      slug,
      sourceId: opts.sourceId ?? 'default',
      fileRel: slug + '.md',
      outcome: cls.outcome,
      bodyLen: page ? page.compiled_truth.length : undefined,
      reason: cls.reason,
    });
  }

  const counts: Partial<Record<RestoreOutcome, number>> = {};
  for (const i of items) counts[i.outcome] = (counts[i.outcome] ?? 0) + 1;
  const applicable = items.filter(i => (APPLICABLE_OUTCOMES as readonly string[]).includes(i.outcome));
  const blocked = items.filter(i => !(APPLICABLE_OUTCOMES as readonly string[]).includes(i.outcome));
  return { vaultRoot, vaultResolved, items, counts, applicable, blocked };
}

/** Write the file-plane materialization. Never touches the DB. */
export async function applyRestore(
  engine: BrainEngine,
  plan: RestorePlan,
): Promise<Array<{ slug: string; fileRel: string; action: string; detail?: string }>> {
  const results: Array<{ slug: string; fileRel: string; action: string; detail?: string }> = [];
  if (!plan.vaultRoot || !plan.vaultResolved) {
    return results;
  }
  for (const item of plan.items) {
    if (!(APPLICABLE_OUTCOMES as readonly string[]).includes(item.outcome)) continue;

    // TOCTOU guard — re-verify current state immediately before writing.
    const page = await engine.getPage(item.slug, { sourceId: item.sourceId });
    if (!page) {
      results.push({ slug: item.slug, fileRel: item.fileRel, action: 'SKIPPED', detail: 'page no longer present' });
      continue;
    }
    const { path: fp, inside } = targetFile(plan.vaultRoot, item.slug);
    if (!inside) {
      results.push({ slug: item.slug, fileRel: item.fileRel, action: 'SKIPPED', detail: 'target escapes vault root' });
      continue;
    }
    if (existsSync(fp)) {
      results.push({ slug: item.slug, fileRel: item.fileRel, action: 'SKIPPED', detail: 'target file appeared since plan built' });
      continue;
    }

    const tags = await engine.getTags(item.slug, { sourceId: item.sourceId });
    const md = serializeMarkdown(page.frontmatter, page.compiled_truth, page.timeline, {
      type: page.type,
      title: page.title,
      tags,
    });
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, md);
    results.push({ slug: item.slug, fileRel: item.fileRel, action: 'RESTORED', detail: `wrote ${item.fileRel} (${md.length} bytes)` });
  }
  return results;
}

function formatPlan(plan: RestorePlan): string {
  const lines: string[] = [];
  lines.push(`restore-db-only (dry-run)  vault=${plan.vaultRoot ?? 'UNRESOLVED'}${plan.vaultResolved ? '' : ' (unresolved/nonexistent — refused)'}`);
  for (const i of plan.items) {
    const len = i.bodyLen !== undefined ? ` (db len ${i.bodyLen})` : '';
    lines.push(`  ${i.outcome.padEnd(20)} ${i.slug} -> ${i.fileRel}${len}`);
    if (i.reason) lines.push(`      reason: ${i.reason}`);
  }
  const byOutcome = Object.entries(plan.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  lines.push(`\n${plan.items.length} target slug(s). ${byOutcome}`);
  lines.push(`Applicable: ${plan.applicable.length} — run with --apply to write. Blocked: ${plan.blocked.length}`);
  return lines.join('\n');
}

function usage(): void {
  console.log(`Usage: gbrain restore-db-only --slug <slug> [--slug <slug> ...] [options]

Materialize explicitly selected DB-only pages as canonical markdown files in the
Obsidian vault. FILE-PLANE ONLY: writes new files; never modifies/deletes DB
pages, never runs sync/import/export, never uses raw SQL.

Dry-run by default; passing --apply performs the writes.

Options:
  --slug <slug>    Slug to materialize. May be repeated. At least one is
                   required in every mode (explicit allowlist — no broad export).
  --vault <path>   Source repo / vault root. Default: resolved from the single
                   local source (must be resolvable — a vault is required).
  --source <id>    Scope page lookups to one source (default: default).
  --apply          Execute the writes. Refuses without --slug allowlist.
  --json           Emit the plan / apply results as JSON.
  --help, -h       Show this help

Safety:
  - A slug under the legacy "${LEGACY_DIVERGENT_PREFIX}" prefix is always BLOCKED
    (divergent conflict — reconcile separately, never materialize).
  - An existing target file is always BLOCKED (never overwritten).
  - A slug with no non-deleted markdown page is always BLOCKED.
  - Each write is re-verified immediately before it happens (TOCTOU guard).
`);
}

export async function runRestoreDbOnly(engine: BrainEngine, args: string[]) {
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const slugs = args.filter((a, i) => args[i - 1] === '--slug' && a !== '--slug');
  const vaultFlag = flag('--vault');
  const sourceFlag = flag('--source');
  const apply = args.includes('--apply');
  const json = args.includes('--json');

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  if (slugs.length === 0) {
    console.error('restore-db-only: at least one --slug is required (explicit allowlist; no blind broad export). See --help.');
    return;
  }

  const vaultRoot = await resolveVaultRoot(engine, vaultFlag);
  if (!vaultRoot || !existsSync(vaultRoot)) {
    console.error('restore-db-only: a resolvable vault is required (--vault <path> or a single local source). It is needed to refuse overwrites and to write the files. Run on the host with the vault configured.');
    return;
  }

  const plan = await buildRestorePlan(engine, { slugs: [...new Set(slugs)], sourceId: sourceFlag, vaultRoot });

  if (apply) {
    if (plan.applicable.length === 0) {
      if (json) {
        console.log(JSON.stringify({ plan, results: [] }, null, 2));
      } else {
        console.log(formatPlan(plan));
        console.log('\nNothing applicable — no files written. Blocked:' + (plan.blocked.length ? '' : ' none'));
        for (const b of plan.blocked) console.log(`  [${b.outcome}] ${b.slug}`);
      }
      return;
    }
    const results = await applyRestore(engine, plan);
    if (json) {
      console.log(JSON.stringify({ plan, results }, null, 2));
    } else {
      console.log(formatPlan(plan));
      console.log('\nApplied:');
      for (const r of results) console.log(`  [${r.action}] ${r.slug} => ${r.detail}`);
      console.log(`\nBlocked (no action): ${plan.blocked.length}`);
      for (const b of plan.blocked) console.log(`  [${b.outcome}] ${b.slug}`);
    }
    return;
  }

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(formatPlan(plan));
  }
}