/**
 * gbrain quarantine — operator surface for the content-quality gate (issue #1699).
 *
 *   gbrain quarantine list [--json] [--include-flagged]   (also write-gate fact/take holds)
 *   gbrain quarantine clear <slug> [--force] [--no-embed] [--json]
 *   gbrain quarantine scan [--limit N] [--apply] [--no-embed] [--json]
 *
 * `quarantine` (hidden) marks high-confidence junk; `content_flag` (warned,
 * still searchable) marks fuzzy markup-heavy / oversize pages. See
 * src/core/quarantine.ts for the marker contract.
 */
import type { BrainEngine } from '../core/engine.ts';
import { isQuarantined, getContentFlag, QUARANTINE_KEY, CONTENT_FLAG_KEY } from '../core/quarantine.ts';
import { serializePageToMarkdown, serializeMarkdown } from '../core/markdown.ts';
import { importFromContent } from '../core/import-file.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { opError, type OperationContext } from '../core/ops/contract.ts';
import { readFix } from '../core/ops/op-fix.ts';
import { managedPersistenceEnabled } from '../core/persistence/ownership.ts';
import { submitPageMutation } from '../core/persistence/page-mutations.ts';
import { resolveCliWriteWaitMs } from '../core/persistence/write-wait.ts';
import { QUARANTINE_OVERRIDE_KEY, quarantineOverrideFor } from '../core/quarantine-override.ts';
import { reportPersistenceCliError } from './persistence-delegate.ts';
import type { PageType } from '../core/types.ts';
import { listWriteGateHolds, type WriteGateHold } from '../core/write-gate-store.ts';
import {
  parseOperatorManifest, planOperatorQuarantine, applyOperatorQuarantine, rollbackOperatorQuarantine,
  buildOperatorQuarantineMarker, OperatorQuarantineError, OPERATOR_QUARANTINE_REASONS,
  type OperatorQuarantineSnapshot,
} from '../core/operator-quarantine.ts';

export interface QuarantineRow {
  slug: string;
  source_id: string;
  marker: 'quarantine' | 'content_flag';
  reason: string;
  assessed_at: string;
}

export function rowFor(page: { slug: string; source_id?: string; frontmatter?: Record<string, unknown> | null }): QuarantineRow | null {
  const fm = page.frontmatter ?? null;
  if (isQuarantined(fm)) {
    const m = (fm as Record<string, unknown>)[QUARANTINE_KEY] as Record<string, unknown>;
    return {
      slug: page.slug,
      source_id: page.source_id ?? 'default',
      marker: 'quarantine',
      reason: typeof m?.reason === 'string' ? m.reason : 'unknown',
      assessed_at: typeof m?.assessed_at === 'string' ? m.assessed_at : '',
    };
  }
  const flag = getContentFlag(fm);
  if (flag) {
    const m = (fm as Record<string, unknown>)[CONTENT_FLAG_KEY] as Record<string, unknown>;
    return {
      slug: page.slug,
      source_id: page.source_id ?? 'default',
      marker: 'content_flag',
      reason: flag.reason,
      assessed_at: typeof m?.assessed_at === 'string' ? m.assessed_at : '',
    };
  }
  return null;
}

// Bounds for the quarantine_list op's clamps (src/core/ops/admin.ts); the CLI
// list stays unbounded. One canonical home so the op clamps and the param
// descriptions can't drift apart silently.
export const QUARANTINE_LIST_DEFAULT_LIMIT = 200;
export const QUARANTINE_LIST_MAX_LIMIT = 1000;
export const QUARANTINE_SCAN_DEFAULT = 20000;
export const QUARANTINE_SCAN_MAX = 100000;

export interface CollectQuarantineOpts {
  includeFlagged?: boolean;
  /** Max ROWS returned (op default 200, cap 1000). Undefined = unbounded (CLI). */
  limit?: number;
  /** Max PAGES scanned (op default 20000, cap 100000). Undefined = full scan (CLI). */
  maxScan?: number;
  /** Source scope (the op threads sourceScopeOpts; the CLI scans unscoped). */
  sourceId?: string;
  sourceIds?: string[];
}

export interface CollectQuarantineResult {
  rows: QuarantineRow[];
  scanned: number;
  /** True when a bound stopped the scan — `rows.length` is a LOWER BOUND. */
  truncated: boolean;
}

/**
 * Shared frontmatter scan behind `gbrain quarantine list` and the
 * quarantine_list op. Scan order is pinned to listPages' default
 * `updated_desc` (most recently updated pages first), so a bounded scan sees
 * the newest markers before older ones [OV13].
 *
 * [P2-6] Offset pagination over `updated_desc` is NOT a total order:
 * `PAGE_SORT_SQL.updated_desc` is `p.updated_at DESC` with no unique
 * tiebreaker (src/core/types.ts). A cluster of pages sharing an identical
 * `updated_at` (bulk syncs stamp one now() across a transaction) that
 * straddles a 1000-row batch boundary can have a row skipped or duplicated
 * across batches. We accept this rather than switch sorts because the only
 * tiebreaker'd enum option (`updated_asc`, `p.updated_at ASC, p.slug ASC`)
 * reverses the [OV13] direction — a truncated scan (bounded by max_scan /
 * limit) would then surface the OLDEST markers and MISS recent ones, a worse
 * triage failure on large brains, and its slug tiebreaker is only a total
 * order for a single-source scan anyway (the op can scope federated
 * multi-source and the CLI scans unscoped, where slug is not unique). The
 * exposure is bounded: the op caps the scan at max_scan, and only exact
 * same-timestamp clusters landing on a batch boundary are affected. The full
 * fix is a globally-unique page_id tiebreaker in PAGE_SORT_SQL (out of scope
 * here — a filed follow-up), not a SELECT-projection pushdown.
 */
export async function collectQuarantineRows(
  engine: BrainEngine,
  opts: CollectQuarantineOpts = {},
): Promise<CollectQuarantineResult> {
  const rows: QuarantineRow[] = [];
  const PAGE = 1000;
  let offset = 0;
  let scanned = 0;
  let truncated = false;
  outer: for (;;) {
    const pages = await engine.listPages({
      limit: PAGE,
      offset,
      sort: 'updated_desc',
      ...(opts.sourceIds && opts.sourceIds.length > 0
        ? { sourceIds: opts.sourceIds }
        : opts.sourceId ? { sourceId: opts.sourceId } : {}),
    });
    if (pages.length === 0) break;
    for (const p of pages) {
      if (opts.maxScan !== undefined && scanned >= opts.maxScan) { truncated = true; break outer; }
      scanned += 1;
      const r = rowFor(p);
      if (!r) continue;
      if (r.marker === 'content_flag' && !opts.includeFlagged) continue;
      rows.push(r);
      if (opts.limit !== undefined && rows.length >= opts.limit) { truncated = true; break outer; }
    }
    if (pages.length < PAGE) break;
    offset += PAGE;
  }
  return { rows, scanned, truncated };
}

/** One-line, inert preview of a held row's text for the owner's review. */
function holdPreview(hold: WriteGateHold): string {
  const text = String(hold.payload.fact ?? hold.payload.claim ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

async function runList(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const includeFlagged = args.includes('--include-flagged');
  const { rows } = await collectQuarantineRows(engine, { includeFlagged });
  // #5575: facts and takes the write gate held (never inserted); release or drop with gbrain trust release|drop <ref>.
  const holds = await listWriteGateHolds(engine, { status: 'held', limit: 1000 });

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, count: rows.length, rows, hold_count: holds.length, holds }, null, 2));
    return;
  }
  for (const h of holds) {
    const src = h.source_id === 'default' ? '' : ` [${h.source_id}]`;
    console.log(`  HELD    ${h.kind} ${h.ref}${src}${h.slug ? ` ${h.slug}` : ''}  reasons=${h.reason_families.join(',') || 'detector_error'}  tier=${h.tier}  at=${h.last_seen_at}\n          ${holdPreview(h)}`);
  }
  if (holds.length) console.log(`\n${holds.length} held fact/take row(s): review, then gbrain trust release <ref> or gbrain trust drop <ref>.\n`);
  if (rows.length === 0) {
    console.log(
      includeFlagged
        ? 'No quarantined or flagged pages.'
        : "No quarantined pages. (Pass --include-flagged to also list content_flag pages.)",
    );
    return;
  }
  for (const r of rows) {
    const src = r.source_id === 'default' ? '' : ` [${r.source_id}]`;
    console.log(`  ${r.marker === 'quarantine' ? 'HIDDEN ' : 'FLAGGED'} ${r.slug}${src}  reason=${r.reason}  at=${r.assessed_at}`);
  }
  const hidden = rows.filter((r) => r.marker === 'quarantine').length;
  const flagged = rows.length - hidden;
  console.log(`\n${hidden} quarantined (hidden), ${flagged} flagged (searchable, warned).`);
}

async function runClear(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const force = args.includes('--force');
  const noEmbed = args.includes('--no-embed');
  const srcIdx = args.indexOf('--source-id');
  const sourceIdFlag = srcIdx >= 0 && args[srcIdx + 1] && !args[srcIdx + 1].startsWith('--')
    ? args[srcIdx + 1]
    : undefined;
  // First non-flag positional after the subcommand is the slug (skip the
  // --source-id value so it can't be mistaken for the slug).
  const slug = args.find((a, i) => !a.startsWith('--') && !(srcIdx >= 0 && i === srcIdx + 1));
  if (!slug) {
    console.error('Usage: gbrain quarantine clear <slug> [--source-id <id>] [--force] [--no-embed]');
    process.exit(2);
  }
  // Deterministic source resolution: an unscoped getPage on a slug that
  // exists in multiple sources returns an arbitrary row, and the re-import
  // below writes to WHATEVER source that read happened to hit. Resolve the
  // candidate sources explicitly; ambiguity is an error, not a coin flip.
  let sourceId = sourceIdFlag;
  if (!sourceId) {
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id`,
      [slug],
    );
    if (rows.length > 1) {
      console.error(
        `Slug "${slug}" exists in ${rows.length} sources: ${rows.map(r => r.source_id).join(', ')}.\n` +
        `Pick one with: gbrain quarantine clear ${slug} --source-id <id>`,
      );
      process.exit(2);
    }
    sourceId = rows[0]?.source_id;
  }
  // sourceId is resolved above whenever ANY row exists; zero candidates means
  // the page doesn't exist in any source, so the 'default' fallback read
  // returns null and we error below either way. One snapshot gives the page,
  // its tags and the revision a managed write is conditioned on (#6259).
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: sourceId ?? 'default' });
  if (!snapshot) {
    console.error(`No page found for slug "${slug}"${sourceIdFlag ? ` in source "${sourceIdFlag}"` : ''}.`);
    process.exit(2);
  }
  const page = snapshot.page;
  const fm = { ...((page.frontmatter ?? {}) as Record<string, unknown>) };
  if (!isQuarantined(fm) && !getContentFlag(fm)) {
    console.log(`Page "${slug}" carries no quarantine or content_flag marker — nothing to clear.`);
    return;
  }
  // Drop both markers, then write the page through the normal pipeline so it
  // re-chunks + re-embeds and becomes searchable again. The gate re-runs on
  // that write: if the page is STILL detected as junk it re-quarantines
  // (reported below). --force records a `quarantine_override` bound to the
  // page's title, type and body, so this write and every later one keep the
  // classifier's verdict off until that content changes. It never bypasses
  // size gates or the write's revision check.
  delete fm[QUARANTINE_KEY];
  delete fm[CONTENT_FLAG_KEY];
  delete fm[QUARANTINE_OVERRIDE_KEY];
  // Serialize from the CLEANED frontmatter directly (NOT serializePageToMarkdown,
  // which re-spreads page.frontmatter as the base and would re-introduce the
  // markers we just deleted).
  const serialize = (frontmatter: Record<string, unknown>) => serializeMarkdown(frontmatter, page.compiled_truth ?? '', page.timeline ?? '', {
    type: (page.type as PageType) ?? 'note',
    title: page.title ?? '',
    tags: snapshot.tags,
  });
  let markdown = serialize(fm);
  if (force) markdown = serialize({ ...fm, [QUARANTINE_OVERRIDE_KEY]: quarantineOverrideFor(markdown, `${slug}.md`) });

  let reQuarantined: boolean;
  let flagged: boolean;
  let flagReason: string | undefined;
  if (await managedPersistenceEnabled(engine)) {
    // A managed brain publishes through the canonical owner, like put and capture.
    const ctx = { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, dryRun: false, sourceId: page.source_id,
      writeWaitMs: resolveCliWriteWaitMs({ config: loadConfig() }),
      logger: { info: () => {}, warn: (m: string) => console.error(m), error: (m: string) => console.error(m) } } as unknown as OperationContext;
    try {
      // #6259: the owner-internal kind keeps the override this clear writes (a plain put_page has gate markers stripped).
      await submitPageMutation(ctx, { operation: 'put_page', managedFileImport: true, params: { slug, source_id: page.source_id, content: markdown,
        kind: 'managed_quarantine_clear', expected_revision: snapshot.revision, request_id: randomUUID() } });
    } catch (error) {
      if (await reportPersistenceCliError(error, json)) return;
      throw error;
    }
    const after = (await engine.getPage(slug, { sourceId: page.source_id }))?.frontmatter as Record<string, unknown> | undefined;
    reQuarantined = isQuarantined(after);
    flagReason = getContentFlag(after)?.reason;
    flagged = !!flagReason;
  } else {
    const result = await importFromContent(engine, slug, markdown, { sourceId: page.source_id, noEmbed, forceRechunk: true, preserveGateMarkers: true });
    reQuarantined = result.quarantined === true;
    flagged = result.flagged ?? false;
    flagReason = result.flag_reason;
  }

  if (json) {
    console.log(JSON.stringify({ slug, cleared: !reQuarantined, re_quarantined: reQuarantined, flagged, forced: force }, null, 2));
    return;
  }
  if (reQuarantined) {
    console.error(
      `Page "${slug}" is STILL detected as junk — it remained quarantined. ` +
      `Edit the page so it no longer matches, or re-run with --force to record that it is not junk.`,
    );
    process.exit(1);
  }
  console.log(
    `Cleared "${slug}".` +
    (force ? ' It stays cleared until its title, type or body changes.' : '') +
    (flagged ? ` (now flagged: ${flagReason} — searchable, agent warned.)` : '') +
    (noEmbed ? ' Embedding skipped (--no-embed); run `gbrain embed --stale` to make it searchable.' : ''),
  );
}

async function runScan(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const apply = args.includes('--apply');
  const noEmbed = args.includes('--no-embed');
  const limIdx = args.indexOf('--limit');
  const limit = limIdx !== -1 && args[limIdx + 1] ? parseInt(args[limIdx + 1], 10) : Infinity;

  // Re-import already-ingested pages through the gate so markers get applied
  // to junk that predates the gate (unchanged content short-circuits normal
  // sync, so it never gets re-assessed otherwise). forceRechunk bypasses the
  // content-hash short-circuit.
  //
  // Resolve the effective content_sanity config ONCE so the dry-run assessor
  // uses the SAME thresholds importFromContent will use on --apply — otherwise
  // a brain with custom bytes_warn / max_markup_ratio / prose_check_enabled
  // sees a dry-run count that doesn't match what --apply actually does.
  const { assessContentSanity } = await import('../core/content-sanity.ts');
  const { loadOperatorLiterals } = await import('../core/content-sanity-literals.ts');
  const { loadConfig, loadConfigWithEngine } = await import('../core/config.ts');
  let effCs: NonNullable<import('../core/config.ts').GBrainConfig['content_sanity']> = {};
  try {
    effCs = (await loadConfigWithEngine(engine, loadConfig()))?.content_sanity ?? {};
  } catch { /* fall back to defaults if DB-config lift fails */ }
  const scanLiterals = effCs.junk_patterns_enabled !== false ? loadOperatorLiterals() : [];

  // #6259: --apply re-imports every page through the legacy path; a managed
  // brain publishes only through its canonical owner, so refuse up front.
  if (apply && await managedPersistenceEnabled(engine)) {
    const error = opError('writer_coordinator_required', 'quarantine scan --apply cannot rewrite pages on a managed brain.',
      'It re-imports every page outside the canonical owner, so nothing was changed. Preview with gbrain quarantine scan (no --apply); new imports already pass the gate. Review hidden pages with gbrain quarantine list, then clear a false positive by passing its slug to gbrain quarantine clear with --force.',
      { fix: readFix('Previews what the gate would mark, read-only.', { argv: ['gbrain', 'quarantine', 'scan', '--json'] }) });
    if (!await reportPersistenceCliError(error, json)) throw error;
    return;
  }
  const refs = await engine.listAllPageRefs();
  let scanned = 0;
  let quarantined = 0;
  let flagged = 0;
  const touched: Array<{ slug: string; outcome: 'quarantine' | 'flag' }> = [];

  for (const ref of refs) {
    if (scanned >= limit) break;
    scanned++;
    const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
    if (!page) continue;
    // Skip pages already marked (idempotent re-runs) — quarantined OR flagged,
    // so --apply doesn't re-chunk/re-embed already-flagged pages every run.
    const pfm = page.frontmatter as Record<string, unknown> | null;
    if (isQuarantined(pfm) || getContentFlag(pfm)) continue;

    if (!apply) {
      // Dry-run: assess read-only (re-import would mutate). Same thresholds as --apply.
      const res = assessContentSanity({
        compiled_truth: page.compiled_truth ?? '',
        timeline: page.timeline ?? '',
        title: page.title ?? '',
        bytes_warn: effCs.bytes_warn,
        bytes_block: effCs.bytes_block,
        max_markup_ratio: effCs.max_markup_ratio,
        prose_check_enabled: effCs.prose_check_enabled,
        page_kind: page.type,
        extra_literals: scanLiterals,
      });
      if (res.shouldQuarantine) {
        quarantined++;
        touched.push({ slug: ref.slug, outcome: 'quarantine' });
      } else if (res.shouldFlag) {
        flagged++;
        touched.push({ slug: ref.slug, outcome: 'flag' });
      }
      continue;
    }

    // --apply: re-import so the gate sets markers + (for quarantine) drops chunks.
    const tags = await engine.getTags(ref.slug, { sourceId: ref.source_id });
    const markdown = serializePageToMarkdown(page, tags);
    const result = await importFromContent(engine, ref.slug, markdown, {
      sourceId: ref.source_id, preserveGateMarkers: true,
      noEmbed,
      forceRechunk: true,
    });
    if (result.quarantined) {
      quarantined++;
      touched.push({ slug: ref.slug, outcome: 'quarantine' });
    } else if (result.flagged) {
      flagged++;
      touched.push({ slug: ref.slug, outcome: 'flag' });
    }
  }

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, applied: apply, scanned, quarantined, flagged, touched }, null, 2));
    return;
  }
  const verb = apply ? '' : '(dry-run) would ';
  console.log(`Scanned ${scanned} page(s): ${verb}quarantine ${quarantined}, ${verb}flag ${flagged}.`);
  if (!apply && (quarantined > 0 || flagged > 0)) {
    console.log('Re-run with --apply to set the markers.');
  }
}

// ---------------------------------------------------------------------------
// Operator incident lane: set / rollback (metadata-only, fail-closed)
//
// `set`/`rollback` are the first-class, fail-closed lane for the wrong-root
// DB-only sync incident (see src/core/operator-quarantine.ts). `set` writes
// ONLY the `frontmatter.quarantine` marker to an EXACT immutable manifest of
// (id, slug, source_id, content_hash, source_path) rows — never content,
// files, aliases or chunks — as an explicit alternative to a bulk
// `gbrain import` that would bypass the git-managed source owner gate.
// Operator-only, host-bound (the thin client refuses it), allowlisted reason,
// `--yes` required to mutate, and refused outright on a managed brain.
// ---------------------------------------------------------------------------

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function defaultOperatorSnapshotPath(incident: string, manifestSha256: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(homedir(), '.gbrain', 'backups', 'operator-quarantine', `qs-${incident}-${manifestSha256.slice(0, 12)}-${stamp}.json`);
}

/** Write a private (0600) file atomically: temp file in the same directory,
 *  chmod before the rename so the final inode is never world-readable. */
function writeAtomic(path: string, data: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeAtomic(path, JSON.stringify(value, null, 2) + '\n', 0o600);
}

/** Archive the raw manifest next to the snapshot, bound by the sha256 already
 *  recorded in it, so the exact operator input survives with the artifact. */
function archiveManifest(outPath: string, manifestRaw: string): string {
  const archivePath = `${outPath.replace(/\.json$/i, '')}.manifest.jsonl`;
  writeAtomic(archivePath, manifestRaw, 0o600);
  return archivePath;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The managed-writer refusal, raised BEFORE any artifact is written. The core
 *  lane raises the same refusal at the mutation boundary; naming it here keeps
 *  a refused run from leaving a provisional snapshot behind. */
async function refuseOnManagedBrain(engine: BrainEngine, subject: string, json: boolean): Promise<boolean> {
  if (!await managedPersistenceEnabled(engine)) return false;
  const error = opError('writer_coordinator_required', `quarantine ${subject} cannot write pages on a managed brain.`,
    `It performs a direct pages UPDATE outside the canonical owner, so nothing was changed; this lane targets DB-only incident rows on an unmanaged brain. On a managed brain the marker write goes through the coordinator: gbrain quarantine clear <slug> [--force].`,
    { fix: readFix('Lists the hidden pages without changing anything.', { argv: ['gbrain', 'quarantine', 'list', '--json'] }) });
  if (!await reportPersistenceCliError(error, json)) throw error;
  return true;
}

async function runSet(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  const manifestPath = flagValue(args, '--manifest');
  const reason = flagValue(args, '--reason');
  const sourceId = flagValue(args, '--source-id') ?? 'default';
  const incident = flagValue(args, '--incident') ?? reason ?? 'operator';
  const snapshotOut = flagValue(args, '--snapshot-out');
  const limitRaw = flagValue(args, '--limit');

  const usage = () =>
    console.error(
      'Usage: gbrain quarantine set --manifest <JSONL> --reason <reason> [--source-id <id>] ' +
      '[--incident <id>] [--limit N] [--snapshot-out <path>] [--dry-run] [--yes] [--json]',
    );
  if (!manifestPath || !reason) { usage(); process.exit(2); }
  if (!(OPERATOR_QUARANTINE_REASONS as readonly string[]).includes(reason)) {
    console.error(`Unknown --reason "${reason}". Allowed: ${OPERATOR_QUARANTINE_REASONS.join(', ')}.`);
    process.exit(2);
  }
  if (limitRaw !== undefined && (!Number.isInteger(Number(limitRaw)) || Number(limitRaw) <= 0)) {
    console.error(`--limit must be a positive integer (got "${limitRaw}").`);
    process.exit(2);
  }

  let records, sha256: string, manifestRaw: string;
  try {
    manifestRaw = readFileSync(manifestPath, 'utf8');
    ({ records, sha256 } = parseOperatorManifest(manifestRaw));
  } catch (err) {
    const msg = err instanceof OperatorQuarantineError ? err.message : String(err);
    console.error(`Manifest rejected (${manifestPath}): ${msg}`);
    process.exit(2);
  }
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && records.length > limit) {
    console.error(`Manifest has ${records.length} records but --limit is ${limit}; refusing a partial apply.`);
    process.exit(2);
  }

  if (dryRun) {
    const plan = await planOperatorQuarantine(engine, records, { sourceId, incident, manifestSha256: sha256 });
    if (json) {
      console.log(JSON.stringify({
        schema_version: 1, dry_run: true, reason, incident, source_id: sourceId,
        manifest: manifestPath, manifest_sha256: sha256, source_root: plan.source_root,
        eligible: plan.eligible.length, already_quarantined: plan.already.length, rejections: plan.rejections,
      }, null, 2));
    } else {
      console.log(`[dry-run] set reason=${reason} incident=${incident} source=${sourceId} manifest_sha256=${sha256.slice(0, 12)}`);
      console.log(`  eligible: ${plan.eligible.length}  already quarantined: ${plan.already.length}  rejected: ${plan.rejections.length}`);
      for (const r of plan.rejections) console.log(`  REJECT ${r.id} ${r.slug} — ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
    }
    if (plan.rejections.length > 0) process.exit(1);
    return;
  }

  if (!yes) {
    console.error('Refusing to mutate without --yes. Re-run with --dry-run to preview, then add --yes.');
    process.exit(2);
  }
  if (await refuseOnManagedBrain(engine, 'set', json)) return;

  const now = new Date();
  // Provisional before-state snapshot (derived from reads only), written
  // atomically BEFORE the mutation so a rollback artifact is durable even if
  // the process dies mid-apply.
  const plan = await planOperatorQuarantine(engine, records, { sourceId, incident, manifestSha256: sha256 });
  if (plan.rejections.length > 0) {
    console.error(`Refusing to apply: ${plan.rejections.length} row(s) rejected; run with --dry-run for detail.`);
    process.exit(1);
  }
  if (plan.eligible.length === 0) {
    console.error('Nothing to apply (all rows already quarantined?).');
    process.exit(1);
  }
  const marker = buildOperatorQuarantineMarker(reason, { incident, manifestSha256: sha256, now });
  const outPath = snapshotOut ?? defaultOperatorSnapshotPath(incident, sha256, now);
  // Archive the exact operator input beside the snapshot (0600), bound by the
  // recorded sha256 so rollback can prove the artifact it replays.
  const manifestArchive = archiveManifest(outPath, manifestRaw);
  const provisional: OperatorQuarantineSnapshot = {
    schema_version: 1, reason, incident, source_id: sourceId, manifest_sha256: sha256,
    created_at: now.toISOString(), rows: plan.eligible.map((r) => ({ ...r, marker })),
    manifest_path: manifestArchive,
  };
  writeJsonAtomic(outPath, provisional);

  let applied: number;
  let committed: OperatorQuarantineSnapshot;
  try {
    ({ applied, snapshot: committed } = await applyOperatorQuarantine(engine, records, { sourceId, reason, incident, manifestSha256: sha256, now }));
  } catch (err) {
    // The apply re-verified inside its transaction and refused (or failed);
    // remove the provisional snapshot so it cannot be mistaken for an applied run.
    try { rmSync(outPath, { force: true }); } catch { /* ignore */ }
    try { rmSync(manifestArchive, { force: true }); } catch { /* ignore */ }
    const msg = err instanceof OperatorQuarantineError ? err.message : String(err);
    console.error(`Apply failed; no marker written: ${msg}`);
    process.exit(1);
  }
  committed.manifest_path = manifestArchive;
  // Overwrite the provisional artifact with the transaction's authoritative
  // snapshot so rollback is bound to exactly what was applied.
  writeJsonAtomic(outPath, committed);

  if (json) {
    console.log(JSON.stringify({ schema_version: 1, applied, already_quarantined: plan.already.length, reason, incident, manifest_sha256: sha256, snapshot: outPath }, null, 2));
    return;
  }
  console.log(`Quarantined ${applied} page(s) (reason=${reason}, incident=${incident}).`);
  console.log(`Before-state snapshot: ${outPath}`);
  console.log(`Rollback: gbrain quarantine rollback --snapshot ${outPath} --yes`);
}

async function runRollback(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  const snapshotPath = flagValue(args, '--snapshot');
  if (!snapshotPath) {
    console.error('Usage: gbrain quarantine rollback --snapshot <path> [--dry-run] [--yes] [--json]');
    process.exit(2);
  }
  let snap: OperatorQuarantineSnapshot;
  try {
    snap = JSON.parse(readFileSync(snapshotPath, 'utf8')) as OperatorQuarantineSnapshot;
  } catch (err) {
    console.error(`Cannot read snapshot (${snapshotPath}): ${String(err)}`);
    process.exit(2);
  }
  if (!snap || snap.schema_version !== 1 || !Array.isArray(snap.rows)) {
    console.error(`Snapshot ${snapshotPath} is not an operator-quarantine v1 snapshot.`);
    process.exit(2);
  }
  if (dryRun) {
    if (json) console.log(JSON.stringify({ schema_version: 1, dry_run: true, rows: snap.rows.length, incident: snap.incident }, null, 2));
    else console.log(`[dry-run] would roll back ${snap.rows.length} row(s) (incident=${snap.incident}).`);
    return;
  }
  if (!yes) {
    console.error('Refusing to mutate without --yes.');
    process.exit(2);
  }
  if (await refuseOnManagedBrain(engine, 'rollback', json)) return;
  // Verify the archived manifest (when present) against the sha recorded in
  // the snapshot, so a rollback replays a provably-intact artifact.
  if (snap.manifest_path) {
    let archived: string;
    try {
      archived = readFileSync(snap.manifest_path, 'utf8');
    } catch (err) {
      console.error(`Cannot read archived manifest (${snap.manifest_path}): ${String(err)}`);
      process.exit(2);
    }
    if (sha256Hex(archived) !== snap.manifest_sha256) {
      console.error(`Archived manifest (${snap.manifest_path}) sha256 does not match the snapshot; refusing rollback.`);
      process.exit(2);
    }
  }
  let rolledBack: number;
  try {
    ({ rolledBack } = await rollbackOperatorQuarantine(engine, snap));
  } catch (err) {
    const msg = err instanceof OperatorQuarantineError ? err.message : String(err);
    console.error(`Rollback failed; no marker cleared: ${msg}`);
    process.exit(1);
  }
  if (json) console.log(JSON.stringify({ schema_version: 1, rolled_back: rolledBack, incident: snap.incident }, null, 2));
  else console.log(`Rolled back ${rolledBack} page(s) (incident=${snap.incident}).`);
}

export const QUARANTINE_HELP = `Usage: gbrain quarantine <list|clear|scan|set|rollback|release|drop> [options]

  list [--json] [--include-flagged]
      Pages the content-quality gate hid as junk (quarantine), and with
      --include-flagged the searchable pages it flagged (content_flag).
      Also lists facts and takes the write gate held for review (h<id>).
  clear <slug> [--source-id <id>] [--force] [--no-embed] [--json]
      Remove the markers and write the page again; the gate re-checks it.
      --force records that the page is not junk (quarantine_override, bound
      to its title, type and body): it stays cleared until those change.
      On a managed brain the write goes through the canonical owner.
  scan [--limit N] [--apply] [--no-embed] [--json]
      Re-check existing pages against the gate (preview by default).
      --apply re-imports them and is refused on a managed brain.
  set --manifest <JSONL> --reason <reason> [--source-id <id>] [--incident <id>]
      [--limit N] [--snapshot-out <path>] [--dry-run] [--yes] [--json]
      Operator incident lane (host-bound; unmanaged brains only): apply ONLY
      the quarantine marker to the exact rows of an immutable JSONL manifest
      of {id, slug, source_id, content_hash, source_path} — the DB-only pages
      a wrong-root sync left with no file under the source root. Writes no
      content, file, alias or chunk; archives the manifest beside a 0600
      before-state snapshot for rollback. --yes is required to mutate, and a
      managed brain is refused up front.
  rollback --snapshot <path> [--dry-run] [--yes] [--json]
      Clear the markers a 'quarantine set' snapshot recorded, after
      re-verifying the archived manifest sha and every page's provenance.
  release <h<id>> | drop <h<id>>
      Aliases of gbrain trust release|drop: release a held fact or take into
      memory (asks you to type its ref), or drop it.

One junk pattern that misfires brain-wide can be turned off with
content_sanity.disabled_patterns.`;

export { QUARANTINE_SUBCOMMANDS as SUBCOMMANDS } from '../cli/subcommands.ts';
/** #6259: `gbrain quarantine --help` (router help, printed before any engine is opened). */
export function printUsage(): void { console.log(QUARANTINE_HELP); }

export async function runQuarantine(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list':
      return runList(engine, rest);
    case 'clear':
      return runClear(engine, rest);
    case 'scan':
      return runScan(engine, rest);
    case 'set':
      return runSet(engine, rest);
    case 'rollback':
      return runRollback(engine, rest);
    default:
      console.error(QUARANTINE_HELP);
      process.exit(2);
  }
}
