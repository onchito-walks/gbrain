/** Complete a cycle without invalidating its own complete-source-bound documents.
 * This is one explicit transition, not a drift repair: every prior document must
 * still be current, and only the two completion keys change. The source stamp
 * and versioned derived publications commit together or neither does.
 */
import type { BrainEngine } from '../engine.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import { prepareCoreGuard } from '../persistence/core-guard.ts';
import { sha256, stableJson } from '../persistence/digest.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { planPreservedFencePublication, type OriginalRecord } from '../facts/preserved-fence-publication.ts';
import {
  PRESERVED_FENCE_SOURCE, assertPublicationIsCurrent, readPreservedFenceOriginals,
  readPreservedFencePublication, writePublicationRow,
} from '../facts/preserved-fence-store.ts';

export const COMPLETE_PRESERVED_CYCLE_INTENT = 'managed_maintenance_complete_preserved_cycle';
interface CompletionInput {
  source: OriginalRecord;
  documents: { slug: string; digest: string }[];
  completedAt: string;
}

function refuse(detail: string): never { throw new Error(`preserved_cycle_completion_refused: ${detail}`); }

async function documents(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ slug: string; data: unknown }>(
    `SELECT p.slug, rd.data FROM raw_data rd JOIN pages p ON p.id = rd.page_id
      WHERE p.source_id = $1 AND rd.source = $2 ORDER BY p.slug`, [sourceId, PRESERVED_FENCE_SOURCE]);
}

async function readInput(engine: BrainEngine, sourceId: string, completedAt: string): Promise<CompletionInput> {
  const [source] = await engine.executeRaw<OriginalRecord>('SELECT * FROM sources WHERE id = $1', [sourceId]);
  if (!source) refuse('source missing');
  const rows = await documents(engine, sourceId);
  for (const { slug } of rows) {
    const stored = await readPreservedFencePublication(engine, sourceId, slug);
    if (!stored) refuse('document disappeared');
    await assertPublicationIsCurrent(engine, sourceId, slug, stored);
  }
  return { source, completedAt, documents: rows.map(row => ({ slug: row.slug, digest: sha256(stableJson(row.data)) })) };
}

/** Re-check the exact source, document membership, document bytes AND complete originals. */
async function validate(engine: BrainEngine, sourceId: string, input: CompletionInput): Promise<void> {
  const current = await readInput(engine, sourceId, input.completedAt);
  if (stableJson(current) !== stableJson(input)) refuse('source or document population changed before completion');
}

async function lockOriginals(tx: BrainEngine, sourceId: string, input: CompletionInput): Promise<void> {
  await tx.executeRaw('SELECT id FROM sources WHERE id = $1 FOR UPDATE', [sourceId]);
  await tx.lockPageKeys(input.documents.map(({ slug }) => ({ sourceId, slug })));
  // Row locks also fence direct/unmanaged updates, not just coordinator writers.
  await tx.executeRaw('SELECT id FROM pages WHERE source_id = $1 ORDER BY id FOR SHARE', [sourceId]);
  await tx.executeRaw('SELECT id FROM facts WHERE source_id = $1 ORDER BY id FOR SHARE', [sourceId]);
  await tx.executeRaw(`SELECT rd.id FROM raw_data rd JOIN pages p ON p.id = rd.page_id
    WHERE p.source_id = $1 AND rd.source = $2 ORDER BY rd.id FOR UPDATE OF rd`, [sourceId, PRESERVED_FENCE_SOURCE]);
}

/** Caller owns the transaction and (for managed brains) the coordinator capability. */
async function apply(tx: BrainEngine, sourceId: string, input: CompletionInput): Promise<void> {
  await lockOriginals(tx, sourceId, input);
  await validate(tx, sourceId, input);
  const previousConfig = input.source.config as Record<string, unknown> | null;
  if (previousConfig?.last_source_cycle_at === input.completedAt && previousConfig?.last_full_cycle_at === input.completedAt) return;
  if (!await tx.updateSourceConfig(sourceId, {
    last_source_cycle_at: input.completedAt, last_full_cycle_at: input.completedAt,
  })) refuse('source disappeared');
  const [after] = await tx.executeRaw<OriginalRecord>('SELECT * FROM sources WHERE id = $1', [sourceId]);
  const config = input.source.config;
  // Refuse historical malformed config rather than normalizing an original as
  // a side effect of this transition. The ordinary no-document stamp is unchanged.
  if (!config || typeof config !== 'object' || Array.isArray(config)) refuse('source config is not an object');
  const expectedSource = { ...input.source, config: { ...config,
    last_source_cycle_at: input.completedAt, last_full_cycle_at: input.completedAt } };
  if (stableJson(after) !== stableJson(expectedSource)) refuse('source changed beyond completion keys');
  for (const { slug } of input.documents) {
    const originals = await readPreservedFenceOriginals(tx, sourceId, slug);
    // Replacing ONLY the known source postimage with its preimage must recreate
    // the validated old document. A page/fact/file edit cannot be blessed here.
    const previous = await readPreservedFencePublication(tx, sourceId, slug);
    const priorPlan = planPreservedFencePublication({ ...originals.input, source: input.source });
    if (stableJson(previous) !== stableJson(priorPlan)) refuse('originals changed during completion');
    const next = planPreservedFencePublication(originals.input);
    await writePublicationRow(tx, sourceId, slug, next, { versionExisting: true });
    await assertPublicationIsCurrent(tx, sourceId, slug, next);
  }
}

/** Called only after runCycle's existing success/abort/dry-run gate. */
export async function completeSourceCycle(engine: BrainEngine, sourceId: string, completedAt: string): Promise<void> {
  // Preserve the original low-cost path (and its engine contract) for sources
  // without any preserved publication; no maintenance authority is invented.
  if ((await documents(engine, sourceId)).length === 0) {
    await engine.updateSourceConfig(sourceId, { last_source_cycle_at: completedAt, last_full_cycle_at: completedAt });
    return;
  }
  const input = await readInput(engine, sourceId, completedAt);
  if (!await managedPersistenceEnabled(engine)) {
    await maintenanceTransaction(engine, tx => apply(tx, sourceId, input));
    return;
  }
  const authority = await maintenancePreflight(engine, sourceId);
  if (!authority) refuse('no maintenance authority');
  const slug = input.documents[0]!.slug;
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) refuse('page disappeared');
  const intent = { kind: COMPLETE_PRESERVED_CYCLE_INTENT, expected_revision: snapshot.revision,
    source_incarnation: authority.writer.sourceIncarnation, completion: input };
  const key = sha256(stableJson({ sourceId, intent }));
  const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const receipt = await submitDatabaseMaintenanceIntent(engine, authority, slug, intent, requestId);
  if (receipt.published !== true) refuse('completion did not publish');
}

/** Source-wide coordinator transaction, with the usual authority/owner/current-original guards. */
export async function preparePreservedCycleCompletion(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const input = row.intent?.completion as CompletionInput | undefined;
  if (row.intent?.source_incarnation !== row.source_incarnation || !input ||
      !Array.isArray(input.documents) || !input.documents.length ||
      typeof input.completedAt !== 'string' || !Number.isFinite(Date.parse(input.completedAt)) ||
      input.source?.id !== row.source_id || input.documents[0]?.slug !== row.slug) refuse('invalid completion intent');
  await validate(engine, row.source_id, input);
  const guards: { core: Awaited<ReturnType<typeof prepareCoreGuard>>; revision: string | null }[] = [];
  for (const { slug } of input.documents) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: row.source_id });
    if (!snapshot) refuse('page disappeared');
    const core = await prepareCoreGuard(engine, { row: { ...row, slug }, snapshot,
      incoming: { title: snapshot.page.title, compiled_truth: snapshot.page.compiled_truth, frontmatter: snapshot.page.frontmatter } });
    guards.push({ core, revision: snapshot.revision });
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  return { sourceExclusive: true, observedRevision: snapshot!.revision,
    additionalPageKeys: input.documents.map(({ slug }) => ({ sourceId: row.source_id, slug })),
    exclusiveSources: [...new Set(guards.flatMap(({ core }) => core?.exclusiveSources ?? []))],
    validate: async tx => {
      await lockOriginals(tx, row.source_id, input);
      await validate(tx, row.source_id, input);
      for (const { core } of guards) await core?.validate(tx);
    },
    apply: async tx => {
      await apply(tx, row.source_id, input);
      for (const { core, revision } of guards) await core?.record(tx, revision);
      return { status: 'completed', published: true, documents: input.documents.length };
    } };
}
