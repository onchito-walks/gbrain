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
  pageToInput,
  walkVault,
  buildRepairPlan,
  applyRepair,
  COLLAPSE_IDENTICAL_DB,
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

async function seed(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note' as any,
    title: slug.split('/').pop() ?? slug,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
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