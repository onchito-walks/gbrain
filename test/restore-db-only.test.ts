/**
 * gbrain restore-db-only — classification + PGLite/temp-vault apply tests.
 *
 * Covers the pure classifier (RESTORE_READY vs every BLOCK_*), the vault-path
 * safety guard, and the file-plane apply behavior (writes a markdown file,
 * NEVER mutates the DB, refuses overwrites, hard-blocks the legacy
 * hermes-moncho/ prefix) against PGLite + a temp vault — DATABASE_URL-free.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  classifyRestore,
  targetFile,
  buildRestorePlan,
  applyRestore,
  RESTORE_READY,
  MISSING_PAGE,
  FILE_EXISTS,
  LEGACY_PREFIX,
  UNSAFE_PATH,
  LEGACY_DIVERGENT_PREFIX,
} from '../src/commands/restore-db-only.ts';

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

async function seed(slug: string, body: string, title?: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'concept' as any,
    title: title ?? slug.split('/').pop() ?? slug,
    compiled_truth: body,
    timeline: '',
    frontmatter: { note: 'seed' },
  });
}

function makeVault(): string {
  return mkdtempSync(join(tmpdir(), 'rdb-test-'));
}

describe('classifyRestore (pure)', () => {
  test('RESTORE_READY: page present, file absent, plain slug', () => {
    const r = classifyRestore({ slug: 'ops/repair-note', pageExists: true, fileExists: false, unsafePath: false });
    expect(r.outcome).toBe(RESTORE_READY);
  });

  test('MISSING_PAGE: no page → blocked', () => {
    const r = classifyRestore({ slug: 'ops/ghost', pageExists: false, fileExists: false, unsafePath: false });
    expect(r.outcome).toBe(MISSING_PAGE);
  });

  test('LEGACY_PREFIX: hermes-moncho/ slug is blocked even when file absent', () => {
    const r = classifyRestore({ slug: `${LEGACY_DIVERGENT_PREFIX}concepts/x`, pageExists: true, fileExists: false, unsafePath: false });
    expect(r.outcome).toBe(LEGACY_PREFIX);
  });

  test('FILE_EXISTS: existing target file is never overwritten', () => {
    const r = classifyRestore({ slug: 'ops/note', pageExists: true, fileExists: true, unsafePath: false });
    expect(r.outcome).toBe(FILE_EXISTS);
  });

  test('LEGACY_PREFIX takes precedence over FILE_EXISTS for divergent rows', () => {
    const r = classifyRestore({ slug: `${LEGACY_DIVERGENT_PREFIX}projects/x`, pageExists: true, fileExists: true, unsafePath: false });
    expect(r.outcome).toBe(LEGACY_PREFIX);
  });

  test('UNSAFE_PATH: path-traversal slug is blocked', () => {
    const r = classifyRestore({ slug: '../etc/passwd', pageExists: true, fileExists: false, unsafePath: true });
    expect(r.outcome).toBe(UNSAFE_PATH);
  });
});

describe('targetFile (vault containment)', () => {
  const root = '/tmp/rdb-vault-root';
  test('normal slug stays inside vault root', () => {
    const { path, inside } = targetFile(root, 'a/nested/slug');
    expect(inside).toBe(true);
    expect(path.endsWith('a/nested/slug.md')).toBe(true);
  });
  test('traversal slug escapes → flagged', () => {
    const { inside } = targetFile(root, '../escape');
    expect(inside).toBe(false);
  });
});

describe('restore-db-only plan + apply (PGLite + temp vault)', () => {
  let vault: string;

  test('RESTORE_READY is planned and applied; DB page untouched', async () => {
    vault = makeVault();
    try {
      await seed('ops/repair-note', 'ARM BODY CONTENT');

      const plan = await buildRestorePlan(engine, { slugs: ['ops/repair-note'], vaultRoot: vault });
      const item = plan.items.find(i => i.slug === 'ops/repair-note');
      expect(item?.outcome).toBe(RESTORE_READY);
      expect(plan.applicable.length).toBe(1);
      expect(plan.blocked.length).toBe(0);

      const results = await applyRestore(engine, plan);
      expect(results.some(r => r.action === 'RESTORED')).toBe(true);

      // File materialized with the page body.
      const content = readFileSync(join(vault, 'ops', 'repair-note.md'), 'utf-8');
      expect(content).toContain('ARM BODY CONTENT');

      // DB page is byte-identical and NOT soft-deleted — never mutated.
      const page = await engine.getPage('ops/repair-note', { sourceId: 'default' });
      expect(page).not.toBeNull();
      expect(page!.compiled_truth).toBe('ARM BODY CONTENT');
      expect(page!.deleted_at).toBeFalsy();
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test('FILE_EXISTS blocks; existing file is never overwritten', async () => {
    vault = makeVault();
    try {
      mkdirSync(join(vault, 'ops'), { recursive: true });
      writeFileSync(join(vault, 'ops', 'present.md'), 'ORIGINAL FILE');
      await seed('ops/present', 'DB BODY');

      const plan = await buildRestorePlan(engine, { slugs: ['ops/present'], vaultRoot: vault });
      expect(plan.items[0].outcome).toBe(FILE_EXISTS);
      expect(plan.applicable.length).toBe(0);

      await applyRestore(engine, plan);
      expect(readFileSync(join(vault, 'ops', 'present.md'), 'utf-8')).toBe('ORIGINAL FILE');
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test('LEGACY_PREFIX is blocked and never materialized, DB untouched', async () => {
    vault = makeVault();
    try {
      await seed(`${LEGACY_DIVERGENT_PREFIX}concepts/leviathan-x`, 'DIVERGENT LEGACY BODY');

      const plan = await buildRestorePlan(engine, { slugs: [`${LEGACY_DIVERGENT_PREFIX}concepts/leviathan-x`], vaultRoot: vault });
      expect(plan.items[0].outcome).toBe(LEGACY_PREFIX);
      expect(plan.applicable.length).toBe(0);

      await applyRestore(engine, plan);
      // No file under the legacy path.
      const legacyFsPath = join(vault, ...`${LEGACY_DIVERGENT_PREFIX}concepts/leviathan-x`.split('/')) + '.md';
      expect(existsSync(legacyFsPath)).toBe(false);
      // DB page intact + not soft-deleted.
      const page = await engine.getPage(`${LEGACY_DIVERGENT_PREFIX}concepts/leviathan-x`, { sourceId: 'default' });
      expect(page?.compiled_truth).toBe('DIVERGENT LEGACY BODY');
      expect(page!.deleted_at).toBeFalsy();
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test('MISSING_PAGE is blocked', async () => {
    vault = makeVault();
    try {
      const plan = await buildRestorePlan(engine, { slugs: ['ops/ghost'], vaultRoot: vault });
      expect(plan.items[0].outcome).toBe(MISSING_PAGE);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test('TOCTOU guard: file appearing after plan build is SKIPPED, not written', async () => {
    vault = makeVault();
    try {
      await seed('ops/race', 'RACE BODY');
      const plan = await buildRestorePlan(engine, { slugs: ['ops/race'], vaultRoot: vault });
      expect(plan.items[0].outcome).toBe(RESTORE_READY);
      // File appears before apply.
      mkdirSync(join(vault, 'ops'), { recursive: true });
      writeFileSync(join(vault, 'ops', 'race.md'), 'CONTENDER');
      const results = await applyRestore(engine, plan);
      expect(results[0].action).toBe('SKIPPED');
      expect(readFileSync(join(vault, 'ops', 'race.md'), 'utf-8')).toBe('CONTENDER');
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test('applyRestore never mutates the DB (content + deleted_at preserved)', async () => {
    vault = makeVault();
    try {
      await seed('research/note', 'SOME BODY');
      const plan = await buildRestorePlan(engine, { slugs: ['research/note'], vaultRoot: vault });
      await applyRestore(engine, plan);
      const page = await engine.getPage('research/note', { sourceId: 'default', includeDeleted: true });
      expect(page?.compiled_truth).toBe('SOME BODY');
      expect(page!.deleted_at).toBeFalsy();
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});