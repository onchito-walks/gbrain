/** Read-only Markdown drift heuristic. Incomplete coverage is never verified clean. */
import { stat } from 'node:fs/promises';
import type { BrainEngine } from './engine.ts';

import { classifyImportHold, parseMarkdown } from './markdown.ts';
import { hasMalformedPathSegment, slugifyPath } from './sync.ts';
import { validateSlug } from './utils.ts';
import { readSlugRootMode, resolveSlugRootMode } from './sync-anchor.ts';
import { beforeDriftDeadline, DriftDeadlineError, resolveDriftGitScope, walkDriftMarkdown } from './multi-source-drift-walk.ts';
import type { DriftSyncOptions } from './multi-source-drift-walk.ts';

export interface SourceWithPath { id: string; local_path: string; config?: Record<string, unknown> | string | null }
export interface MisroutedSample { slug: string; intended_source: string; local_path: string }
export interface DriftCoverageIssue {
  source_id: string;
  reason: 'git_root_unresolved' | 'filesystem' | 'identity' | 'database' | 'deadline' | 'limit' | 'configuration' | 'unsupported_strategy';
}
export interface MisroutedResult {
  walk_truncated: boolean;
  count: number;
  sample: MisroutedSample[];
  git_root_skipped: string[];
  verification_complete: boolean;
  checked_sources: string[];
  candidates_checked: number;
  coverage_issues: DriftCoverageIssue[];
  unreadable_sources: Array<{ source_id: string; reason: 'root_unreadable' | 'subdirs_unreadable'; dirs: number }>;
  limit: number;
  timeout_ms: number;
}
const DEFAULT_FILE_LIMIT = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 250;
/**
 * Import-admission slug identity for one walked file, inlined from the
 * authoritative `importFromFile` resolver (src/core/import-file.ts): the
 * path-derived slug wins; an undefined path slug falls back to frontmatter;
 * a normalization-equivalent frontmatter slug restores the stored key. A
 * conflicting frontmatter slug is a coverage issue, never a compared slug.
 */
function driftResolvedSlug(relPath: string, parsed: ReturnType<typeof parseMarkdown>): { slug?: string; conflict?: boolean } {
  const expected = slugifyPath(relPath);
  if (hasMalformedPathSegment(relPath) || classifyImportHold(parsed, { expectedSlug: expected })) return { conflict: true };
  if (expected === '') return { slug: parsed.slug && parsed.slug.length > 0 ? parsed.slug : undefined };
  if (parsed.slug !== expected && slugifyPath(parsed.slug) !== expected) return { conflict: true };
  return { slug: parsed.slug !== expected ? parsed.slug : expected };
}

export function positiveIntEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const n = Number(value);
  // An explicitly invalid budget is unknown coverage, not a silent default.
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}
const patterns = (value: string | null) => (value ?? '').split(/[\n,]/).map(p => p.trim()).filter(Boolean)
  .map(p => p.endsWith('/') ? `${p}**` : p);

async function batchProbeExistence(engine: BrainEngine, slugs: string[], sourceId: string): Promise<Map<string, Set<string>>> {
  if (!slugs.length) return new Map();
  const placeholders = slugs.map((_, i) => `($${i + 1}::text)`).join(', ');
  const rows = await engine.executeRaw<{ slug: string; source_id: string | null }>(`
    WITH candidates(slug) AS (VALUES ${placeholders})
    SELECT c.slug, p.source_id FROM candidates c
    LEFT JOIN pages p ON p.slug = c.slug AND p.deleted_at IS NULL
      AND p.source_id IN ('default', $${slugs.length + 1}::text)
    ORDER BY c.slug, p.source_id`, [...slugs, sourceId]);
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!map.has(row.slug)) map.set(row.slug, new Set());
    if (row.source_id !== null) map.get(row.slug)!.add(row.source_id);
  }
  return map;
}

/** Active source_path identities, source-scoped and ambiguity-detecting (no first-row wins). */
async function storedIdentities(engine: BrainEngine, paths: string[], sourceId: string): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ source_path: string; source_id: string; slug: string }>(`
    SELECT source_path, source_id, slug FROM pages
    WHERE deleted_at IS NULL AND source_id IN ('default', $2::text)
      AND source_path = ANY($1::text[])`, [paths, sourceId]);
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.source_id}\0${row.source_path}`;
    const previous = map.get(key);
    if (previous && previous !== row.slug) throw new Error('Ambiguous stored source path');
    map.set(key, row.slug);
  }
  return map;
}

export async function findMisroutedPages(
  engine: BrainEngine, sources: SourceWithPath[], opts: { limit?: number; timeoutMs?: number } = {},
): Promise<MisroutedResult> {
  const limit = opts.limit ?? positiveIntEnv('GBRAIN_DRIFT_LIMIT') ?? DEFAULT_FILE_LIMIT;
  const timeoutMs = opts.timeoutMs ?? positiveIntEnv('GBRAIN_DRIFT_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
  const result: MisroutedResult = { walk_truncated: false, count: 0, sample: [], git_root_skipped: [],
    verification_complete: true, checked_sources: [], candidates_checked: 0, coverage_issues: [], unreadable_sources: [], limit, timeout_ms: timeoutMs };
  const eligible = sources.filter(source => source.id !== 'default' && source.local_path);
  const issue = (source_id: string, reason: DriftCoverageIssue['reason']) => {
    result.verification_complete = false;
    if (!result.coverage_issues.some(i => i.source_id === source_id && i.reason === reason)) result.coverage_issues.push({ source_id, reason });
    if (reason === 'deadline' || reason === 'limit') result.walk_truncated = true;
  };
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    for (const src of eligible) issue(src.id, 'configuration');
    return result;
  }
  const deadline = Date.now() + timeoutMs;
  let options: DriftSyncOptions;
  try {
    const exclude = await beforeDriftDeadline(deadline, () => engine.getConfig('sync.exclude'));
    const hidden = await beforeDriftDeadline(deadline, () => engine.getConfig('sync.include_hidden'));
    options = { strategy: 'markdown', exclude: patterns(exclude), includeHidden: patterns(hidden) };
  } catch (error) {
    for (const src of eligible) issue(src.id, error instanceof DriftDeadlineError ? 'deadline' : 'configuration');
    return result;
  }
  let visited = 0;
  for (const src of eligible) {
    const initialIssues = result.coverage_issues.length;
    if (Date.now() >= deadline) { issue(src.id, 'deadline'); continue; }
    if (visited >= limit) { issue(src.id, 'limit'); continue; }
    let phase: DriftCoverageIssue['reason'] = 'configuration';
    try {
      const config = typeof src.config === 'string' ? JSON.parse(src.config) : src.config;
      if (config && (!Array.isArray(config) && typeof config === 'object')) {
        // Markdown is this check's deliberate domain, not code/image/company-plan certification.
        if (config.strategy && config.strategy !== 'markdown') { issue(src.id, 'unsupported_strategy'); continue; }
      } else if (config != null) { issue(src.id, 'configuration'); continue; }
      if (config?.slug_root_mode != null && config.slug_root_mode !== 'git-root' && config.slug_root_mode !== 'source-root') {
        issue(src.id, 'configuration'); continue;
      }
      phase = 'filesystem';
      try {
        const root = await beforeDriftDeadline(deadline, () => stat(src.local_path));
        if (!root.isDirectory()) throw new Error('Source root is not a directory');
      } catch (error) {
        if (error instanceof DriftDeadlineError) throw error;
        result.unreadable_sources.push({ source_id: src.id, reason: 'root_unreadable', dirs: 1 });
        issue(src.id, 'filesystem');
        continue;
      }
      phase = 'database';
      let mode = await beforeDriftDeadline(deadline, () => readSlugRootMode(engine, src.id));
      let scope = { slugPrefix: '', pathPrefix: '' };
      if (mode !== 'source-root') {
        try { scope = await resolveDriftGitScope(src.local_path, deadline); }
        catch (error) {
          if (mode === 'git-root') {
            result.git_root_skipped.push(src.id);
            issue(src.id, 'git_root_unresolved');
            if (error instanceof DriftDeadlineError || Date.now() >= deadline) issue(src.id, 'deadline');
            continue;
          }
          if (error instanceof DriftDeadlineError || Date.now() >= deadline) throw new DriftDeadlineError();
          // An unpinned non-Git import uses source-root identity, just like sync.
        }
        if (!mode && scope.pathPrefix) mode = await beforeDriftDeadline(deadline, () => resolveSlugRootMode(engine,
          { sourceId: src.id, explicitGitRoot: false, slugPrefix: scope.slugPrefix, dryRun: true }));
      }
      const prefix = mode === 'git-root' ? scope.pathPrefix : '';
      phase = 'filesystem';
      const walk = await walkDriftMarkdown(src.local_path, limit - visited, deadline, options);
      visited += walk.files.length;
      if (walk.errors) {
        result.unreadable_sources.push({ source_id: src.id, reason: 'subdirs_unreadable', dirs: walk.errors });
        issue(src.id, 'filesystem');
      }
      if (walk.truncated) issue(src.id, Date.now() >= deadline ? 'deadline' : 'limit');
      const seen = new Map<string, string>();
      for (let offset = 0; offset < walk.files.length; offset += BATCH_SIZE) {
        const files = walk.files.slice(offset, offset + BATCH_SIZE);
        const paths = files.map(file => prefix ? `${prefix}/${file.relPath}` : file.relPath);
        phase = 'database';
        const identities = await beforeDriftDeadline(deadline, () => storedIdentities(engine, paths, src.id));
        const candidates: string[] = [];
        for (let i = 0; i < files.length; i++) {
          if (Date.now() >= deadline) throw new DriftDeadlineError();
          phase = 'identity';
          // Match import admission, including normalization-equivalent restored keys.
          const parsed = parseMarkdown(files[i].content, paths[i], { validate: true });
          const selected = driftResolvedSlug(paths[i], parsed);
          if (selected.conflict) { issue(src.id, 'identity'); continue; }
          const intended = identities.get(`${src.id}\0${paths[i]}`);
          const atDefault = identities.get(`default\0${paths[i]}`);
          // Both engines canonicalize writes through validateSlug after import selection.
          const slug = intended ?? atDefault ?? (selected.slug ? validateSlug(selected.slug) : '');
          if (!slug) { issue(src.id, 'identity'); continue; }
          const previousPath = seen.get(slug);
          if (previousPath && previousPath !== paths[i]) { issue(src.id, 'identity'); continue; }
          if (!previousPath) { seen.set(slug, paths[i]); candidates.push(slug); }
        }
        phase = 'database';
        const existence = await beforeDriftDeadline(deadline, () => batchProbeExistence(engine, candidates, src.id));
        result.candidates_checked += candidates.length;
        for (const slug of candidates) {
          const present = existence.get(slug);
          if (present?.has('default') && !present.has(src.id)) {
            result.count++;
            if (result.sample.length < 5) result.sample.push({ slug, intended_source: src.id, local_path: src.local_path });
          }
        }
      }
      if (result.coverage_issues.length === initialIssues) result.checked_sources.push(src.id);
    } catch (error) { issue(src.id, error instanceof DriftDeadlineError ? 'deadline' : phase); }
  }
  return result;
}
