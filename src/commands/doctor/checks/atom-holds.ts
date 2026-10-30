/**
 * extract_atoms_held_failed (#6325): atom origins the extractor stopped
 * retrying after MAX_DETERMINISTIC_FAILURES failed extractions of the same
 * content. Two stores hold them: a managed `managed-atoms` checkpoint
 * (code `held_failed`) and an unmanaged current-content tombstone in
 * `extract_atoms_page_state` / `extract_atoms_transcript_state`. Both leave
 * the atom backlog, so this is the surface that keeps either from being
 * skipped silently: each row names its last request id (managed) or the
 * tombstone that requires a content edit (unmanaged). Reads the database,
 * plus the current bytes of a tombstoned transcript to confirm its revision.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { listHeldAtomTombstones, listHeldManagedAtoms } from '../../../core/persistence/atom-maintenance.ts';
import { currentTranscriptHash } from '../../../core/cycle/transcript-discovery.ts';
import { isUndefinedTableError } from '../../../core/utils.ts';
import { shellQuote } from '../../../core/agent-output.ts';
import { checkError, doctorVerify } from '../check-fix.ts';

const retryArgv = (sourceId: string, requestId: string): string[] =>
  ['gbrain', 'jobs', 'submit', 'extract-atoms-drain', '--params', JSON.stringify({ sourceId, retryRequestId: requestId })];

async function runAtomHeldFailedCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const [managed, tombstones] = await Promise.all([
      listHeldManagedAtoms(engine),
      listHeldAtomTombstones(engine).catch(error => {
        if (isUndefinedTableError(error)) return []; // pre-v146/v163 brain: no tombstone stores yet
        throw error;
      }),
    ]);
    // A transcript tombstone row records a hash, not the file's current state; keep it only while the file still hashes to it.
    const current = tombstones.filter(item => item.kind === 'page'
      || currentTranscriptHash(item.locator)?.slice(0, 16) === item.content_hash);
    const seen = new Set<string>();
    const items = [
      ...managed.map(item => ({ ...item, held_by: 'checkpoint' as const })),
      ...current.map(item => ({ ...item, request_id: null, held_by: 'tombstone' as const,
        failure: 'content tombstoned after repeated extraction failures' })),
    ].filter(item => {
      const key = `${item.source_id}\u0000${item.kind}\u0000${item.locator}`; // checkpoint wins over its own tombstone row
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(item => item.request_id
      ? { ...item, receipt_command: `gbrain write-request -- ${item.request_id}`,
        retry_command: shellQuote(retryArgv(item.source_id, item.request_id)) }
      : item);
    const details = { held: items.length, items, code: 'held_failed' };
    if (!items.length) {
      checks.push({ name: 'extract_atoms_held_failed', status: 'ok', message: 'No current atom page or locally readable transcript is held after repeated extraction failures.', details });
      return checks;
    }
    const first = items[0]!;
    const retryable = items.find(item => item.request_id);
    const describe = (item: typeof first) => item.request_id
      ? `${item.source_id}:${item.locator} (request ${item.request_id}: ${item.failure})`
      : `${item.source_id}:${item.locator} (tombstoned: ${item.failure})`;
    checks.push({ name: 'extract_atoms_held_failed', status: 'warn', details,
      message: `${items.length} atom origin(s) held after ${first.attempts} failed extraction attempts on the same content (held_failed): `
        + `${items.slice(0, 5).map(describe).join('; ')}${items.length > 5 ? `; and ${items.length - 5} more` : ''}. `
        + 'They are out of the atom backlog until their content changes; a checkpoint-held item also accepts the reviewed retry.',
      ...(retryable?.request_id ? { fix: { argv: retryArgv(retryable.source_id, retryable.request_id), consent: ['paid'], actor: 'agent', requires_exclusive: false,
        why: `Queues one reviewed paid retry of the held atom batch ${retryable.request_id} (${retryable.source_id}:${retryable.locator}); read its receipt first with gbrain write-request -- ${retryable.request_id}. Repeat per held checkpoint item in details.items.`,
        verify: doctorVerify('extract_atoms_held_failed') } } : {}) });
  } catch (error) {
    checks.push(checkError('extract_atoms_held_failed', 'list held atom origins', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const atomHeldFailedEntry: DoctorEntry = { name: 'extract_atoms_held_failed', emits: ['extract_atoms_held_failed'], run: runAtomHeldFailedCheck };
