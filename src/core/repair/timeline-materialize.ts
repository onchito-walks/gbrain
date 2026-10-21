/**
 * `managed_maintenance_timeline_materialize`: the database-only lane that
 * writes a page's stored timeline rows back into its own body when the page's
 * path is under `sync.exclude`.
 *
 * `gbrain repair timeline` republishes a page through `put_page`
 * (repair/timeline.ts). For a page whose path falls under an excluded root,
 * B02's write-path hygiene (persistence/put-page-exclude.ts) refuses that
 * `put_page` — correctly, because sync would never read a file written there.
 * Legacy receipt pages under such a root are database-only (they record no
 * `source_path`) and their rows are only reachable from the database, so the
 * repair exists for exactly them: no file is written, deleted or compared.
 *
 * The lane reuses the maintenance publication (owner-checked by
 * `maintenancePreflight`, admitted by `submitDatabaseMaintenanceIntent` with no
 * worktree binding) and the ordinary page preparation, so the page update, its
 * canonical projection and the journal receipt commit together in the
 * coordinator's transaction under the canonical writer.
 *
 * What a caller may put in the intent is deliberately nothing:
 *
 *   - `expected_revision` binds the request to the page revision (and page id)
 *     it was planned against; `submitMaintenance` and the preparation both
 *     re-check it under lock.
 *   - `preimage_digest` is the digest of the page's *own* serialized body at
 *     planning time. The preparer never reads content from the intent: it
 *     re-serializes the stored page it just read and refuses if that digest
 *     differs, so no caller can submit a body, tags, type or frontmatter edit
 *     through this lane. Any other intent field is refused by name.
 *
 * The postimage is verified inside the publication transaction: the compiled
 * body, type, tags, facts rows, timeline row ids and `emotional_weight` must
 * be exactly what they were, and `pages.timeline` must equal the deterministic
 * materialization of the stored rows that preparation computed. A write that
 * changed anything else throws and the transaction rolls back.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { serializePageToMarkdown, parseMarkdown } from '../markdown.ts';
import { matchesAnyGlob } from '../sync.ts';
import { digest } from '../persistence/digest.ts';
import { opError } from '../ops/contract.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import { syncExcludePatterns } from '../persistence/sync-discovery.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { materializeTimeline } from '../persistence/canonical-projections.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';

export const TIMELINE_MATERIALIZE_INTENT = 'managed_maintenance_timeline_materialize';

/** The only fields this lane accepts; everything else is a forged payload. */
const INTENT_FIELDS: ReadonlySet<string> = new Set(['kind', 'expected_revision', 'preimage_digest']);

/** The digest and page facts a request is bound to, re-checked inside the publication transaction. */
interface MaterializationPreimage {
  content: string;
  /** The whole timeline field the deterministic materialization produces. */
  timeline: string;
  materializable: number;
  facts: string;
  timeline_row_ids: number[];
  emotional_weight: number;
}

export interface TimelineMaterialization {
  content: string;
  timeline: string;
  materializable: number;
  preimage_digest: string;
}

/** Whether `slug` falls under a `sync.exclude` root, exactly as the walkers and put_page read it. */
export async function isSyncExcludedSlug(engine: Pick<BrainEngine, 'getConfig'>, slug: string): Promise<boolean> {
  const patterns = await syncExcludePatterns(engine);
  return patterns.length > 0 && matchesAnyGlob(slug.toLowerCase(), patterns);
}

/**
 * Whether a page is one this lane may repair: it exists, is live, records no
 * canonical file (the excluded root never indexed it) and its path is still
 * excluded. A page that records a file is file-authoritative and stays out.
 */
export async function isExcludedDatabaseOnlyPage(engine: BrainEngine, slug: string, sourceId: string,
  snapshot?: PageSnapshot | null): Promise<boolean> {
  const read = snapshot === undefined ? await engine.readPageSnapshot(slug, { sourceId }) : snapshot;
  if (!read || read.page.deleted_at || read.page.source_path || read.page.source_uri?.startsWith('file:')) return false;
  // Planning only: an unreadable config leaves the page to the ordinary lane.
  return isSyncExcludedSlug(engine, slug).catch(() => false);
}

/**
 * The one content this lane may publish: the page serialized from its stored
 * body and the bullets its stored rows render, with the ordinary preparation's
 * own `materializeTimeline` deciding what is renderable.
 */
export async function planTimelineMaterialization(engine: BrainEngine, slug: string, sourceId: string,
  snapshot: PageSnapshot): Promise<TimelineMaterialization> {
  const content = serializePageToMarkdown(snapshot.page, snapshot.tags);
  const parsed = parseMarkdown(content, slug);
  const { timeline, materialized } = await materializeTimeline(engine, parsed, slug, snapshot, 'preserving');
  return { content, timeline, materializable: materialized, preimage_digest: digest(content) };
}

async function materializationPreimage(engine: BrainEngine, row: WriteRequest, plan: TimelineMaterialization): Promise<MaterializationPreimage> {
  const facts = await engine.executeRaw('SELECT id,row_num,fact,visibility,expired_at FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id',
    [row.source_id, row.slug]);
  const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM timeline_entries WHERE page_id=$1 ORDER BY id', [row.page_id]);
  const [page] = await engine.executeRaw<{ emotional_weight: number }>('SELECT emotional_weight FROM pages WHERE id=$1 AND source_id=$2',
    [row.page_id, row.source_id]);
  return { content: plan.content, timeline: plan.timeline, materializable: plan.materializable, facts: digest(facts),
    timeline_row_ids: rows.map(r => Number(r.id)), emotional_weight: Number(page?.emotional_weight ?? 0) };
}

/**
 * The materialization's whole contract, checked against the committed row: the
 * body, type, tags, facts, timeline rows and score are untouched and the
 * timeline field is exactly the deterministic materialization.
 */
async function assertMaterializationOnly(tx: BrainEngine, row: WriteRequest, before: PageSnapshot,
  preimage: MaterializationPreimage): Promise<void> {
  const [after] = await tx.executeRaw<{ id: number; compiled_truth: string; timeline: string; type: string; emotional_weight: number }>(
    'SELECT id,compiled_truth,timeline,type,emotional_weight FROM pages WHERE id=$1 AND source_id=$2', [before.page.id, row.source_id]);
  const current = await tx.readPageSnapshot(row.slug, { sourceId: row.source_id });
  const facts = await tx.executeRaw('SELECT id,row_num,fact,visibility,expired_at FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id',
    [row.source_id, row.slug]);
  const rows = new Set((await tx.executeRaw<{ id: number }>('SELECT id FROM timeline_entries WHERE page_id=$1', [before.page.id])).map(r => Number(r.id)));
  const changed = [
    after && after.compiled_truth !== before.page.compiled_truth ? 'body' : null,
    !after || after.timeline !== preimage.timeline ? 'timeline' : null,
    !after || after.type !== before.page.type ? 'type' : null,
    digest([...(current?.tags ?? [])].sort()) !== digest([...before.tags].sort()) ? 'tags' : null,
    digest(facts) !== preimage.facts ? 'facts' : null,
    preimage.timeline_row_ids.some(id => !rows.has(id)) ? 'timeline_rows' : null,
    Number(after?.emotional_weight ?? -1) !== preimage.emotional_weight ? 'emotional_weight' : null,
  ].filter((part): part is string => part !== null);
  if (changed.length) {
    throw opError('invalid_params', `The timeline materialization of ${row.slug} changed more than its timeline.`,
      `Request ${row.request_id} for ${row.slug} in ${row.source_id} would have changed ${changed.join(', ')} as well as its timeline, so it rolled back; the page, its rows and its score are exactly as they were. This is a gbrain defect, not caller input: report the request ID with the gbrain version.`);
  }
}

function pageChanged(row: WriteRequest, message: string): ReturnType<typeof opError> {
  return opError('page_not_found', message,
    `The database-only timeline materialization request ${row.request_id} for ${row.slug} in ${row.source_id} found no live page at the revision it was planned against, so it wrote nothing. Run gbrain repair timeline --apply again to plan from the current pages.`);
}

/**
 * Preparer for `managed_maintenance_timeline_materialize`. Runs only through
 * the coordinator: a remote writer has no path here (and `submit_job` only
 * accepts the sync/import/lint jobs remotely), so the lane is trusted-local.
 */
export async function prepareTimelineMaterialize(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  if (row.authority.remote !== false) {
    throw trustedCliRequired('A database-only timeline materialization runs only from the brain host\'s local CLI writer; remote maintenance writes are not supported.');
  }
  const intent = row.intent ?? {};
  const forged = Object.keys(intent).filter(key => !INTENT_FIELDS.has(key));
  if (forged.length) {
    throw opError('invalid_params', 'The timeline materialization intent carries a field this lane does not accept.',
      `Request ${row.request_id} for ${row.slug} in ${row.source_id} was refused before publication (${forged.join(', ')}); nothing changed. This lane publishes only the deterministic materialization of the page's stored timeline rows and takes no content, tags, type or frontmatter from a caller.`);
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id, includeDeleted: true });
  if (!snapshot || snapshot.page.deleted_at || snapshot.page.id !== Number(row.page_id)) {
    throw pageChanged(row, 'The page this materialization was planned for is gone, deleted or replaced.');
  }
  if (snapshot.revision !== intent.expected_revision) {
    throw opError('revision_conflict', 'The page changed before its timeline materialization was admitted.',
      `Page ${row.slug} in ${row.source_id} changed after request ${row.request_id} was planned; nothing was written. Run gbrain repair timeline --apply again so it plans from the current revision.`);
  }
  // The file-authoritative page keeps its file as the source of truth; this lane only serves database-only pages.
  if (snapshot.page.source_path || snapshot.page.source_uri?.startsWith('file:')) {
    throw opError('invalid_params', 'The page records a canonical file, so its content is published through the file path, not this lane.',
      `Page ${row.slug} in ${row.source_id} records ${snapshot.page.source_path}; nothing was written. Remove that page's root from sync.exclude and let the file-backed repair run, or reconcile the file with gbrain sources reconcile.`);
  }
  let excluded: boolean;
  try {
    excluded = await isSyncExcludedSlug(engine, row.slug);
  } catch {
    // Unlike the put_page hygiene guard, this lane cannot fail open: a scope it cannot read is a scope it cannot justify writing under.
    throw opError('source_changed', 'sync.exclude could not be read, so the database-only timeline lane did not run.',
      `The indexing scope of ${row.source_id} is unreadable on this host, so request ${row.request_id} for ${row.slug} wrote nothing. Repair the brain's config store, then run gbrain repair timeline --apply again.`);
  }
  if (!excluded) {
    throw opError('source_changed', 'The page is no longer under an excluded root.',
      `Page ${row.slug} in ${row.source_id} was planned for the database-only lane because sync.exclude covered it and it records no canonical file; that scope changed, so request ${row.request_id} wrote nothing. Run gbrain repair timeline --apply again.`);
  }
  const plan = await planTimelineMaterialization(engine, row.slug, row.source_id, snapshot);
  if (!plan.materializable) {
    throw opError('invalid_params', 'The page has no stored timeline row that can be materialized.',
      `Page ${row.slug} in ${row.source_id} has no renderable database-only timeline row left, so request ${row.request_id} wrote nothing. Run gbrain repair timeline to preview the current pages.`);
  }
  if (plan.preimage_digest !== intent.preimage_digest) {
    throw opError('revision_conflict', 'The page body differs from the materialization preimage this request was planned against.',
      `Request ${row.request_id} for ${row.slug} in ${row.source_id} carried a different preimage digest than the stored page, so it wrote nothing. This lane never publishes caller-supplied content; run gbrain repair timeline --apply again to plan from the current page.`);
  }
  const preimage = await materializationPreimage(engine, row, plan);
  const prepared = await preparePageMutation(engine, { ...row, operation: 'put_page',
    intent: { kind: 'managed_maintenance_page', content: plan.content, expected_revision: snapshot.revision } }, config);
  // Defense in depth: no worktree is bound (submitDatabaseMaintenanceIntent), so preparation stages no file; a target here would mean a filesystem effect this lane must never have.
  if (prepared.file) {
    throw opError('storage_error', 'The database-only timeline lane prepared a file target.',
      `Request ${row.request_id} for ${row.slug} was refused before publication because a canonical file would have been staged; nothing changed. This is a gbrain defect; report it with the gbrain version.`);
  }
  return { ...prepared, databaseOnlyReason: 'sync_excluded', apply: async (tx, publisherPreimage) => {
    const outcome = await prepared.apply(tx, publisherPreimage);
    await assertMaterializationOnly(tx, row, snapshot, preimage);
    return { ...outcome, timeline_materialized: plan.materializable };
  } };
}

/**
 * Publish the lane's request for one page. Returns the rows materialized, or
 * null when the brain has no managed writer (an unmanaged brain keeps the
 * ordinary path).
 */
export async function publishExcludedTimelineMaterialization(engine: BrainEngine, slug: string, sourceId: string,
  snapshot: PageSnapshot): Promise<number | null> {
  const authority = await maintenancePreflight(engine, sourceId);
  if (!authority) return null;
  const plan = await planTimelineMaterialization(engine, slug, sourceId, snapshot);
  const requestId = digest([TIMELINE_MATERIALIZE_INTENT, sourceId, slug, snapshot.revision]);
  const key = `${requestId.slice(0, 8)}-${requestId.slice(8, 12)}-4${requestId.slice(13, 16)}-a${requestId.slice(17, 20)}-${requestId.slice(20, 32)}`;
  const receipt = await submitDatabaseMaintenanceIntent(engine, authority, slug,
    { kind: TIMELINE_MATERIALIZE_INTENT, expected_revision: snapshot.revision, preimage_digest: plan.preimage_digest }, key);
  return Number(receipt.timeline_materialized ?? 0);
}
