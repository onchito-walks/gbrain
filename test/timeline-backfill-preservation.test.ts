/**
 * Timeline backfill PRESERVATION regression (the 203-row data loss).
 *
 * Parent-verified evidence this pins: the 165→239 migration chain destroyed
 * 203 `timeline_entries` rows on a real brain — 203 keys only in production,
 * 0 added, 0 ids renumbered, zero duplicate groups under
 * (page_id,date,summary) / (page_id,date,summary,source) / md5(summary), the
 * affected pages' markdown timelines byte-identical, every affected page live.
 *
 * Mechanism: `v0_12_0` phase D ran `gbrain extract timeline --source db`
 * WITHOUT `--migration-backfill` (phase C passes it for links), so the pass
 * reconciled instead of backfilling and `retractRemovedTimelineEntries`
 * deleted every stored row whose bullet the live body no longer spells out but
 * a stored `page_versions` row still does. 203/203 lost rows are present in a
 * stored version; 0 are on deleted pages.
 *
 * These regressions are keyed on ROW-LEVEL IDENTITY (the id set AND the
 * (date,source,summary) key set), never on a count: a count-only assertion is
 * exactly what hid this (pages reported 23306 "changed_or_removed" with an
 * unchanged count). `identityLoss` is the assertion, and a deliberate removal
 * is included as its negative control so the assertion cannot pass vacuously.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { runExtract } from '../src/commands/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SLUG = 'concepts/timeline-preservation';
const SOURCE = 'timeline-backfill-fixture';

interface TimelineRow { id: number; date: string; source: string; summary: string }
interface Identity { ids: number[]; keys: string[] }

const identity = (rows: TimelineRow[]): Identity => ({
  ids: rows.map(r => Number(r.id)).sort((a, b) => a - b),
  keys: rows.map(r => `${r.date}\u0000${r.source}\u0000${r.summary}`).sort(),
});

/** Rows the `after` state no longer holds, by id and by key — the loss, named. */
const identityLoss = (before: Identity, after: Identity): Identity => ({
  ids: before.ids.filter(id => !after.ids.includes(id)),
  keys: before.keys.filter(key => !after.keys.includes(key)),
});

const NO_LOSS: Identity = { ids: [], keys: [] };

/** The bullet the live body used to carry; its tuple is the stored row's. */
const HISTORICAL_BULLET = '- **2026-01-01** | default — Historical bullet';
const HISTORICAL_KEY = '2026-01-01\u0000default\u0000Historical bullet';

const BACKFILL = { dryRun: false, jsonMode: false, migrationBackfill: true } as const;
const RECONCILE = { dryRun: false, jsonMode: false } as const;

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`timeline migration backfill preserves stored rows (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine; close = pg.close;
      } else {
        engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
        close = () => engine.disconnect();
      }
      // Unmanaged, explicitly: the batched raw insert path is the one the
      // migration runs on a gbrain brain (persistence_brain.enabled = false).
      await engine.executeRaw('UPDATE persistence_brain SET enabled = false');
    }, 120_000);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [SOURCE]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [SOURCE]);
      await engine.executeRaw(
        `DELETE FROM timeline_entries WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)`, [SOURCE]);
      await engine.executeRaw('DELETE FROM page_versions WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [SOURCE]);
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [SOURCE]);
    });

    afterAll(async () => { await close?.(); });

    const rows = (): Promise<TimelineRow[]> => engine.executeRaw<TimelineRow>(
      `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary
         FROM timeline_entries t JOIN pages p ON p.id = t.page_id
        WHERE p.source_id = $1 AND p.slug = $2 ORDER BY t.id`, [SOURCE, SLUG]);

    /**
     * The failing shape: the live body no longer carries the bullet, the row is
     * stored, and a stored version still produces its tuple — so ordinary
     * reconciliation has something to retract and a migration must not.
     */
    async function seedHistoricalRow(body = '# Timeline preservation\n\nNo dated bullet in this body.\n'): Promise<number> {
      await engine.putPage(SLUG, {
        title: 'Timeline preservation', type: 'concept', compiled_truth: body, frontmatter: {},
      }, { sourceId: SOURCE });
      const [page] = await engine.executeRaw<{ id: number }>(
        'SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, SLUG]);
      await engine.executeRaw(
        `INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at, timeline)
         VALUES ($1, $2, '{}'::jsonb, now(), $3)`, [page.id, '# Timeline preservation\n', HISTORICAL_BULLET]);
      await engine.executeRaw(
        `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
         VALUES ($1, DATE '2026-01-01', 'default', 'Historical bullet', '')`, [page.id]);
      return Number(page.id);
    }

    test('the additive migration pass keeps the row verbatim — id AND key — while the reconcile pass still retracts it', async () => {
      await seedHistoricalRow();
      const before = identity(await rows());
      expect(before.ids).toHaveLength(1);
      expect(before.keys).toEqual([HISTORICAL_KEY]);

      // --migration-backfill: additive. Nothing is retracted, nothing is
      // renumbered, nothing is rewritten.
      await extractTimelineFromDB(engine, { ...BACKFILL });
      const afterBackfill = identity(await rows());
      expect(identityLoss(before, afterBackfill)).toEqual(NO_LOSS);
      expect(afterBackfill).toEqual(before);

      // Repeat invocation is idempotent: same ids, same keys, no duplicate row.
      await extractTimelineFromDB(engine, { ...BACKFILL });
      expect(identity(await rows())).toEqual(before);

      // NEGATIVE CONTROL — the same assertion, on the same state, catches the
      // loss: the ordinary reconcile pass retracts exactly this row. If
      // something ever made `identityLoss` blind to a removed row, this fails.
      await extractTimelineFromDB(engine, { ...RECONCILE });
      const afterReconcile = identity(await rows());
      expect(identityLoss(before, afterReconcile).ids).toEqual(before.ids);
      expect(identityLoss(before, afterReconcile).keys).toEqual(before.keys);

      // …and a plain deliberate removal is detected too, so the comparator is
      // not vacuously empty on an already-empty table.
      await seedHistoricalRow();
      const seeded = identity(await rows());
      const [only] = seeded.ids;
      await engine.executeRaw('DELETE FROM timeline_entries WHERE id=$1', [only]);
      expect(identityLoss(seeded, identity(await rows())).ids).toEqual([only]);
    });

    test('the additive pass still inserts the rows the page never got, without moving the stored ones', async () => {
      // The body carries a NEW bullet and no stored row exists for it.
      await seedHistoricalRow('# Timeline preservation\n\n- **2026-02-02** | meeting — Added later\n');
      const before = identity(await rows());

      await extractTimelineFromDB(engine, { ...BACKFILL });
      const after = identity(await rows());

      // The historical row is untouched…
      expect(identityLoss(before, after)).toEqual(NO_LOSS);
      expect(after.keys).toContain(HISTORICAL_KEY);
      expect(after.ids).toEqual(expect.arrayContaining(before.ids));
      // …and the missing one was added (the pass is not a no-op).
      expect(after.keys).toContain('2026-02-02\u0000meeting\u0000Added later');
      expect(after.ids.length).toBe(before.ids.length + 1);
    });

    test('--migration-backfill stays reserved for the trusted-local DB timeline/link backfills', async () => {
      // Accepted for `timeline` on the DB source for the trusted-local caller
      // (src/cli/commands/extract.ts passes `{ remote: false }`; that is the
      // migration's own caller shape); the guard is what this pins.
      await expect(runExtract(engine, ['timeline', '--source', 'db', '--migration-backfill', '--quiet'], { remote: false }))
        .resolves.toBeUndefined();
      await expect(runExtract(engine, ['links', '--source', 'db', '--migration-backfill', '--quiet'], { remote: false }))
        .resolves.toBeUndefined();
      // No trusted-local authority, a wrong data source, a whole-brain `all`
      // extract, or a reconciling flag: all refused. Nothing runs.
      await expect(runExtract(engine, ['timeline', '--source', 'db', '--migration-backfill'])).rejects.toThrow('trusted-local');
      await expect(runExtract(engine, ['timeline', '--source', 'db', '--migration-backfill'], { remote: true })).rejects.toThrow('trusted-local');
      await expect(runExtract(engine, ['timeline', '--source', 'fs', '--migration-backfill'], { remote: false })).rejects.toThrow('trusted-local');
      await expect(runExtract(engine, ['all', '--source', 'db', '--migration-backfill'], { remote: false })).rejects.toThrow('trusted-local');
      await expect(runExtract(engine, ['timeline', '--source', 'db', '--migration-backfill', '--rebuild'], { remote: false })).rejects.toThrow('trusted-local');
    });
  });
}

describe('v0.12.0 phase D runs the timeline backfill additively', () => {
  test('the migration passes --migration-backfill to `gbrain extract timeline --source db`', () => {
    // test-reads-source-ok[structural]: pins the subprocess flag wiring; runtime additive preservation is exercised above.
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'migrations', 'v0_12_0.ts'), 'utf-8');
    expect(src).toContain("runGbrainSubprocess('gbrain extract timeline --source db --migration-backfill'");
    // The un-flagged form (ordinary reconciliation) is what destroyed the rows.
    expect(src).not.toContain("runGbrainSubprocess('gbrain extract timeline --source db'");
  });
});
