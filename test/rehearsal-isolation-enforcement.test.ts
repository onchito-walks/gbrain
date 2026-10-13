/**
 * Rehearsal isolation ENFORCEMENT regressions — the real `apply-migrations`
 * caller, not just the gate's pure classifier.
 *
 * test/rehearsal-isolation.test.ts pins the gate's decisions in isolation
 * (path identity, remapping audit, exercise evidence, preservation). This file
 * pins the caller contract that makes those decisions matter: with
 * GBRAIN_REHEARSAL_ROOTS set, `apply-migrations` must refuse BEFORE any
 * orchestrator runs, name the offending target, and leave the live tree
 * byte-identical — while a brain whose every writer target sits inside the
 * allowlist still migrates normally.
 *
 * The run99 breach was a string-prefix pass: the disposable DB's
 * `sources.local_path` still pointed at the live vault, so the fence phase
 * wrote live notes. The refusal case here is the sharper form of the same
 * bug — a symlink INSIDE the disposable copy whose *string* is under the
 * allowlist but whose resolved target is a live root.
 *
 * Disposable only: the "live" tree, the brain files and the home directory are
 * created under the test base directory. No production path is written.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { VERSION } from '../src/version.ts';
import { collect } from './helpers/apply-migrations-lock-driver.ts';

const REPO = resolve(import.meta.dir, '..');
// An explicit base outside any managed canonical worktree: gbrain's
// owner-marker guard refuses writes into one by design, and this test seeds a
// real PGLite brain.
const BASE = process.env.GBRAIN_TEST_ISOLATION_BASE ?? '/tmp';

type Spawned = ReturnType<typeof Bun.spawn>;

let base: string;
let home: string;
let liveTree: string;
let alias: string;
let notePath: string;
let noteHashBefore: string;
let liveListingBefore: string[];

const driverPath = () => join(home, 'enforcement-driver.ts');
const logPath = () => join(home, 'orchestrator.log');
const sourcePath = () => join(home, 'vault');
/** Byte-identity of the live note, as a digest: counts would not catch a rewrite. */
const noteDigest = () => createHash('sha256').update(readFileSync(notePath)).digest('hex');

/**
 * A runner whose single pending migration records start/end around its work,
 * exactly like the orchestration-lock drivers. `VERSION` keeps it pending on a
 * freshly seeded brain.
 */
function writeDriver(): void {
  writeFileSync(driverPath(), `import { mock } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { VERSION } from ${JSON.stringify(join(REPO, 'src/version.ts'))};
const log = ${JSON.stringify(logPath())};
mock.module(${JSON.stringify(join(REPO, 'src/commands/migrations/index.ts'))}, () => ({
  compareVersions: (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  migrations: [{
    version: VERSION,
    featurePitch: { headline: 'rehearsal isolation enforcement' },
    orchestrator: async () => {
      appendFileSync(log, 'start ' + process.pid + '\\n');
      appendFileSync(log, 'end ' + process.pid + '\\n');
      return { version: VERSION, status: 'complete', phases: [] };
    },
  }],
}));
const { runApplyMigrations } = await import(${JSON.stringify(join(REPO, 'src/commands/apply-migrations.ts'))});
await runApplyMigrations(['--yes', '--non-interactive', '--no-autopilot-install']);
process.exit(0);
`);
}

function spawnRunner(extraEnv: Record<string, string>): Spawned {
  return Bun.spawn([process.execPath, '--no-env-file', driverPath()], {
    cwd: home,
    env: {
      HOME: home,
      GBRAIN_HOME: home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GBRAIN_SKIP_REFERENCE_SWEEP: '1',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function withEngine<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const cfg = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
  const engine = await createEngine(cfg as never);
  await engine.connect(cfg as never);
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

beforeAll(async () => {
  base = mkdtempSync(join(BASE, 'rehearsal-enforcement-'));
  home = join(base, 'disposable-home');
  liveTree = join(base, 'live-tree');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(liveTree, 'notes'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
  notePath = join(liveTree, 'notes/page.md');
  writeFileSync(notePath, '# live page\n\nnever migrate me\n');
  noteHashBefore = noteDigest();
  liveListingBefore = readdirSync(liveTree).sort();

  // The breach shape: an alias whose resolved target is the live tree but
  // whose literal path is inside the disposable home.
  alias = join(home, 'vault-alias');
  symlinkSync(liveTree, alias);

  writeDriver();
  await withEngine(async engine => {
    await engine.initSchema();
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [alias]);
  });
}, 240_000);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('apply-migrations enforces rehearsal isolation before any orchestrator', () => {
  test('a source path that resolves to a live root refuses, names the target, and applies nothing', async () => {
    // The allowlist is the disposable home, so the alias STRING passes a
    // prefix check; only symlink resolution reveals the live target.
    const run = await collect(spawnRunner({ GBRAIN_REHEARSAL_ROOTS: home }) as Spawned);

    expect(run.code, run.stderr).not.toBe(0);
    expect(run.code, 'the lock-refusal path must not be what stopped this run').not.toBe(75);
    expect(run.stderr).toContain('Rehearsal isolation refused');
    expect(run.stderr).toContain('sources.local_path:default');
    expect(run.stderr).toContain(resolve(liveTree));
    expect(run.stderr).toContain('Nothing was applied');
    // Refused BEFORE any orchestrator: no phase, side effect or partial run.
    expect(existsSync(logPath())).toBe(false);
    expect(run.stdout).not.toContain('Applying migration');
    // The live tree is untouched, byte for byte.
    expect(noteDigest()).toBe(noteHashBefore);
    expect(readdirSync(liveTree).sort()).toEqual(liveListingBefore);
  }, 240_000);

  test('the same brain migrates normally once every writer target is inside the allowlist', async () => {
    rmSync(alias);
    mkdirSync(sourcePath(), { recursive: true });
    await withEngine(async engine => {
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [sourcePath()]);
    });

    const run = await collect(spawnRunner({ GBRAIN_REHEARSAL_ROOTS: home }) as Spawned);

    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(run.stdout).toContain('rehearsal isolation enforcement');
    expect(readFileSync(logPath(), 'utf8').match(/^start /gm)?.length).toBe(1);
    // A disposable run still never touches the live tree.
    expect(noteDigest()).toBe(noteHashBefore);
    expect(readdirSync(liveTree).sort()).toEqual(liveListingBefore);
  }, 240_000);

  test('the guard is inert without GBRAIN_REHEARSAL_ROOTS (production default keeps working)', async () => {
    // The previous run applied the only mocked migration, so this run reports
    // up-to-date instead of re-applying it: the point is that nothing refused
    // and no isolation error was raised with the variable unset.
    const run = await collect(spawnRunner({}) as Spawned);

    expect(run.code, run.stderr + run.stdout).toBe(0);
    expect(run.stderr).not.toContain('Rehearsal isolation refused');
  }, 240_000);
});
