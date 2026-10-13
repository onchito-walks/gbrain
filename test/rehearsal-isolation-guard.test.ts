import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrainEngine } from '../src/core/engine.ts';
import {
  REHEARSAL_ROOTS_ENV,
  checkTargets,
  collectWriterTargets,
  isInside,
  isolationViolationMessage,
  parseRehearsalRoots,
  resolveForComparison,
} from '../src/core/rehearsal/isolation-guard.ts';

describe('rehearsal isolation guard', () => {
  let root: string;      // scratch parent
  let disp: string;      // disposable rehearsal root
  let live: string;      // "live" tree the guard must protect
  let alias: string;     // symlink -> live

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rehearsal-isolation-'));
    disp = join(root, 'iso', 'mirror');
    live = join(root, 'live-vault');
    mkdirSync(disp, { recursive: true });
    mkdirSync(join(live, 'notes'), { recursive: true });
    alias = join(root, 'alias-vault');
    symlinkSync(live, alias);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the guard is disabled unless GBRAIN_REHEARSAL_ROOTS is set', () => {
    expect(parseRehearsalRoots({})).toBeNull();
    expect(parseRehearsalRoots({ [REHEARSAL_ROOTS_ENV]: '' })).toBeNull();
    expect(parseRehearsalRoots({ [REHEARSAL_ROOTS_ENV]: `${disp}, ${disp}/extra ` }))
      .toEqual([disp, join(disp, 'extra')]);
  });

  test('disabled guard accepts anything (production default)', () => {
    const check = checkTargets({ 'sources.local_path:default': live }, null);
    expect(check.ok).toBe(true);
    expect(check.enabled).toBe(false);
    expect(check.violations).toEqual([]);
  });

  test('a fully disposable set of targets passes', () => {
    const check = checkTargets({
      'sources.local_path:default': join(disp, 'srv/minio/hermes/home/.obsidian/rd3/hermes-moncho'),
      'sources.local_path:readwise': join(disp, 'srv/minio/hermes/home/.obsidian/rd3/Readwise'),
      'config.sync.repo_path': join(disp, 'srv/minio/hermes/home/.obsidian/rd3/hermes-moncho'),
      'config.shared_skills.migration.v1#root0': disp,
      'env.HOME': join(root, 'iso', 'home'),
      'env.TMPDIR': join(root, 'iso', 'tmp'),
    }, [join(root, 'iso')]);
    expect(check.ok).toBe(true);
    expect(check.violations).toEqual([]);
    expect(check.checked.length).toBe(6);
  });

  test('a live source root is refused and named', () => {
    const check = checkTargets({
      'sources.local_path:default': join(disp, 'vault'),
      'sources.local_path:readwise': join(live, 'notes'),
    }, [disp]);
    expect(check.ok).toBe(false);
    expect(check.violations.map(v => v.target)).toEqual(['sources.local_path:readwise']);
    expect(isolationViolationMessage(check)).toContain('sources.local_path:readwise');
    expect(isolationViolationMessage(check)).toContain(REHEARSAL_ROOTS_ENV);
  });

  test('a symlink alias of the live tree is refused (string prefix would pass)', () => {
    // The literal value sits under the scratch parent, not under `disp`:
    // only symlink resolution reveals it points into the live tree.
    const check = checkTargets({
      'sources.local_path:default': join(alias, 'notes'),
    }, [disp]);
    expect(check.violations.length).toBe(1);
    expect(check.violations[0]!.resolved).toBe(resolveForComparison(join(live, 'notes')));
    expect(check.ok).toBe(false);
  });

  test('a sibling directory sharing the root prefix is not "inside"', () => {
    expect(isInside(join(root, 'iso'), join(root, 'iso'))).toBe(true);
    expect(isInside(join(root, 'iso', 'mirror'), join(root, 'iso'))).toBe(true);
    expect(isInside(join(root, 'iso2'), join(root, 'iso'))).toBe(false);
    expect(isInside(join(root, 'iso', '..', 'live-vault'), join(root, 'iso'))).toBe(false);
  });

  test('relative and empty targets are ignored', () => {
    const check = checkTargets({
      'sources.local_path:a': null,
      'sources.local_path:b': 'relative/path',
      'env.HOME': undefined,
    }, [disp]);
    expect(check.ok).toBe(true);
    expect(check.checked).toEqual([]);
  });

  test('collectWriterTargets pulls source, config and env roots', async () => {
    const stub = {
      async executeRaw(sql: string) {
        if (sql.includes('FROM sources')) {
          return [
            { id: 'default', local_path: `${disp}/vault` },
            { id: 'readwise', local_path: `${live}/Readwise` },
          ];
        }
        if (sql.includes('FROM config')) {
          return [
            { key: 'sync.repo_path', value: `${disp}/vault` },
            { key: 'dream.synthesize.session_corpus_dir', value: `${disp}/corpus` },
            {
              key: 'shared_skills.migration.v1',
              value: JSON.stringify({
                sources: [
                  { source_id: 'default', root: `${disp}/vault` },
                  { source_id: 'readwise', root: `${live}/Readwise` },
                ],
              }),
            },
          ];
        }
        return [];
      },
    } as unknown as BrainEngine;

    const targets = await collectWriterTargets(stub, {
      HOME: `${root}/iso/home`,
      TMPDIR: `${root}/iso/tmp`,
    } as Record<string, string>);

    expect(targets['sources.local_path:default']).toBe(`${disp}/vault`);
    expect(targets['sources.local_path:readwise']).toBe(`${live}/Readwise`);
    expect(targets['config.sync.repo_path']).toBe(`${disp}/vault`);
    expect(targets['config.dream.synthesize.session_corpus_dir']).toBe(`${disp}/corpus`);
    expect(targets['config.shared_skills.migration.v1#root1']).toBe(`${live}/Readwise`);
    expect(targets['env.HOME']).toBe(`${root}/iso/home`);
    expect(targets['env.TMPDIR']).toBe(`${root}/iso/tmp`);

    const check = checkTargets(targets, [`${root}/iso`]);
    expect(check.ok).toBe(false);
    expect(check.violations.map(v => v.target).sort())
      .toEqual(['config.shared_skills.migration.v1#root1', 'sources.local_path:readwise']);
  });
});
