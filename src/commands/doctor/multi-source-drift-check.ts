import type { BrainEngine } from '../../core/engine.ts';
import { findMisroutedPages, positiveIntEnv, type MisroutedResult, type SourceWithPath } from '../../core/multi-source-drift.ts';
import { beforeDriftDeadline } from '../../core/multi-source-drift-walk.ts';
import type { Check } from '../doctor.ts';

export { multiSourceDriftCheck } from './schema-pack-checks.ts';
import { multiSourceDriftCheck } from './schema-pack-checks.ts';

export async function checkMultiSourceDrift(
  engine: BrainEngine | null,
  opts: { sourceIds?: string[]; remote?: boolean; managed?: boolean; limit?: number; timeoutMs?: number } = {},
): Promise<Check | null> {
  const unknown = (message: string): Check => ({ name: 'multi_source_drift', status: 'warn', message });
  if (!engine) return unknown('Multi-source drift verification unavailable: database not connected; health is unknown.');
  // A real Readwise tree can require more than five seconds of filesystem IO.
  // Keep one bounded deadline, shared by roster reads and the complete walk;
  // explicit caller budgets still take precedence and exhaustion remains WARN.
  const timeoutMs = opts.timeoutMs ?? positiveIntEnv('GBRAIN_DRIFT_TIMEOUT_MS') ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  try {
    const sources = await beforeDriftDeadline(deadline, () => engine.executeRaw<SourceWithPath>(
      `SELECT id, local_path, config FROM sources ${opts.sourceIds ? 'WHERE id = ANY($1::text[])' : ''}`,
      opts.sourceIds ? [opts.sourceIds] : undefined));
    const eligible = sources.filter(source => source.id !== 'default' && source.local_path);
    if (!eligible.length) return null;
    // No read outside a scoped caller's grant, including the comparison source.
    if (opts.sourceIds && !opts.sourceIds.includes('default')) {
      return unknown('Multi-source drift verification unavailable in this source scope; comparison source is not authorized. Health is unknown.');
    }
    return multiSourceDriftCheck(await findMisroutedPages(engine, eligible,
      { limit: opts.limit, timeoutMs: Math.max(0, deadline - Date.now()) }), eligible.length, opts.remote ? 'remote' : 'local', opts.managed ?? false);
  } catch {
    // Do not echo DB errors: connection strings and excluded source names can be private.
    return unknown('Multi-source drift verification failed or timed out; database/coverage state could not be read. Health is unknown.');
  }
}
