/**
 * v0.32.2 named pre-existing-drift exceptions (kanban t_084a589b) —
 * regressions for the strict-by-default tolerance in `phaseCVerify`.
 *
 * The owner ruling accepted three pre-existing PRODUCTION data conditions as
 * permanent verify exceptions and required a mechanism that:
 *   (a) leaves default behaviour strict — drift that is not on the list still
 *       fails, by name, exactly as before;
 *   (b) tolerates a listed condition only when the observation matches the
 *       entry FIELD FOR FIELD (slug, source, surface, row numbers, counts), so
 *       no page, prefix, class or "pre-existing" heuristic is ever covered;
 *   (c) still DETECTS and REPORTS every tolerated exception on every run — the
 *       phase names it in its detail and prints it; nothing is suppressed;
 *   (d) writes nothing: no row deleted, re-keyed, re-stamped or renumbered, no
 *       file byte touched.
 *
 * The production signatures used here were derived READ-ONLY from the retained
 * pre-image (`stage5-fresh_t_c9f7df36`, schema 165) and reproduce identically
 * in the post-chain clone `chain3` (schema 239).
 *
 * Engine injected via __setTestEngineOverride (no configured brain needed).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setTestEngineOverride, __testing } from '../src/commands/migrations/v0_32_2.ts';
import {
  FENCE_DRIFT_EXCEPTIONS,
  NAMED_NOT_GATE_OBSERVABLE,
  fenceDriftExceptionSlugs,
  matchFenceDriftException,
  type FenceDriftObservation,
} from '../src/commands/migrations/v0_32_2-drift-exceptions.ts';
import { renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../src/core/facts-fence.ts';

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const BASE = process.env.GBRAIN_TEST_FACTS_PAIRING_BASE ?? '/tmp';

// The exact production slugs the ruling named.
const LEVIATHAN = 'hermes-moncho/concepts/leviathan-seven-patterns';
const DESIGN_POLICY = 'hermes-moncho/concepts/raymonddelgado-com-design-policy';
const RAYOPS = 'projects/rayops-tailscale-control-tunnel';
const MEETINGS_PREFIXED = 'hermes-moncho/meetings/hermes-telegram-2026-05-21-ff4931';

let engine: PGLiteEngine;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __setTestEngineOverride(engine);
});

afterAll(async () => {
  __setTestEngineOverride(null);
  await engine.disconnect();
});

beforeEach(async () => {
  root = mkdtempSync(join(BASE, 'facts-drift-exceptions-'));
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [root]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fenceRow = (rowNum: number, claim: string, source = 'sync:import'): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
  validFrom: '2026-01-01', source, active: true,
});

/** Seed a fenced row exactly as production carries it (row_num + slug set). */
async function seedFencedRow(slug: string, rowNum: number, claim: string, source = 'mcp:put_page'): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence,
                        row_num, source_markdown_slug)
     VALUES ('default', $1, $2, 'fact', 'private', 'medium', now(), $3, 1.0, $4, $1) RETURNING id`,
    [slug, claim, source, rowNum],
  );
  return Number(row.id);
}

/** Write the canonical file for a slug with the given fence rows. */
function writeFence(slug: string, rows: ParsedFact[], heading = '# Page\n'): string {
  const body = replaceOrInsertFactsFence(heading, renderFactsTable(rows));
  const path = join(root, `${slug}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** Everything the preservation contract protects. */
const factsSnapshot = () => engine.executeRaw<Record<string, unknown>>(
  `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, source, confidence,
          row_num, source_markdown_slug, expired_at
     FROM facts ORDER BY id`);

const pageCount = async (): Promise<number> => {
  const [r] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
  return Number(r.n);
};

describe('the exception list is exact, evidenced and small', () => {
  test('covers exactly the three gate-observable production conditions', () => {
    expect(fenceDriftExceptionSlugs().sort()).toEqual([DESIGN_POLICY, LEVIATHAN, RAYOPS].sort());
  });

  test('every entry carries a ruling, a rationale and an evidence pointer', () => {
    for (const e of FENCE_DRIFT_EXCEPTIONS) {
      expect(e.ruling.length).toBeGreaterThan(0);
      expect(e.rationale.length).toBeGreaterThan(40);
      expect(e.evidence).toContain('RECEIPT.md §7');
      // Named exactly: no prefix, glob or wildcard may appear in a slug.
      expect(e.slug).not.toMatch(/[*?]|\.\.\./);
      expect(e.slug).toBe(e.tolerates.slug);
      expect(e.sourceId).toBe(e.tolerates.sourceId);
    }
  });

  test('the ruling\'s cli:-only prefixed slugs are documented as not gate-observable, not listed', () => {
    for (const slug of NAMED_NOT_GATE_OBSERVABLE) {
      expect(fenceDriftExceptionSlugs()).not.toContain(slug);
    }
    expect(NAMED_NOT_GATE_OBSERVABLE).toContain('hermes-moncho/architecture/quiver-trailhead-integration');
    expect(NAMED_NOT_GATE_OBSERVABLE).toContain(MEETINGS_PREFIXED);
  });
});

describe('matching is field-for-field, never by class', () => {
  const leviathanObs = (rows: number[]): FenceDriftObservation => (
    { kind: 'page_missing', sourceId: 'default', slug: LEVIATHAN, surface: 'file', rows });

  test('matches the production signatures', () => {
    expect(matchFenceDriftException(leviathanObs([1, 2]))?.slug).toBe(LEVIATHAN);
    expect(matchFenceDriftException(leviathanObs([2, 1]))?.slug).toBe(LEVIATHAN); // set semantics
    // The 22-row set belongs to the design-policy entry, not the leviathan one.
    expect(matchFenceDriftException(leviathanObs(Array.from({ length: 22 }, (_, i) => i + 1)))).toBeNull();
    expect(matchFenceDriftException({
      kind: 'page_missing', sourceId: 'default', slug: DESIGN_POLICY, surface: 'file',
      rows: Array.from({ length: 22 }, (_, i) => i + 1),
    })?.slug).toBe(DESIGN_POLICY);
    expect(matchFenceDriftException({
      kind: 'fence_divergence', sourceId: 'default', slug: RAYOPS, surface: 'file',
      fence: 9, db: 8, notIndexed: [5], notInFence: [],
    })?.slug).toBe(RAYOPS);
  });

  test('rejects an unlisted slug carrying an identical signature', () => {
    expect(matchFenceDriftException({
      kind: 'page_missing', sourceId: 'default', slug: 'people/alice-example', surface: 'file', rows: [1, 2],
    })).toBeNull();
    expect(matchFenceDriftException({
      kind: 'fence_divergence', sourceId: 'default', slug: 'people/alice-example', surface: 'file',
      fence: 9, db: 8, notIndexed: [5], notInFence: [],
    })).toBeNull();
  });

  test('rejects a listed slug whose drift changed', () => {
    // Rows grew, shrank, or moved.
    expect(matchFenceDriftException(leviathanObs([1, 2, 3]))).toBeNull();
    expect(matchFenceDriftException(leviathanObs([1]))).toBeNull();
    expect(matchFenceDriftException(leviathanObs([2, 3]))).toBeNull();
    // Wrong surface: a managed-brain page observation is not the file condition.
    expect(matchFenceDriftException({ ...leviathanObs([1, 2]), surface: 'page' })).toBeNull();
    // Wrong kind: a divergence on the same slug is not the tolerated condition.
    expect(matchFenceDriftException({
      kind: 'fence_divergence', sourceId: 'default', slug: LEVIATHAN, surface: 'file',
      fence: 9, db: 8, notIndexed: [5], notInFence: [],
    })).toBeNull();
    // rayops: counts and both row sets are pinned.
    const rayops = (over: Partial<Extract<FenceDriftObservation, { kind: 'fence_divergence' }>>) => ({
      kind: 'fence_divergence' as const, sourceId: 'default', slug: RAYOPS, surface: 'file' as const,
      fence: 9, db: 8, notIndexed: [5], notInFence: [], ...over,
    });
    expect(matchFenceDriftException(rayops({ fence: 10 }))).toBeNull();
    expect(matchFenceDriftException(rayops({ db: 9 }))).toBeNull();
    expect(matchFenceDriftException(rayops({ notIndexed: [5, 9] }))).toBeNull();
    expect(matchFenceDriftException(rayops({ notIndexed: [] }))).toBeNull();
    expect(matchFenceDriftException(rayops({ notInFence: [7] }))).toBeNull();
    expect(matchFenceDriftException({ ...rayops({}), surface: 'page' })).toBeNull();
  });
});

describe('phaseCVerify — a listed exception is tolerated AND reported by name', () => {
  test('orphaned prefixed-slug rows (file missing) verify complete and are named', async () => {
    // Production shape: 2 stamped rows, no page/file under the prefixed slug.
    await seedFencedRow(LEVIATHAN, 1, 'LEVIATHAN — two-tier orchestration harness');
    await seedFencedRow(LEVIATHAN, 2, 'LEVIATHAN comprises 7 augmentation patterns');
    const before = await factsSnapshot();
    expect(existsSync(join(root, `${LEVIATHAN}.md`))).toBe(false);

    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
    let r: Awaited<ReturnType<typeof __testing.phaseCVerify>>;
    try {
      r = await __testing.phaseCVerify(engine, OPTS);
    } finally {
      log.mockRestore();
    }
    const printed = lines.join('\n');

    // (b)+(c): tolerated, and reported — in the printed block and the detail.
    expect(r.status, r.detail).toBe('complete');
    expect(r.detail).toContain('pages_checked=');
    expect(r.detail).toContain('tolerated 1 named pre-existing-drift exception');
    expect(r.detail).toContain(LEVIATHAN);
    expect(r.detail).toContain('file missing');
    expect(printed).toContain(LEVIATHAN);
    expect(printed).toContain('named pre-existing-drift exception');
    expect(printed).toContain('accepted:');
    expect(printed).toContain('RECEIPT.md §7');
    expect(printed).toContain('no row was deleted, re-keyed, re-stamped or rewritten');
    // The audit line names the entries this brain did not exercise.
    expect(printed).toContain(`exceptions not observed in this run: ${DESIGN_POLICY}, ${RAYOPS}`);

    // (d): nothing written.
    expect(await factsSnapshot()).toEqual(before);
    expect(await pageCount()).toBe(0);
    expect(existsSync(join(root, `${LEVIATHAN}.md`))).toBe(false);
  });

  test('a cli:-only prefixed slug is still skipped, not tolerated and not reported', async () => {
    await seedFencedRow(MEETINGS_PREFIXED, 0, 'Telegram thread note', 'cli:extract-conversation-facts:terminal');
    const before = await factsSnapshot();

    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
    let r: Awaited<ReturnType<typeof __testing.phaseCVerify>>;
    try {
      r = await __testing.phaseCVerify(engine, OPTS);
    } finally {
      log.mockRestore();
    }

    expect(r.status, r.detail).toBe('complete');
    expect(r.detail).toBe('pages_checked=0');
    expect(lines.join('\n')).not.toContain(MEETINGS_PREFIXED);
    expect(await factsSnapshot()).toEqual(before);
  });

  test('the rayops file/database divergence verifies complete and is named', async () => {
    const path = writeFence(RAYOPS, [
      fenceRow(1, 'Windows workstation could not complete TLS to controlplane'),
      fenceRow(2, 'The workaround redirects only controlplane locally'),
      fenceRow(3, 'Windows install is NOT done / NOT verified'),
      fenceRow(4, 'Install on the Windows host and run health.ps1'),
      fenceRow(5, 'Check OCI for the reported temporary broad ingress rule'),
      fenceRow(6, 'An ad-hoc forward restored connectivity'),
      fenceRow(7, 'The package is a reconstruction and has not been installed'),
      fenceRow(8, 'Windows install on the RayOps control tunnel was NOT done'),
      fenceRow(9, 'Remove the OCI broad ingress rule and retain only required public SSH ingress'),
    ], '# RayOps Tailscale control tunnel\n');
    // The database side after the v0.32.2 backfill: the row whose fence position
    // the hand edit occupies was republished at the next free position (9).
    for (const rowNum of [1, 2, 3, 4, 6, 7, 8, 9]) {
      await seedFencedRow(RAYOPS, rowNum, `claim ${rowNum}`);
    }
    const bytes = readFileSync(path, 'utf-8');
    const before = await factsSnapshot();

    const r = await __testing.phaseCVerify(engine, OPTS);

    expect(r.status, r.detail).toBe('complete');
    expect(r.detail).toContain(`tolerated 1 named pre-existing-drift exception`);
    expect(r.detail).toContain(`${RAYOPS} (fence=9, db=8; not indexed: row_num 5)`);
    expect(await factsSnapshot()).toEqual(before);
    expect(readFileSync(path, 'utf-8')).toEqual(bytes);
  });

  test('the same page with ANY other drift still fails (tolerance is not a page exemption)', async () => {
    const path = writeFence(RAYOPS, [
      fenceRow(1, 'a'), fenceRow(2, 'b'), fenceRow(3, 'c'), fenceRow(4, 'd'), fenceRow(5, 'e'),
      fenceRow(6, 'f'), fenceRow(7, 'g'), fenceRow(8, 'h'), fenceRow(9, 'i'),
    ]);
    for (const rowNum of [1, 2, 3, 4, 6, 7, 8]) await seedFencedRow(RAYOPS, rowNum, `claim ${rowNum}`);
    // Database row 9 is gone: the fence now holds TWO unowned positions (5 and 9).
    const before = await factsSnapshot();

    const r = await __testing.phaseCVerify(engine, OPTS);

    expect(r.status).toBe('failed');
    expect(r.detail).toContain(RAYOPS);
    expect(r.detail).toContain('not indexed: 5, 9');
    expect(r.detail).not.toContain('tolerated');
    expect(await factsSnapshot()).toEqual(before);
    expect(readFileSync(path, 'utf-8')).not.toBe('');
  });

  test('an unlisted slug with the missing-file shape still fails by name', async () => {
    await seedFencedRow('people/alice-example', 1, 'Alice example joined Acme example');

    const before = await factsSnapshot();
    const r = await __testing.phaseCVerify(engine, OPTS);

    expect(r.status).toBe('failed');
    expect(r.detail).toContain('people/alice-example (file missing)');
    expect(r.detail).not.toContain('tolerated');
    expect(await factsSnapshot()).toEqual(before);
  });

  test('a named and an unlisted drift in the same run: the run fails, and still names the accepted one', async () => {
    await seedFencedRow(LEVIATHAN, 1, 'L1');
    await seedFencedRow(LEVIATHAN, 2, 'L2');
    await seedFencedRow('people/alice-example', 1, 'A1');

    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); });
    let r: Awaited<ReturnType<typeof __testing.phaseCVerify>>;
    try {
      r = await __testing.phaseCVerify(engine, OPTS);
    } finally {
      log.mockRestore();
    }

    expect(r.status).toBe('failed');
    expect(r.detail).toContain('people/alice-example (file missing)');
    expect(r.detail).toContain(`tolerated 1 named pre-existing exception(s): ${LEVIATHAN}`);
    expect(lines.join('\n')).toContain(LEVIATHAN);
  });
});
