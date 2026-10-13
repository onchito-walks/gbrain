/**
 * Rehearsal isolation guard.
 *
 * A disposable rehearsal must never be able to write into a live brain.
 * Configuring the disposable database URL is not enough: the *writer
 * targets* the migration resolves at runtime (source roots on disk,
 * `sync.repo_path`, the shared-skill migration roots, the dream corpus
 * directory) come from rows inside the database and from `$HOME`. If any
 * of them still points at the live tree, a migration will happily write
 * real notes — which is exactly the failure this guard exists to stop.
 *
 * When `GBRAIN_REHEARSAL_ROOTS` is set (a comma-separated list of roots
 * that the rehearsal is allowed to write under), `apply-migrations`
 * refuses to start unless EVERY discovered writer target resolves —
 * after following symlinks — inside one of those roots. When the variable
 * is unset the guard does nothing, so normal production runs are
 * unaffected.
 *
 * Resolution follows symlinks on purpose: an alias such as
 * `/home/hermes/.obsidian/...` must not pass a check that only compares
 * the literal string against a disposable prefix.
 */

import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { BrainEngine } from '../engine.ts';

export const REHEARSAL_ROOTS_ENV = 'GBRAIN_REHEARSAL_ROOTS';

/** Config keys that carry a filesystem writer target. */
export const WRITER_CONFIG_KEYS = [
  'sync.repo_path',
  'dream.synthesize.session_corpus_dir',
] as const;

/** Config keys whose value is JSON that embeds `root` paths. */
export const WRITER_CONFIG_JSON_PREFIXES = [
  'shared_skills.migration.v1',
] as const;

/**
 * Parse the allowlist. Returns null when the guard is disabled, which is
 * the production default.
 */
export function parseRehearsalRoots(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env[REHEARSAL_ROOTS_ENV];
  if (raw === undefined) return null;
  const roots = raw.split(',').map(r => r.trim()).filter(Boolean).map(r => resolve(r));
  return roots.length > 0 ? roots : null;
}

/**
 * Resolve a path to its real location, following symlinks. A path that
 * does not exist yet is resolved through its longest existing ancestor so
 * a not-yet-created target still lands on the correct side of the fence.
 */
export function resolveForComparison(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    /* fall through: walk up to the longest existing prefix */
  }
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.push(cur.slice(parent.length + 1));
    cur = parent;
    try {
      const real = realpathSync.native(cur);
      return join(real, ...tail.reverse());
    } catch {
      /* keep walking up */
    }
  }
}

/** True when `child` is `root` itself or sits underneath it. */
export function isInside(child: string, root: string): boolean {
  const c = resolveForComparison(child);
  const r = resolveForComparison(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

export interface IsolationViolation {
  /** Where the target came from, e.g. `sources.local_path:default`. */
  target: string;
  /** The configured (unresolved) value. */
  configured: string;
  /** The symlink-resolved location that fell outside the allowlist. */
  resolved: string;
}

export interface IsolationCheck {
  enabled: boolean;
  roots: string[];
  checked: Array<{ target: string; configured: string; resolved: string; inside: string | null }>;
  violations: IsolationViolation[];
  ok: boolean;
}

/** Pure classifier — the whole decision, with no I/O. */
export function checkTargets(
  targets: Record<string, string | null | undefined>,
  roots: string[] | null,
): IsolationCheck {
  if (!roots) return { enabled: false, roots: [], checked: [], violations: [], ok: true };
  const checked: IsolationCheck['checked'] = [];
  const violations: IsolationViolation[] = [];
  for (const [target, configured] of Object.entries(targets)) {
    if (!configured) continue;
    if (!configured.startsWith('/')) continue;
    const resolved = resolveForComparison(configured);
    const inside = roots.find(r => isInside(configured, r)) ?? null;
    checked.push({ target, configured, resolved, inside });
    if (!inside) violations.push({ target, configured, resolved });
  }
  return { enabled: true, roots, checked, violations, ok: violations.length === 0 };
}

/** Absolute-looking strings embedded anywhere in a JSON config value. */
function absolutePathsIn(value: string): string[] {
  const hits = value.match(/"\/[^"]+"/g) ?? [];
  return hits.map(h => h.slice(1, -1));
}

/**
 * Every filesystem writer target this brain can reach: source roots, the
 * configured sync/corpus directories, the shared-skill migration roots,
 * and the process-level roots a migration writes through (`$HOME`, the
 * temporary directory, the skills directory).
 */
export async function collectWriterTargets(
  engine: BrainEngine,
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | null>> {
  const targets: Record<string, string | null> = {};

  const sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
    'SELECT id, local_path FROM sources',
  );
  for (const s of sources) targets[`sources.local_path:${s.id}`] = s.local_path;

  const rows = await engine.executeRaw<{ key: string; value: string | null }>(
    `SELECT key, value FROM config
      WHERE key = ANY($1) OR key LIKE $2`,
    [[...WRITER_CONFIG_KEYS], `${WRITER_CONFIG_JSON_PREFIXES[0]}%`],
  );
  for (const row of rows) {
    if (!row.value) continue;
    if ((WRITER_CONFIG_KEYS as readonly string[]).includes(row.key)) {
      targets[`config.${row.key}`] = row.value.trim().startsWith('/') ? row.value.trim() : null;
      continue;
    }
    for (const [i, p] of absolutePathsIn(row.value).entries()) {
      targets[`config.${row.key}#root${i}`] = p;
    }
  }

  // Process-level roots the migration writes through.
  targets['env.HOME'] = env.HOME ?? null;
  targets['env.TMPDIR'] = env.TMPDIR ?? null;
  targets['env.GBRAIN_SKILLS_DIR'] = env.GBRAIN_SKILLS_DIR ?? null;
  targets['env.GBRAIN_HOME'] = env.GBRAIN_HOME ?? null;

  return targets;
}

/** Human-readable refusal text, naming every offending target. */
export function isolationViolationMessage(check: IsolationCheck): string {
  const lines = check.violations.map(
    v => `  - ${v.target} = ${v.configured} (resolves to ${v.resolved})`,
  );
  return `Rehearsal isolation refused: ${check.violations.length} writer target(s) fall outside ` +
    `${REHEARSAL_ROOTS_ENV} (${check.roots.join(', ')}):\n${lines.join('\n')}\n` +
    'Nothing was applied. Point every source/config/absolute path at a disposable copy, ' +
    'or unset GBRAIN_REHEARSAL_ROOTS for a normal (non-rehearsal) run.';
}
