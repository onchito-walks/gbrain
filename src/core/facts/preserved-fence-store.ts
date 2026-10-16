/**
 * Durable home for a preserved fence publication (the strict-preservation
 * repair of the v0.32.2 fact backfill).
 *
 * `preserved-fence-publication.ts` plans a derived representation and grants no
 * authority. This module is the adapter the design doc named as missing: it
 * discovers the complete original columns from the engine (never from a
 * caller-asserted subset), reads the complete original source/page/fact
 * population plus the literal body, and publishes the derived document and its
 * bindings through the EXISTING owner/journal path:
 *
 *   - unmanaged brain: one `maintenanceTransaction` (the maintenance principal
 *     the other unmanaged writers use; a managed brain's writer guard still
 *     refuses these writes, so this branch never bypasses it);
 *   - managed brain: one database-only `managed_maintenance_publish_preserved_fence`
 *     request through the coordinator, admitted against the page revision and
 *     replanned under the page key before anything is written.
 *
 * Storage is the existing page-scoped `raw_data` document table (one row per
 * page and label, `ON CONFLICT (page_id, source)`), not a new schema object and
 * not the page body: an original page body and every original fact row are
 * never rewritten by this path. Publication is all-or-refuse — a plan that does
 * not replan identically from the current complete originals writes nothing.
 *
 * Deliberately NOT in scope here, and still required before enablement:
 *   - v0.32.2 phase B/C wiring;
 *   - `pendingLegacyRows` and `planFenceReconcile` binding derived rows to their
 *     original identities (a stored document alone is not a drift exemption);
 *   - import/rebuild/recovery, which must distinguish derived records from
 *     original rows and must not lose the document when the database is
 *     rebuilt from the repo.
 */
import { existsSync, readFileSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import {
  maintenancePreflight,
  submitDatabaseMaintenanceIntent,
  type MaintenanceAuthority,
} from '../persistence/prepared-maintenance.ts';
import { sha256, stableJson } from '../persistence/digest.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { isTerminal } from '../persistence/model.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import {
  planPreservedFencePublication,
  type OriginalRecord,
  type PreservedFenceInputs,
  type PreservedFencePublication,
} from './preserved-fence-publication.ts';

/** The `raw_data.source` label a preserved fence publication is stored under. */
export const PRESERVED_FENCE_SOURCE = 'gbrain:facts-fence-derived-publication';
/** The managed intent that publishes one page's derived document. */
export const PUBLISH_PRESERVED_FENCE_INTENT = 'managed_maintenance_publish_preserved_fence';

/** Column manifests discovered from the engine, never asserted by a caller. */
export interface OriginalColumnManifests {
  source: string[];
  page: string[];
  facts: string[];
}

export interface PreservedFenceOriginals {
  input: PreservedFenceInputs;
  pageId: number;
  pageRevision: string | null;
  /** Complete rows, exactly as the engine returned them. */
  rows: { source: OriginalRecord; page: OriginalRecord; facts: OriginalRecord[] };
}

export interface PreservedFencePublishReceipt {
  published: boolean;
  path: 'unmanaged' | 'managed';
  reason?: string;
  requestId?: string;
  derivedBodySha256: string;
  bindings: number;
  /** True when a previously stored, no-longer-current document was replaced on purpose. */
  supersededStoredPublication: boolean;
  /** Digests of the originals this publication was planned from. */
  originalSourceSha256: string;
  originalPageSha256: string;
  originalBodySha256: string;
}

function refuse(code: string, detail: string): never {
  throw new Error(`preserved_fence_store_refused: ${code}: ${detail}`);
}

/**
 * Complete column discovery. Every consumer (and every later revalidation) must
 * come through here: a column the caller forgot would otherwise read as "not
 * part of the record", which is exactly the projection-only certification this
 * repair exists to remove.
 */
export async function discoverOriginalColumns(engine: BrainEngine): Promise<OriginalColumnManifests> {
  const rows = await engine.executeRaw<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN ('sources', 'pages', 'facts')
      ORDER BY table_name, ordinal_position`,
  );
  const manifests: OriginalColumnManifests = { source: [], page: [], facts: [] };
  for (const row of rows) {
    if (row.table_name === 'sources') manifests.source.push(row.column_name);
    else if (row.table_name === 'pages') manifests.page.push(row.column_name);
    else manifests.facts.push(row.column_name);
  }
  for (const [table, columns] of Object.entries(manifests)) {
    if (columns.length === 0) refuse('column_discovery_empty', `no columns discovered for ${table}`);
  }
  return manifests;
}

/** Read one complete row, refusing rather than returning a partial record. */
async function readCompleteRow(engine: BrainEngine, table: string, where: string, params: unknown[], columns: string[]): Promise<OriginalRecord | null> {
  const rows = await engine.executeRaw<OriginalRecord>(`SELECT * FROM ${table} WHERE ${where}`, params);
  if (rows.length === 0) return null;
  if (rows.length > 1) refuse('ambiguous_original_row', `${table} matched ${rows.length} rows`);
  const row = rows[0]!;
  const actual = Object.keys(row).sort();
  if (stableJson(actual) !== stableJson([...columns].sort())) {
    refuse('incomplete_original_record', `${table} row columns ${actual.join(',')} != discovered manifest`);
  }
  for (const key of actual) if (row[key] === undefined) refuse('incomplete_original_record', `${table}.${key} is undefined`);
  return row;
}

/** The literal document the plan is derived from: the canonical file, or the managed serialized page. */
async function readLiteralBody(engine: BrainEngine, sourceId: string, slug: string, managed: boolean): Promise<string> {
  if (managed) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot) refuse('original_page_missing', `page ${slug} in source ${sourceId} is not readable`);
    return serializePageToMarkdown(snapshot.page, snapshot.tags);
  }
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok || !existsSync(target.filePath)) {
    refuse('original_file_missing', `canonical file for ${slug} in source ${sourceId} is not on this host`);
  }
  return readFileSync(target.filePath, 'utf-8');
}

/**
 * The rows the v0.32.2 backfill fences on this page, by the same selection
 * `planUnfencedFacts({ adoptStamped: true })` uses: active, non-ontology,
 * entity-owned rows that hold no position yet, plus the rows whose position the
 * markdown is not carrying (conversation-miner `cli:` rows are never adopted in
 * that second shape — the chat log is their source of truth).
 *
 * Derived here and not passed in: the candidate set has to be recomputable from
 * the originals alone, or a later revalidation would compare the stored document
 * against a differently-scoped plan and report drift that is really a scope
 * difference.
 */
export async function preservedCandidateIds(engine: BrainEngine, sourceId: string, slug: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ id: string | number }>(
    `SELECT id FROM facts
      WHERE source_id = $1 AND entity_slug = $2
        AND expired_at IS NULL AND dimension IS NULL
        AND (row_num IS NULL OR COALESCE(source, '') NOT LIKE 'cli:%')
      ORDER BY id`,
    [sourceId, slug],
  );
  return rows.map(row => String(row.id));
}

/**
 * Read the complete originals of one page for the preserved plan. The fact
 * population is every row of the page in this source (both the entity-slug and
 * the fence-slug binding), so an occupied noncandidate row and a row on another
 * page cannot be mistaken for the whole population.
 */
export async function readPreservedFenceOriginals(engine: BrainEngine, sourceId: string, slug: string,
  opts: { columns?: OriginalColumnManifests } = {}): Promise<PreservedFenceOriginals> {
  const managed = await managedPersistenceEnabled(engine);
  const columns = opts.columns ?? await discoverOriginalColumns(engine);
  const source = await readCompleteRow(engine, 'sources', 'id = $1', [sourceId], columns.source);
  if (!source) refuse('original_source_missing', `source ${sourceId} does not exist`);
  const page = await readCompleteRow(engine, 'pages', 'source_id = $1 AND slug = $2', [sourceId, slug], columns.page);
  if (!page) refuse('original_page_missing', `page ${slug} in source ${sourceId} does not exist`);
  const facts = await engine.executeRaw<OriginalRecord>(
    `SELECT * FROM facts
      WHERE source_id = $1 AND (entity_slug = $2 OR source_markdown_slug = $2)
      ORDER BY id`,
    [sourceId, slug],
  );
  if (facts.length === 0) refuse('original_population_empty', `page ${slug} in source ${sourceId} has no original facts`);
  for (const row of facts) {
    const actual = Object.keys(row).sort();
    if (stableJson(actual) !== stableJson([...columns.facts].sort())) {
      refuse('incomplete_original_record', `facts row ${String(row.id)} columns do not match the discovered manifest`);
    }
  }
  const body = await readLiteralBody(engine, sourceId, slug, managed);
  const candidateIds = await preservedCandidateIds(engine, sourceId, slug);
  const revisionRow = await engine.executeRaw<{ knowledge_revision: string | null }>(
    'SELECT knowledge_revision FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return {
    input: { sourceId, entitySlug: slug, source, page, facts, columns, body, candidateIds },
    pageId: Number(page.id),
    pageRevision: revisionRow[0]?.knowledge_revision ?? null,
    rows: { source, page, facts },
  };
}

/** Plan one page's preserved publication from engine-discovered complete originals. */
export async function planPagePreservedFencePublication(engine: BrainEngine, sourceId: string, slug: string,
  ): Promise<PreservedFencePublication> {
  const originals = await readPreservedFenceOriginals(engine, sourceId, slug);
  return planPreservedFencePublication(originals.input);
}

/**
 * The revalidation every publication path runs: replan from the CURRENT
 * complete originals and require the stored document to be exactly that plan.
 * Nothing is compared modulo a projection, and no original value is normalized
 * for the comparison.
 */
export async function assertPublicationIsCurrent(engine: BrainEngine, sourceId: string, slug: string,
  publication: PreservedFencePublication): Promise<void> {
  const current = await readPreservedFenceOriginals(engine, sourceId, slug);
  if (current.input.sourceId !== publication.source_id || current.input.entitySlug !== publication.entity_slug) {
    refuse('publication_scope_mismatch', `publication for ${publication.source_id}/${publication.entity_slug} does not cover ${sourceId}/${slug}`);
  }
  const expected = planPreservedFencePublication(current.input);
  if (stableJson(publication) !== stableJson(expected)) {
    refuse('original_or_derived_drift', `stored publication for ${sourceId}/${slug} is not the plan of its current originals`);
  }
}

/** Read the stored publication of one page, or null when it has none. */
export async function readPreservedFencePublication(engine: BrainEngine, sourceId: string, slug: string): Promise<PreservedFencePublication | null> {
  const rows = await engine.executeRaw<{ data: PreservedFencePublication | string }>(
    `SELECT rd.data FROM raw_data rd JOIN pages p ON p.id = rd.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND rd.source = $3`,
    [sourceId, slug, PRESERVED_FENCE_SOURCE],
  );
  if (rows.length === 0) return null;
  const data = rows[0]!.data;
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  if (parsed?.schema !== 'gbrain.preserved-fence-publication.v1') {
    refuse('unreadable_publication', `raw_data row for ${slug} is not a preserved fence publication`);
  }
  return parsed;
}

/** Verify the stored publication against current originals. Never repairs. */
export async function verifyPreservedFencePublication(engine: BrainEngine, sourceId: string, slug: string):
  Promise<{ ok: boolean; reason?: string; bindings: number }> {
  const stored = await readPreservedFencePublication(engine, sourceId, slug);
  if (!stored) return { ok: false, reason: 'no_publication', bindings: 0 };
  try {
    await assertPublicationIsCurrent(engine, sourceId, slug, stored);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), bindings: stored.bindings.length };
  }
  return { ok: true, bindings: stored.bindings.length };
}

/** The derived position bound to one original fact id, or null. Reads only. */
export async function preservedDerivedPosition(engine: BrainEngine, sourceId: string, slug: string, factId: string | number): Promise<number | null> {
  const stored = await readPreservedFencePublication(engine, sourceId, slug);
  if (!stored) return null;
  return stored.bindings.find(binding => binding.original_fact_id === String(factId))?.derived_row_num ?? null;
}

/** Every original fact id the stored publication pins, or null without one. */
export async function preservedOriginalFactIds(engine: BrainEngine, sourceId: string, slug: string): Promise<Set<string> | null> {
  const stored = await readPreservedFencePublication(engine, sourceId, slug);
  return stored ? new Set(stored.original_facts.map(fact => fact.id)) : null;
}

/** The derived document's fence rows, parsed — never the original body's. */
export function derivedFenceOf(publication: PreservedFencePublication) {
  const parsed = parseFactsFence(publication.derived_body);
  if (parsed.warnings.length > 0) refuse('unreadable_derived_fence', parsed.warnings.join('; '));
  return parsed.facts;
}

/**
 * Write the page-scoped derived document. Called inside a maintenance
 * transaction (unmanaged) or inside a coordinator apply (managed): the caller
 * owns the transaction, this only writes the one row.
 */
async function writePublicationRow(tx: BrainEngine, sourceId: string, slug: string,
  publication: PreservedFencePublication): Promise<void> {
  const written = await tx.executeRaw<{ id: number }>(
    `INSERT INTO raw_data (page_id, source, data)
     SELECT id, $3, $4::jsonb FROM pages WHERE source_id = $1 AND slug = $2
     ON CONFLICT (page_id, source) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()
     RETURNING id`,
    [sourceId, slug, PRESERVED_FENCE_SOURCE, JSON.stringify(publication)],
  );
  if (written.length === 0) refuse('original_page_missing', `page ${slug} in source ${sourceId} disappeared before publication`);
}

/**
 * Publish one page's derived document through the existing owner/journal path.
 * Unmanaged: one maintenance transaction. Managed: one coordinator request,
 * admitted against the page revision and replanned under the page key.
 *
 * Neither branch touches the original page body or any original fact row.
 */
export async function publishPreservedFencePublication(engine: BrainEngine, sourceId: string, slug: string,
  opts: { columns?: OriginalColumnManifests; authority?: MaintenanceAuthority; allowSupersede?: boolean } = {}): Promise<PreservedFencePublishReceipt> {
  const originals = await readPreservedFenceOriginals(engine, sourceId, slug, opts);
  // A derived representation with nothing bound to it is not a publication:
  // it would pin nothing while reading back as a stored document.
  if (originals.input.candidateIds.length === 0) {
    refuse('no_candidates', `${sourceId}/${slug} has no original row for the derived representation to bind`);
  }
  // Fail closed against silent drift: a document that exists and no longer
  // matches the current originals is never quietly replaced. Replacing it takes
  // an explicit supersede, so a hand edit or an out-of-band row change cannot be
  // blessed by simply running the backfill again.
  const existing = await readPreservedFencePublication(engine, sourceId, slug);
  let superseded = false;
  if (existing) {
    let current = true;
    try { await assertPublicationIsCurrent(engine, sourceId, slug, existing); }
    catch { current = false; }
    if (!current) {
      if (!opts.allowSupersede) {
        refuse('stored_publication_drifted',
          `${sourceId}/${slug} has a stored derived document that is not the plan of its current originals; refusing to replace it without an explicit supersede`);
      }
      superseded = true;
    }
  }
  const publication = planPreservedFencePublication(originals.input);
  const base = {
    derivedBodySha256: sha256(publication.derived_body),
    bindings: publication.bindings.length,
    supersededStoredPublication: superseded,
    originalSourceSha256: publication.original_source_sha256,
    originalPageSha256: publication.original_page_sha256,
    originalBodySha256: publication.original_body_sha256,
  };
  const managed = await managedPersistenceEnabled(engine);
  if (!managed) {
    await maintenanceTransaction(engine, async tx => {
      // Re-check under the transaction: the plan must still be the plan of the
      // originals as they are inside the write, or nothing is written.
      await assertPublicationIsCurrent(tx, sourceId, slug, publication);
      await writePublicationRow(tx, sourceId, slug, publication);
    });
    return { published: true, path: 'unmanaged', ...base };
  }
  const authority = opts.authority ?? await maintenancePreflight(engine, sourceId);
  if (!authority) throw opError('permission_denied', 'The preserved fence publication has no maintenance authority.',
    `Source ${sourceId} did not grant this caller a maintenance authority, so the derived document for ${slug} was not published. Nothing changed; the original facts and page are untouched.`);
  const intent = { kind: PUBLISH_PRESERVED_FENCE_INTENT, expected_revision: originals.pageRevision,
    publication: publication as unknown as Record<string, unknown>,
    source_incarnation: authority.writer.sourceIncarnation };
  for (let attempt = 0; ; attempt++) {
    const requestId = maintenanceRequestId(sourceId, slug, intent, attempt);
    const prior = await getWriteRequest(engine, authority.writer.principal, requestId);
    if (prior && isTerminal(prior) && prior.state !== 'committed') continue;
    const receipt = await submitDatabaseMaintenanceIntent(engine, authority, slug, intent as Record<string, unknown> & { kind: string; expected_revision: string | null }, requestId);
    return { published: receipt.published === true, path: 'managed', requestId, ...base };
  }
}

function maintenanceRequestId(sourceId: string, slug: string, intent: Record<string, unknown>, attempt: number): string {
  const key = sha256(stableJson({ sourceId, slug, intent, ...(attempt ? { attempt } : {}) }));
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
}

/**
 * Preparer for `managed_maintenance_publish_preserved_fence`. The submitted
 * document is only ever admitted when it is exactly the plan of the page's
 * current complete originals, replanned both before admission and again under
 * the page key inside the publication transaction. Nothing on this path writes
 * an original fact row or the original page body.
 */
export async function preparePreservedFencePublication(unbounded: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const intent = row.intent as { expected_revision?: unknown; publication?: unknown; source_incarnation?: unknown; supersede?: unknown } | null;
  if (intent?.source_incarnation !== row.source_incarnation) {
    throw opError('source_changed', 'The preserved fence publication source changed.',
      `Source ${row.source_id} was replaced after preserved-fence publication request ${row.request_id} for ${row.slug} was accepted, so nothing was published. The next fact backfill run plans against the current source.`,
      { fix: receiptFixFor(row.request_id) });
  }
  const publication = intent?.publication as PreservedFencePublication | undefined;
  if (!publication || publication.schema !== 'gbrain.preserved-fence-publication.v1') {
    throw opError('invalid_params', 'A preserved fence publication request carried no derived document.',
      `Request ${row.request_id} for ${row.slug} in ${row.source_id} was refused before publication; nothing changed. Report the request ID with the gbrain version, since the document is built by gbrain itself.`,
      { fix: receiptFixFor(row.request_id) });
  }
  const snapshot = await unbounded.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot) {
    throw opError('page_not_found', 'The preserved fence publication page disappeared.',
      `Page ${row.slug} in ${row.source_id} no longer exists, so its derived fence document was not published. Nothing changed.`,
      { fix: receiptFixFor(row.request_id) });
  }
  // The same fail-closed rule as the unmanaged path: a stored document that is
  // no longer the plan of the current originals is only replaced when the
  // request says so explicitly.
  if (intent?.supersede !== true) {
    const existing = await readPreservedFencePublication(unbounded, row.source_id, row.slug);
    if (existing) {
      try { await assertPublicationIsCurrent(unbounded, row.source_id, row.slug, existing); }
      catch (error) {
        throw opError('revision_conflict', 'A drifted derived document already exists for this page.',
          `Page ${row.slug} in ${row.source_id} already carries a derived fence document that is not the plan of its current originals, and request ${row.request_id} did not ask to supersede it, so nothing was written. Replan from the current originals and resubmit with an explicit supersede. Underlying refusal: ${error instanceof Error ? error.message : String(error)}`,
          { fix: receiptFixFor(row.request_id) });
      }
    }
  }
  const recheck = async (db: BrainEngine) => {
    try {
      await assertPublicationIsCurrent(db, row.source_id, row.slug, publication);
    } catch (error) {
      throw opError('revision_conflict', 'The page or its facts changed before the derived document was published.',
        `The preserved fence publication for ${row.slug} in ${row.source_id} (request ${row.request_id}) is not the plan of the page's current complete originals, so nothing was written. The next fact backfill run replans from the current originals. Underlying refusal: ${error instanceof Error ? error.message : String(error)}`,
        { fix: receiptFixFor(row.request_id) });
    }
  };
  await recheck(unbounded);
  return { observedRevision: snapshot.revision, noop: false,
    validate: async tx => { await recheck(tx); },
    apply: async tx => {
      await recheck(tx);
      await writePublicationRow(tx, row.source_id, row.slug, publication);
      return { status: 'completed', published: true, bindings: publication.bindings.length,
        derived_body_sha256: sha256(publication.derived_body) };
    } };
}

function receiptFixFor(requestId: string) {
  return readFix('The receipt is the record of what this request did; read it before planning another.',
    { argv: ['gbrain', 'write-request', '--', requestId] });
}
