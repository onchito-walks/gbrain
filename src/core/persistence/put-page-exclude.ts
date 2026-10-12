import type { BrainEngine } from '../engine.ts';
import { OperationError, type Logger } from '../ops/contract.ts';
import { matchesAnyGlob } from '../sync.ts';
import { syncExcludePatterns } from './sync-discovery.ts';

/**
 * B02 (retained from the pre-v0.51 fork, adapted here): a put_page must never
 * persist content into a root the operator excluded from the brain's indexing
 * scope with `sync.exclude` — the same persisted config the sync and import
 * walkers honor. Sync skips excluded roots at walk time, so a direct write
 * bypassed the scope: it stored the page, embedded it into the graph and left a
 * file the next sync would never read again, which reads as data loss to the
 * operator who excluded that root on purpose.
 *
 * The globs are normalized by the canonical `syncExcludePatterns` (comma or
 * newline separated, trimmed, a trailing `/` widened to a `/**` subtree glob),
 * so the write-path scope and the walker scope cannot drift apart, and the
 * slug — lowercased, because that is the path the write would persist — is
 * matched against them with the walkers' own `matchesAnyGlob`.
 *
 * The guard covers the roots, never a page: no existing page is removed,
 * modified or purged, a slug that matches no excluded root falls through
 * untouched, and an unreadable config (or no configured globs) lets the write
 * through exactly as a sync would — named once in the log, so a config-read
 * failure stays visible instead of silently disabling the check.
 */
export async function assertPutPageNotSyncExcluded(engine: Pick<BrainEngine, 'getConfig'>, slug: string, logger: Logger): Promise<void> {
  let patterns: string[];
  try {
    patterns = await syncExcludePatterns(engine);
  } catch {
    logger.warn(`[put_page] sync.exclude unreadable; skipping write-path hygiene check for '${slug}'`);
    return;
  }
  if (patterns.length === 0 || !matchesAnyGlob(slug, patterns)) return;
  throw new OperationError('permission_denied',
    `put_page: refusing to write '${slug}' — its path falls under a root excluded from indexing scope by sync.exclude.`,
    `Choose a slug outside the excluded roots (${patterns.join(', ')}), or remove that root from sync.exclude if these pages should be indexed. Nothing was written, journaled or embedded.`);
}
