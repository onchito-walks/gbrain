/**
 * A source may live in a SUBDIRECTORY of a larger repository: coverage groups
 * by the git toplevel, so the asset root is a parent of the source directory.
 * `git status --porcelain` walks the whole work tree, so an unrelated sibling
 * folder's edits used to mark a clean source dirty (and blocked verification
 * forever). These tests pin the scoped verdict and the fail-closed fallback.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { computeBackupCoverage } from '../src/core/backup/coverage.ts';
import { assessBackupRepository } from '../src/core/backup/repository.ts';
import { __setBackupStatusPathForTests } from '../src/core/backup/status-file.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

let tmp: string;
let oldHome: string | undefined;
const now = new Date('2026-09-22T12:00:00Z');

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-backup-scope-'));
  oldHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
  __setBackupStatusPathForTests(join(tmp, 'status.json'));
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = oldHome;
  __setBackupStatusPathForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Parent repo containing the registered source dir plus an unrelated sibling. */
async function parentWithSibling(): Promise<{ parent: string; source: string; sibling: string }> {
  const parent = join(tmp, 'brain');
  mkdirSync(join(parent, 'source'), { recursive: true });
  mkdirSync(join(parent, 'sibling'), { recursive: true });
  await makeGitFixture(parent);
  git(parent, 'branch', '-M', 'main');
  writeFileSync(join(parent, 'source', 'note.md'), '# Source memory\n');
  writeFileSync(join(parent, 'sibling', 'other.md'), '# Unrelated sibling\n');
  git(parent, 'add', '.');
  git(parent, 'commit', '-m', 'fixture');
  const remote = join(tmp, 'brain.git');
  git(tmp, 'init', '--bare', '-b', 'main', remote);
  git(parent, 'remote', 'add', 'origin', remote);
  git(parent, 'push', '-u', 'origin', 'main');
  return { parent, source: join(parent, 'source'), sibling: join(parent, 'sibling') };
}

function engine(roots: string[]): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async (sql: string) => sql.includes('FROM pages') ? [{ n: 1 }]
      : roots.map((root, i) => ({ id: `fixture-${i}`, name: 'fixture', local_path: root, archived: false, config: {} })),
  } as unknown as BrainEngine;
}

test('subdir source stays ok while an unrelated sibling is dirty (tracked edit + untracked file)', async () => {
  const { parent, source, sibling } = await parentWithSibling();
  writeFileSync(join(sibling, 'other.md'), '# edited outside the source\n');
  writeFileSync(join(sibling, 'brand-new.md'), '# untracked outside the source\n');

  const scoped = await assessBackupRepository(parent, 'source_repo', 'readwise', now, undefined, undefined, ['source']);
  expect(scoped.state).toBe('ok');
  expect(scoped.detail).toBeUndefined();

  // No scope = the whole-work-tree verdict (the pre-fix verdict) — still
  // available as a fail-closed fallback for a path that cannot be scoped.
  const unscoped = await assessBackupRepository(parent, 'source_repo', 'readwise', now);
  expect(unscoped.state).toBe('dirty');
  expect(source).toBeTruthy();
});

test('a change INSIDE the source subtree is still dirty, tracked and untracked', async () => {
  const { parent, source } = await parentWithSibling();

  writeFileSync(join(source, 'note.md'), '# edited inside the source\n');
  const tracked = await assessBackupRepository(parent, 'source_repo', 'readwise', now, undefined, undefined, ['source']);
  expect(tracked.state).toBe('dirty');

  git(parent, 'checkout', '--', 'source/note.md');
  writeFileSync(join(source, 'fresh.md'), '# untracked inside the source\n');
  const untracked = await assessBackupRepository(parent, 'source_repo', 'readwise', now, undefined, undefined, ['source']);
  expect(untracked.state).toBe('dirty');
});

test('a source at the repository root still takes the whole-repo verdict', async () => {
  const { parent, sibling } = await parentWithSibling();
  writeFileSync(join(sibling, 'other.md'), '# any change in this repo\n');
  const verdict = await assessBackupRepository(parent, 'source_repo', 'root-source', now);
  expect(verdict.state).toBe('dirty');
});

test('sibling-only unpushed commits do not make the subdir source unpushed', async () => {
  const { parent, sibling } = await parentWithSibling();
  writeFileSync(join(sibling, 'other.md'), '# sibling-only commit\n');
  git(parent, 'add', 'sibling/other.md');
  git(parent, 'commit', '-m', 'sibling only');

  const scoped = await assessBackupRepository(parent, 'source_repo', 'readwise', now, undefined, undefined, ['source']);
  expect(scoped.state).toBe('ok');

  const unscoped = await assessBackupRepository(parent, 'source_repo', 'readwise', now);
  expect(unscoped.state).toBe('unpushed');
});

test('an unpushed commit that touches the source subtree is still reported', async () => {
  const { parent, source } = await parentWithSibling();
  writeFileSync(join(source, 'note.md'), '# source-only commit\n');
  git(parent, 'add', 'source/note.md');
  git(parent, 'commit', '-m', 'source only');

  const scoped = await assessBackupRepository(parent, 'source_repo', 'readwise', now, undefined, undefined, ['source']);
  expect(scoped.state).toBe('unpushed');
  expect(scoped.ahead).toBe(1);
});

test('coverage wires the subtree scope: a clean subdir source does not inherit sibling dirt', async () => {
  const { source, sibling } = await parentWithSibling();
  writeFileSync(join(sibling, 'other.md'), '# edited outside the source\n');

  const status = await computeBackupCoverage(engine([source]), { localGitProbes: true, now });
  const asset = status.assets.find((a) => a.kind === 'source_repo' && a.id === 'fixture-0');
  expect(asset?.state).toBe('ok');
  expect(status.totals.no_remote).toBe(0);
});

test('coverage still reports a change inside the subdir source as dirty', async () => {
  const { source } = await parentWithSibling();
  writeFileSync(join(source, 'note.md'), '# edited inside the source\n');

  const status = await computeBackupCoverage(engine([source]), { localGitProbes: true, now });
  const asset = status.assets.find((a) => a.kind === 'source_repo' && a.id === 'fixture-0');
  expect(asset?.state).toBe('dirty');
});
