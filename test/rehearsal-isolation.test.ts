/**
 * Rehearsal isolation regressions.
 *
 * The run99 rehearsal was database-isolated but not filesystem-isolated: its
 * disposable DB kept `sources.local_path` on the live vault, so the v0.32.2
 * fence phase wrote live `leviathan.md` / `repl-copter.md`. These regressions
 * pin the gate that must be green before any migration is invoked again:
 *
 *   - the live canonical root, an alias path and a symlink target all DENY;
 *   - every worksheet inside the disposable copy allows;
 *   - a symlink planted in the copy that points back at a live root is a breach;
 *   - remapping completeness is reported per surviving value, never summarized;
 *   - the OS write-denial probe is EXERCISED (real systemd sandbox, unprivileged
 *     rehearsal user); configured-but-unexercised isolation reports 'unverified',
 *     never 'isolated';
 *   - live content preservation is byte identity, not counts;
 *   - repeated evaluation is idempotent and partial results are reported honestly.
 *
 * The OS-level probe runs against a synthetic live root always, and against the
 * real live vault root when this host has it (read-only proof + fail-closed
 * gated write attempt — no note is ever created, modified or deleted).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  auditRemap, classifyPath, evaluateIsolation, manifestsEqual, preservationManifest,
  remapPath, sandboxDirectives, type CapabilityEvidence, type IsolationTargets,
} from '../scripts/rehearsal-isolation-gate.ts';

const PROBE = join(import.meta.dir, '..', 'scripts', 'rehearsal-write-denial-probe.sh');
// The synthetic fixture proves the general rule. Proving the REAL live root is
// denied needs the operator's own path, which must not be committed here: set
// GBRAIN_TEST_LIVE_VAULT to run that case (a rehearsal harness does).
const LIVE_VAULT = process.env.GBRAIN_TEST_LIVE_VAULT ?? '';

const scratch = mkdtempSync(join(tmpdir(), 'rehearsal-isolation-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

function fixture(name: string) {
  const root = join(scratch, name);
  const live = join(root, 'live');
  const alias = join(root, 'live-alias');
  const copy = join(root, 'copy');
  mkdirSync(join(live, 'notes'), { recursive: true });
  mkdirSync(join(copy, 'vault/notes'), { recursive: true });
  mkdirSync(join(copy, 'home'), { recursive: true });
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(live, 'notes/page.md'), '# live page\n');
  writeFileSync(join(copy, 'vault/notes/page.md'), '# copy page\n');
  symlinkSync(live, alias);
  return { root, live, alias, copy, outside: join(root, 'outside') };
}

function plan(f: ReturnType<typeof fixture>, over: Partial<IsolationTargets> = {}): IsolationTargets {
  return {
    liveRoots: [f.live, f.alias],
    disposableRoot: f.copy,
    home: join(f.copy, 'home'),
    tmpDir: join(f.copy, 'home'),
    dbUrl: 'postgresql://gbrain:secret@127.0.0.1:5449/gbrain',
    liveDbUrls: ['postgresql://gbrain:live@127.0.0.1:5432/gbrain'],
    sources: [
      { id: 'default', localPath: join(f.copy, 'vault'), repoPath: join(f.copy, 'vault') },
      { id: 'readwise', localPath: join(f.copy, 'vault/readwise'), repoPath: join(f.copy, 'vault/readwise') },
    ],
    pageFiles: [join(f.copy, 'vault/notes/page.md')],
    liveSourceValues: {
      default: { localPath: f.live, repoPath: f.live },
      readwise: { localPath: join(f.live, 'readwise'), repoPath: join(f.live, 'readwise') },
    },
    copyMap: [{ live: f.live, copy: join(f.copy, 'vault') }, { live: f.alias, copy: join(f.copy, 'vault') }],
    ...over,
  };
}

const EXERCISED: CapabilityEvidence = {
  liveRootInaccessibleInsideUnit: true,
  writeDeniedOnLiveRoot: true,
  writeAllowedOnDisposable: true,
  probePath: '/receipt.json',
};

describe('path identity: live canonical, alias and symlink targets deny', () => {
  test('the live canonical root denies, the disposable copy allows, outside paths remain unmapped', () => {
    const f = fixture('classify');
    const disposable = join(f.copy, 'vault');
    const liveRoots = [f.live];
    expect(classifyPath(join(f.live, 'notes/page.md'), liveRoots, disposable))
      .toMatchObject({ verdict: 'denied', matchedRoot: f.live });
    expect(classifyPath(join(disposable, 'notes/page.md'), liveRoots, disposable))
      .toMatchObject({ verdict: 'allowed' });
    expect(classifyPath(join(f.outside, 'notes/page.md'), liveRoots, disposable))
      .toMatchObject({ verdict: 'unmapped' });
    expect(classifyPath('relative/path.md', liveRoots, disposable))
      .toMatchObject({ verdict: 'unmapped', reason: 'not an absolute path' });
  });

  test('an alias path to the same tree denies even though its string prefix differs', () => {
    const f = fixture('alias');
    const classified = classifyPath(join(f.alias, 'notes/page.md'), [f.live], join(f.copy, 'vault'));
    expect(classified.verdict).toBe('denied');
    expect(classified.resolved).toBe(join(f.live, 'notes/page.md'));
    expect(classified.reason).toContain('symlink or alias');
  });

  test('a symlink planted inside the copy that points back at a live root is caught', () => {
    const f = fixture('trapdoor');
    symlinkSync(f.live, join(f.copy, 'vault/escape'));
    const targets = plan(f);
    const report = evaluateIsolation(targets, EXERCISED);
    expect(report.verdict).toBe('breached');
    expect(report.findings.map(x => x.code)).toContain('copy_symlinks_live_root');
    expect(report.findings.find(x => x.code === 'copy_symlinks_live_root')?.detail).toContain('escape');
  });
});

describe('rehearsal plan verdicts', () => {
  test('a fully remapped plan without exercised sandbox evidence is unverified, not isolated', () => {
    const f = fixture('unverified');
    const report = evaluateIsolation(plan(f));
    expect(report.paths).toBe('complete');
    expect(report.sandbox).toBe('unverified');
    expect(report.verdict).toBe('unverified');
    expect(report.findings.map(x => x.code)).toEqual(['sandbox_unverified']);
  });

  test('a partial evidence record is still unverified — every axis must be exercised', () => {
    const f = fixture('partial-evidence');
    for (const evidence of [
      { ...EXERCISED, liveRootInaccessibleInsideUnit: false },
      { ...EXERCISED, writeDeniedOnLiveRoot: false },
      { ...EXERCISED, writeAllowedOnDisposable: false },
    ]) {
      expect(evaluateIsolation(plan(f), evidence).verdict).toBe('unverified');
    }
  });

  test('a live source path breaches even when the sandbox was exercised', () => {
    const f = fixture('live-source');
    const targets = plan(f, { sources: [{ id: 'default', localPath: f.live, repoPath: f.alias }] });
    const report = evaluateIsolation(targets, EXERCISED);
    expect(report.verdict).toBe('breached');
    expect(report.paths).toBe('breached');
    expect(report.findings.map(x => x.code)).toEqual(['writer_on_live_root', 'writer_on_live_root']);
    expect(report.findings.map(x => x.detail)).toEqual([
      expect.stringContaining('sources.local_path[default]'),
      expect.stringContaining('sources.repo_path[default]'),
    ]);
  });

  test('an unremapped writer is reported with its own path, never silently defaulted', () => {
    const f = fixture('unmapped-writer');
    const stray = join(f.outside, 'stray');
    const report = evaluateIsolation(plan(f, { extraWriters: [stray] }), EXERCISED);
    expect(report.verdict).toBe('breached');
    const finding = report.findings.find(x => x.code === 'writer_outside_disposable');
    expect(finding?.target).toBe(stray);
  });

  test('HOME, TMPDIR and a live DB url are each reported', () => {
    const f = fixture('env');
    const report = evaluateIsolation(plan(f, {
      home: f.outside, tmpDir: f.outside, dbUrl: 'postgresql://gbrain:live@127.0.0.1:5432/gbrain',
    }), EXERCISED);
    expect(report.findings.map(x => x.code).sort()).toEqual(['home_outside', 'live_db_url', 'tmpdir_outside']);
  });

  test('directives pin ProtectSystem=strict, a writable slice inside the copy, and every live spelling', () => {
    const f = fixture('directives');
    const directives = sandboxDirectives(plan(f));
    expect(directives).toContain('ProtectSystem=strict');
    const writable = directives.find(d => d.startsWith('ReadWritePaths='))!;
    for (const entry of writable.replace('ReadWritePaths=', '').split(' ')) {
      expect(entry.startsWith(f.copy)).toBe(true);
    }
    const denied = directives.find(d => d.startsWith('InaccessiblePaths='))!;
    expect(denied).toContain(f.live);
    expect(denied).toContain(f.alias);
  });

  test('evaluation is idempotent', () => {
    const f = fixture('idempotent');
    const targets = plan(f);
    expect(evaluateIsolation(targets, EXERCISED)).toEqual(evaluateIsolation(targets, EXERCISED));
  });
});

describe('remapping completeness and content preservation', () => {
  test('remapPath moves a live value into the copy and refuses a non-live value', () => {
    const f = fixture('remap');
    const copyMap = [{ live: f.live, copy: join(f.copy, 'vault') }];
    expect(remapPath(join(f.live, 'notes/page.md'), copyMap))
      .toBe(join(f.copy, 'vault/notes/page.md'));
    expect(() => remapPath(join(f.outside, 'x'), copyMap)).toThrow('cannot remap');
  });

  test('auditRemap is complete only when every observed value is the remapped one', () => {
    const f = fixture('audit');
    const targets = plan(f);
    const remapped = {
      sources: { default: { localPath: join(f.copy, 'vault'), repoPath: join(f.copy, 'vault') } },
      home: join(f.copy, 'home'), dbUrl: targets.dbUrl,
    };
    expect(auditRemap(targets, remapped)).toEqual({ complete: true, unremapped: [] });

    const leaky = {
      sources: {
        default: { localPath: join(f.copy, 'vault'), repoPath: f.live },
        readwise: { localPath: join(f.alias, 'readwise') },
      },
      home: f.outside,
    };
    const audit = auditRemap(targets, leaky);
    expect(audit.complete).toBe(false);
    expect(audit.unremapped.map(u => u.field).sort())
      .toEqual(['home', 'sources.local_path[readwise]', 'sources.repo_path[default]']);
    expect(audit.unremapped.every(u => u.expected.length > 0)).toBe(true);
  });

  test('preservation is byte identity: a mutated live file is named', () => {
    const f = fixture('preserve');
    const files = [join(f.live, 'notes/page.md')];
    const before = preservationManifest(files);
    expect(manifestsEqual(before, preservationManifest(files))).toEqual({ equal: true, changed: [] });
    writeFileSync(join(f.live, 'notes/page.md'), '# live page\n\nmigrated body\n');
    const after = preservationManifest(files);
    expect(manifestsEqual(before, after)).toEqual({ equal: false, changed: files });
  });
});

describe('OS write-denial probe (exercised, unprivileged)', () => {
  function runProbe(liveRoots: string[], decoy: string, disposable: string): { rc: number; receipt: any } {
    const out = join(disposable, '..', 'receipt.json');
    let rc = 0;
    try {
      execFileSync('bash', [PROBE, ...liveRoots.flatMap(r => ['--live-root', r]),
        '--decoy', decoy, '--disposable', disposable, '--out', out], { cwd: join(import.meta.dir, '..'), stdio: 'pipe' });
    } catch (error) {
      rc = (error as { status?: number }).status ?? 1;
    }
    return { rc, receipt: JSON.parse(readFileSync(out, 'utf-8')) };
  }

  test('the sandbox denies a write to a live-shaped root and allows the disposable copy', () => {
    const f = fixture('probe-synthetic');
    const decoy = join(f.root, 'decoy');
    const disposable = join(f.copy, 'probe-writes');
    mkdirSync(decoy, { recursive: true });
    mkdirSync(disposable, { recursive: true });
    const liveBefore = preservationManifest([join(f.live, 'notes/page.md')]);
    const listingBefore = readdirSync(f.live).sort();

    const { rc, receipt } = runProbe([f.live], decoy, disposable);
    if (rc === 3) {
      // No systemd-run on this host: the gate must stay honest, never 'isolated'.
      expect(receipt).toMatchObject({ verdict: 'unverified', verified: false });
      expect(evaluateIsolation(plan(f), {}).verdict).toBe('unverified');
      return;
    }
    expect(rc).toBe(0);
    expect(receipt).toMatchObject({
      verified: true, verdict: 'isolated',
      live_root_inaccessible_inside_unit: true,
      write_denied_on_live_root: true,
      write_allowed_on_disposable: true,
      control_decoy_reachable: true,
    });
    // No note was touched: byte identity, not counts.
    expect(manifestsEqual(liveBefore, preservationManifest([join(f.live, 'notes/page.md')])).equal).toBe(true);
    expect(readdirSync(f.live).sort()).toEqual(listingBefore);
    expect(readdirSync(decoy)).toEqual([]);
    expect(evaluateIsolation(plan(f), receipt.evidence).verdict).toBe('isolated');
  });

  test('the probe is idempotent and reports partial failure honestly', () => {
    const f = fixture('probe-idempotent');
    const decoy = join(f.root, 'decoy');
    mkdirSync(decoy, { recursive: true });
    const first = runProbe([f.live], decoy, join(f.copy, 'writes-1'));
    const second = runProbe([f.live], decoy, join(f.copy, 'writes-2'));
    if (first.rc === 3) return;  // unverified host: nothing further to prove here
    expect(second.rc).toBe(first.rc);
    expect(second.receipt.verified).toBe(first.receipt.verified);

    // A root that does not exist cannot be proven inaccessible: fail, don't pass.
    const missing = runProbe([join(f.root, 'does-not-exist')], decoy, join(f.copy, 'writes-3'));
    expect(missing.rc).toBe(1);
    expect(missing.receipt.verified).toBe(false);
    expect(missing.receipt.live_root_inaccessible_inside_unit).toBe(false);
  });

  const hasLiveVault = LIVE_VAULT.length > 0 && existsSync(LIVE_VAULT);
  test.skipIf(!hasLiveVault)('the real live vault root is inaccessible to the rehearsal user', () => {
    const f = fixture('probe-live');
    const decoy = join(f.root, 'decoy');
    mkdirSync(decoy, { recursive: true });
    const listingBefore = readdirSync(LIVE_VAULT).sort();
    const { rc, receipt } = runProbe([LIVE_VAULT, f.alias], decoy, join(f.copy, 'writes-live'));
    if (rc === 3) return;
    expect(receipt.live_root_inaccessible_inside_unit).toBe(true);
    // The unprivileged rehearsal user cannot list the live vault inside the
    // sandbox; the operator (outside it) still can, and nothing changed.
    expect(receipt.steps.find((s: { name: string }) => s.name.startsWith('live_inaccessible_'))?.stdout)
      .toBe('INACCESSIBLE');
    expect(readdirSync(LIVE_VAULT).sort()).toEqual(listingBefore);
  });
});
