/**
 * gbrain repair-legacy-prefix — classification + apply safety tests.
 *
 * Covers the pure classifier (collision classes), frontmatter normalization,
 * vault slug walking, and the DB-only apply behavior (SAFE_RENAME /
 * COLLAPSE_* are applied; BLOCK_* are never mutated) against PGLite — the same
 * engine contract as Postgres, DATABASE_URL-free.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  classifyRepair,
  stripYamlFrontmatter,
  stripGeneratedTimelineAppendix,
  semanticallyTimelineOnly,
  pageToInput,
  walkVault,
  buildRepairPlan,
  applyRepair,
  COLLAPSE_IDENTICAL_DB,
  COLLAPSE_TIMELINE_ONLY_DB,
  COLLAPSE_IDENTICAL_FILE,
  SAFE_RENAME,
  BLOCK_DIVERGENT_DB,
} from '../src/commands/repair-legacy-prefix.ts';

// Neutral legacy prefix (never a real-source string) so the collision logic is
// exercised identically regardless of which source-root prefix an operator passes.
const PREFIX = 'legacy/';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seed(slug: string, body: string, frontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.putPage(slug, {
    type: 'note' as any,
    title: slug.split('/').pop() ?? slug,
    compiled_truth: body,
    timeline: '',
    frontmatter,
  });
}

function makeVault(): string {
  return mkdtempSync(join(tmpdir(), 'rpl-test-'));
}

describe('stripYamlFrontmatter', () => {
  test('strips a leading frontmatter block, returns the body', () => {
    const md = '---\ntitle: X\n---\n\nHello body';
    expect(stripYamlFrontmatter(md)).toBe('Hello body');
  });
  test('returns whole (trimmed) text when no frontmatter', () => {
    expect(stripYamlFrontmatter('  Just body ')).toBe('Just body');
  });
  test('handles BOM', () => {
    expect(stripYamlFrontmatter('\uFEFF---\na: 1\n---\nB')).toBe('B');
  });
});

describe('classifyRepair (pure)', () => {
  const base = { slug: `${PREFIX}x`, sourceId: 'default', legacyBody: 'BODY' };

  test('SAFE_RENAME: no canonical DB page, no vault file', () => {
    const r = classifyRepair({ ...base, canonDb: null, vaultBody: null, targetCount: 1 });
    expect(r.outcome).toBe(SAFE_RENAME);
  });

  test('COLLAPSE_IDENTICAL_DB: identical unprefixed DB page', () => {
    const r = classifyRepair({ ...base, canonDb: { slug: 'x', body: 'BODY' }, vaultBody: null, targetCount: 1 });
    expect(r.outcome).toBe(COLLAPSE_IDENTICAL_DB);
  });

  test('BLOCK_DIVERGENT_DB: same slug, different content', () => {
    const r = classifyRepair({ ...base, canonDb: { slug: 'x', body: 'DIFFERENT' }, vaultBody: null, targetCount: 1 });
    expect(r.outcome).toBe(BLOCK_DIVERGENT_DB);
  });

  test('COLLAPSE_IDENTICAL_FILE: vault body equals legacy body', () => {
    const r = classifyRepair({ ...base, canonDb: null, vaultBody: '  BODY  ', targetCount: 1 });
    expect(r.outcome).toBe(COLLAPSE_IDENTICAL_FILE);
  });

  test('BLOCK_DIVERGENT_FILE: vault body differs from legacy body', () => {
    const r = classifyRepair({ ...base, canonDb: null, vaultBody: 'OTHER', targetCount: 1 });
    expect(r.outcome).toBe('BLOCK_DIVERGENT_FILE');
  });

  test('BLOCK_AMBIGUOUS_TARGET: two legacy pages share a target', () => {
    const r = classifyRepair({ ...base, canonDb: null, vaultBody: null, targetCount: 2 });
    expect(r.outcome).toBe('BLOCK_AMBIGUOUS_TARGET');
  });
});

describe('walkVault', () => {
  test('derives lowercase prefix-stripped slugs from file paths', () => {
    const v = makeVault();
    try {
      mkdirSync(join(v, 'architecture'), { recursive: true });
      mkdirSync(join(v, 'logbook'), { recursive: true });
      writeFileSync(join(v, 'architecture/container-note.md'), 'x');
      writeFileSync(join(v, 'logbook/index.md'), 'y');
      const map = walkVault(v);
      expect(map.get('architecture/container-note')).toBe('architecture/container-note.md');
      expect(map.get('logbook/index')).toBe('logbook/index.md');
    } finally {
      rmSync(v, { recursive: true, force: true });
    }
  });
});

describe('stripGeneratedTimelineAppendix + semanticallyTimelineOnly (pure)', () => {
  const APPENDIX = [
    '\n---\n\n## Timeline',
    '- **2026-05-19** | first',
    '- **2026-08-22** | second',
  ].join('\n');

  test('strips a pure auto-generated Timeline appendix, leaving the real body', () => {
    const body = 'REAL BODY';
    expect(stripGeneratedTimelineAppendix(body + APPENDIX)).toBe('REAL BODY');
  });

  test('returns null when there is no Timeline section', () => {
    expect(stripGeneratedTimelineAppendix('just some prose')).toBeNull();
  });

  test('returns null (does not strip) when non-timeline content follows the heading', () => {
    const bad = 'BODY\n\n## Timeline\n- **2026-05-19** | entry\nThis is real prose after the heading, not a timeline entry.';
    expect(stripGeneratedTimelineAppendix(bad)).toBeNull();
  });

  test('returns null when the timeline heading has no entries', () => {
    expect(stripGeneratedTimelineAppendix('BODY\n\n## Timeline\n')).toBeNull();
  });

  test('semanticallyTimelineOnly true iff canonical = legacy once appendix + timeline frontmatter stripped', () => {
    const canonFm = { title: 'X', timeline: ['2026-05-19 first'] };
    const legacyFm = { title: 'X' };
    expect(semanticallyTimelineOnly({
      canonicalBody: 'REAL' + APPENDIX,
      legacyBody: 'REAL',
      canonicalFrontmatter: canonFm,
      legacyFrontmatter: legacyFm,
    })).toBe(true);
  });

  test('semanticallyTimelineOnly false when real content differs even if appendix matches', () => {
    expect(semanticallyTimelineOnly({
      canonicalBody: 'REAL A' + APPENDIX,
      legacyBody: 'REAL B',
      canonicalFrontmatter: null,
      legacyFrontmatter: null,
    })).toBe(false);
  });

  test('semanticallyTimelineOnly false when frontmatter differs beyond the timeline field', () => {
    expect(semanticallyTimelineOnly({
      canonicalBody: 'REAL' + APPENDIX,
      legacyBody: 'REAL',
      canonicalFrontmatter: { title: 'X', timeline: ['x'] },
      legacyFrontmatter: { title: 'Y' },
    })).toBe(false);
  });
});

describe('repair-legacy-prefix plan + apply (PGLite)', () => {
  let vault: string;

  test('SAFE_RENAME is planned and applied (DB-only, reversible)', async () => {
    vault = makeVault();
    await seed(`${PREFIX}architecture/container-note`, 'ARM BODY');
    const plan = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    const item = plan.items.find(i => i.outcome === SAFE_RENAME);
    expect(item).toBeDefined();
    expect(item!.target).toBe('architecture/container-note');

    const results = await applyRepair(engine, plan);
    expect(results.some(r => r.action === 'RENAMED')).toBe(true);
    // Target now has the content; legacy row is soft-deleted (recoverable).
    const moved = await engine.getPage('architecture/container-note', { sourceId: 'default' });
    expect(moved).not.toBeNull();
    expect(moved!.compiled_truth).toBe('ARM BODY');
    expect(await engine.getPage(`${PREFIX}architecture/container-note`)).toBeNull();
    const softDeleted = await engine.getPage(`${PREFIX}architecture/container-note`, { includeDeleted: true });
    expect(softDeleted?.deleted_at).not.toBeNull();
  });

  test('COLLAPSE_IDENTICAL_DB soft-deletes the duplicate, keeps canonical', async () => {
    await seed('concepts/dupe', 'SAME');
    await seed(`${PREFIX}concepts/dupe`, 'SAME');
    const plan = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    const item = plan.items.find(i => i.outcome === COLLAPSE_IDENTICAL_DB);
    expect(item).toBeDefined();
    await applyRepair(engine, plan);
    expect((await engine.getPage('concepts/dupe', { sourceId: 'default' }))?.compiled_truth).toBe('SAME');
    expect(await engine.getPage(`${PREFIX}concepts/dupe`)).toBeNull();
  });

  test('BLOCK_DIVERGENT_DB is never mutated', async () => {
    await seed('projects/div', 'CANONICAL_A');
    await seed(`${PREFIX}projects/div`, 'LEGACY_B');
    const plan = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    const item = plan.items.find(i => i.outcome === BLOCK_DIVERGENT_DB);
    expect(item).toBeDefined();
    await applyRepair(engine, plan);
    expect((await engine.getPage('projects/div', { sourceId: 'default' }))?.compiled_truth).toBe('CANONICAL_A');
    expect((await engine.getPage(`${PREFIX}projects/div`, { sourceId: 'default' }))?.compiled_truth).toBe('LEGACY_B');
    const again = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    expect(again.items.find(i => i.slug === `${PREFIX}projects/div`)?.outcome).toBe(BLOCK_DIVERGENT_DB);
  });

  test('COLLAPSE_IDENTICAL_FILE: vault file body matches legacy', async () => {
    vault = makeVault();
    mkdirSync(join(vault, 'logbook'), { recursive: true });
    writeFileSync(join(vault, 'logbook/index.md'), '---\ntitle: Index\n---\n\nINDEX BODY');
    await seed(`${PREFIX}logbook/index`, 'INDEX BODY');
    const plan = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    const item = plan.items.find(i => i.outcome === COLLAPSE_IDENTICAL_FILE);
    expect(item).toBeDefined();
    await applyRepair(engine, plan);
    expect(await engine.getPage(`${PREFIX}logbook/index`)).toBeNull();
  });

  test('BLOCK_DIVERGENT_FILE leaves both sides intact', async () => {
    vault = makeVault();
    mkdirSync(join(vault, 'notes'), { recursive: true });
    writeFileSync(join(vault, 'notes/conflict.md'), '---\ntitle: C\n---\n\nFILE BODY');
    await seed(`${PREFIX}notes/conflict`, 'DB BODY DIFFERS');
    const plan = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    const item = plan.items.find(i => i.outcome === 'BLOCK_DIVERGENT_FILE');
    expect(item).toBeDefined();
    await applyRepair(engine, plan);
    expect((await engine.getPage(`${PREFIX}notes/conflict`, { sourceId: 'default' }))?.compiled_truth).toBe('DB BODY DIFFERS');
  });

  test('COLLAPSE_TIMELINE_ONLY_DB: soft-deletes legacy, keeps file-backed canonical, no canonical refresh', async () => {
    vault = makeVault();
    const realBody = 'REAL CONTENT';
    const timelineAppendix = [
      `\n---\n\n## Timeline`,
      `- **2026-05-19** | added system dashboard`,
      `- **2026-08-22** | reconciled legacy prefix`,
    ].join('\n');
    // Canonical DB page carries the auto-generated Timeline appendix + matching
    // frontmatter timeline metadata; legacy carries only the real content.
    const canonFm = { title: 'System Dashboard', timeline: ['2026-05-19 added system dashboard'] };
    const legacyFm = { title: 'System Dashboard' };
    await seed('projects/hermes/system-dashboard', realBody + timelineAppendix, canonFm);
    await seed(`${PREFIX}projects/hermes/system-dashboard`, realBody, legacyFm);

    const plan = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    const item = plan.items.find(i => i.slug === `${PREFIX}projects/hermes/system-dashboard`);
    expect(item).toBeDefined();
    expect(item!.outcome).toBe(COLLAPSE_TIMELINE_ONLY_DB);

    await applyRepair(engine, plan);
    // Legacy duplicate soft-deleted; canonical DB row untouched (still has the
    // timeline appendix — the command never rewrote/refreshed canonical).
    expect(await engine.getPage(`${PREFIX}projects/hermes/system-dashboard`)).toBeNull();
    const canon = await engine.getPage('projects/hermes/system-dashboard', { sourceId: 'default' });
    expect(canon?.compiled_truth).toBe(realBody + timelineAppendix);
    const softDeleted = await engine.getPage(`${PREFIX}projects/hermes/system-dashboard`, { includeDeleted: true });
    expect(softDeleted?.deleted_at).not.toBeNull();
  });

  test('BLOCK_DIVERGENT_DB preserved for real content difference (e.g. bounty-market-reality)', async () => {
    vault = makeVault();
    // Canonical and legacy share real content prefix but differ substantively
    // (an extra meaningful paragraph), so even after the timeline appendix is
    // stripped the bodies disagree → must stay blocked.
    const canonBody = [
      'Bounty market reality summary.',
      'Distinct canonical analysis paragraph.',
      '\n---\n\n## Timeline',
      '- **2026-05-19** | updated outlook',
    ].join('\n');
    const legacyBody = 'Bounty market reality summary.\nDifferent legacy note about pricing.';
    await seed('projects/bounty-hunting/bounty-market-reality-may-2026', canonBody);
    await seed(`${PREFIX}projects/bounty-hunting/bounty-market-reality-may-2026`, legacyBody);

    const plan = await buildRepairPlan(engine, { prefix: PREFIX, vaultRoot: vault });
    const item = plan.items.find(i => i.slug === `${PREFIX}projects/bounty-hunting/bounty-market-reality-may-2026`);
    expect(item).toBeDefined();
    expect(item!.outcome).toBe(BLOCK_DIVERGENT_DB);

    await applyRepair(engine, plan);
    expect((await engine.getPage(`projects/bounty-hunting/bounty-market-reality-may-2026`, { sourceId: 'default' }))?.compiled_truth).toBe(canonBody);
    expect((await engine.getPage(`${PREFIX}projects/bounty-hunting/bounty-market-reality-may-2026`, { sourceId: 'default' }))?.compiled_truth).toBe(legacyBody);
  });
});

describe('pageToInput', () => {
  test('round-trips the content-bearing fields', () => {
    const input = pageToInput({
      id: 1, slug: 'x', type: 'concept', title: 'T', compiled_truth: 'BODY',
      timeline: '', frontmatter: { k: 'v' }, content_hash: 'h', source_id: 'default',
      created_at: new Date(), updated_at: new Date(),
    });
    expect(input.compiled_truth).toBe('BODY');
    expect(input.frontmatter).toEqual({ k: 'v' });
    expect(input.content_hash).toBe('h');
    expect(input.page_kind).toBe('markdown');
  });
});