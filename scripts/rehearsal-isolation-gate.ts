/**
 * Rehearsal isolation gate — prove a disposable migration rehearsal cannot
 * reach the live brain before it is allowed to run.
 *
 * Why this exists: the run99 rehearsal was database-isolated but NOT
 * filesystem-isolated. The disposable DB's `sources.local_path` still pointed
 * at the live vault, so the v0.32.2 fence phase wrote `leviathan.md` and
 * `repl-copter.md` in production. A disposable database alone is not
 * isolation: every writer target (source local_path, sync repo_path, page
 * file paths, HOME, TMPDIR, DB connection) must be re-pointed at copies, and
 * the live roots must be unreachable at the OS level, not merely unchanged by
 * configuration.
 *
 * The gate reports two independent axes and never collapses them:
 *   - `paths`:    'complete' | 'incomplete' | 'breached'  (config remapping)
 *   - `sandbox`:  'exercised' | 'unverified'              (OS enforcement)
 * The overall verdict is 'isolated' only when paths are complete AND the
 * sandbox write-denial was actually exercised. Configured-but-unproven is
 * reported as 'unverified', never as isolated.
 *
 * Matched by path identity, not string equality: canonical path, alias path
 * and symlink target all deny. A symlink planted inside the copy tree that
 * points back at a live root is a breach, not an allowance.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface RehearsalSourceTarget {
  id: string;
  /** `sources.local_path` as the rehearsal will observe it (already remapped). */
  localPath: string | null;
  /** `sources.repo_path` — the sync writer target. */
  repoPath?: string | null;
}

export interface IsolationTargets {
  /** Live canonical root, aliases and symlink targets — every spelling of the live brain. */
  liveRoots: string[];
  /** The single disposable root every write target must resolve under. */
  disposableRoot: string;
  /** Disposable HOME the rehearsal runs with. */
  home: string;
  /** TMPDIR the rehearsal runs with. */
  tmpDir?: string;
  /** DB connection string the rehearsal will use. */
  dbUrl: string;
  /** Live / production DB connection strings that must never appear in the plan. */
  liveDbUrls?: string[];
  /** Configured writer paths (post-remap) for every registered source. */
  sources: RehearsalSourceTarget[];
  /** Absolute page file paths the DB resolves through `resolvePageWriteTarget`. */
  pageFiles?: string[];
  /** Any other native writer target discovered during copy construction. */
  extraWriters?: string[];
  /** The live values recorded before remapping, keyed by source id — audit input. */
  liveSourceValues?: Record<string, { localPath?: string | null; repoPath?: string | null }>;
  /** live root → destination copy of that root. Defaults to every live root → disposableRoot. */
  copyMap?: Array<{ live: string; copy: string }>;
}

export type PathVerdict = 'allowed' | 'denied' | 'unmapped';

export interface PathClassification {
  target: string;
  /** The path with symlinks resolved as far as it exists on disk. */
  resolved: string;
  verdict: PathVerdict;
  /** Which live root matched, when the verdict is 'denied'. */
  matchedRoot?: string;
  reason: string;
}

export interface IsolationFinding {
  code: 'writer_outside_disposable' | 'writer_on_live_root' | 'live_db_url' | 'home_outside'
    | 'tmpdir_outside' | 'copy_symlinks_live_root' | 'copy_scan_truncated' | 'sandbox_unverified';
  target: string;
  detail: string;
}

export interface CapabilityEvidence {
  /** Set only from a real exercised write-denial probe, never from configuration. */
  writeDeniedOnLiveRoot?: boolean;
  writeAllowedOnDisposable?: boolean;
  liveRootInaccessibleInsideUnit?: boolean;
  probePath?: string;
}

export interface IsolationReport {
  verdict: 'isolated' | 'unverified' | 'breached';
  paths: 'complete' | 'incomplete' | 'breached';
  sandbox: 'exercised' | 'unverified';
  disposableRoot: string;
  deniedRoots: string[];
  classifications: PathClassification[];
  findings: IsolationFinding[];
  directives: string[];
}

/** Strip a trailing separator; keep '/' itself. */
function normalize(path: string): string {
  const abs = resolve(path);
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
}

/**
 * Resolve symlinks as far as the path exists, then re-append the rest. A
 * rehearsal target usually does not exist yet (a fence file about to be
 * written), but its ancestor directory may already be a symlink into the live
 * vault — resolving only existing ancestors catches exactly that.
 */
export function resolveExisting(path: string): { resolved: string; resolvedAny: boolean } {
  const abs = normalize(path);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    if (existsSync(head)) {
      let real = head;
      try { real = realpathSync(head); } catch { /* unreadable: keep literal */ }
      return { resolved: normalize(join(real, ...tail.reverse())), resolvedAny: true };
    }
    const parent = dirname(head);
    if (parent === head) return { resolved: abs, resolvedAny: false };
    tail.push(head.slice(parent.length + (parent === sep ? 0 : 1)));
    head = parent;
  }
}

function isUnder(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Literal or symlink-resolved containment — both spaces deny. */
function matchedLiveRoot(target: string, liveRoots: string[]): string | undefined {
  const resolved = resolveExisting(target).resolved;
  return liveRoots.find(root => isUnder(target, root) || isUnder(resolved, root));
}

export function classifyPath(
  target: string,
  liveRoots: string[],
  disposableRoot: string,
): PathClassification {
  if (!isAbsolute(target)) {
    return { target, resolved: target, verdict: 'unmapped', reason: 'not an absolute path' };
  }
  const { resolved, resolvedAny } = resolveExisting(target);
  const live = matchedLiveRoot(target, liveRoots);
  if (live) {
    return {
      target, resolved, verdict: 'denied', matchedRoot: normalize(live),
      reason: resolved === normalize(target)
        ? 'directly inside a live root'
        : `resolves to ${resolved} inside a live root (symlink or alias)`,
    };
  }
  if (isUnder(resolved, disposableRoot) && isUnder(target, disposableRoot)) {
    return { target, resolved, verdict: 'allowed', reason: resolvedAny ? 'inside the disposable copy' : 'inside the disposable copy (not yet created)' };
  }
  return {
    target, resolved, verdict: 'unmapped',
    reason: resolvedAny
      ? `resolves to ${resolved}, outside the disposable root`
      : 'outside the disposable root and no existing ancestor to resolve',
  };
}

/**
 * Every configured writer target, classified. Sibling symlinks inside the copy
 * are walked so a planted link back to a live root is reported as a finding
 * instead of hiding behind the copy's own prefix.
 */
export function evaluateIsolation(targets: IsolationTargets, evidence: CapabilityEvidence = {}): IsolationReport {
  const disposableRoot = normalize(targets.disposableRoot);
  const liveRoots = targets.liveRoots.map(normalize);
  const findings: IsolationFinding[] = [];
  const classifications: PathClassification[] = [];

  const writers: Array<{ target: string; label: string }> = [];
  for (const source of targets.sources) {
    if (source.localPath) writers.push({ target: source.localPath, label: `sources.local_path[${source.id}]` });
    if (source.repoPath) writers.push({ target: source.repoPath, label: `sources.repo_path[${source.id}]` });
  }
  for (const file of targets.pageFiles ?? []) writers.push({ target: file, label: 'page file path' });
  for (const file of targets.extraWriters ?? []) writers.push({ target: file, label: 'writer target' });

  for (const { target, label } of writers) {
    const classified = classifyPath(target, liveRoots, disposableRoot);
    classifications.push(classified);
    if (classified.verdict === 'denied') {
      findings.push({
        code: 'writer_on_live_root', target, matchedRoot: classified.matchedRoot,
        detail: `${label} points into the live brain (${classified.reason})`,
      } as IsolationFinding);
    } else if (classified.verdict === 'unmapped') {
      // Writers may not be silent: an unmapped writer is a hole, not a default.
      findings.push({ code: 'writer_outside_disposable', target, detail: `${label}: ${classified.reason}` });
    }
  }

  for (const [field, value] of [['home', targets.home], ['tmpDir', targets.tmpDir]] as const) {
    if (!value) continue;
    const classified = classifyPath(value, liveRoots, disposableRoot);
    classifications.push(classified);
    if (classified.verdict !== 'allowed') {
      findings.push({
        code: field === 'home' ? 'home_outside' : 'tmpdir_outside', target: value,
        detail: `${field} ${classified.reason}`,
      });
    }
  }

  for (const liveDb of targets.liveDbUrls ?? []) {
    if (targets.dbUrl === liveDb || targets.dbUrl.includes(liveDb.replace(/^postgres(ql)?:\/\//, ''))) {
      findings.push({ code: 'live_db_url', target: targets.dbUrl, detail: 'rehearsal DB connection is a live/production connection string' });
    }
  }

  const scan = scanCopySymlinks(disposableRoot);
  for (const escape of scan.escaping) {
    findings.push({ code: 'copy_symlinks_live_root', target: escape, detail: `copy member ${escape} escapes the disposable root` });
  }
  if (scan.truncated) {
    findings.push({
      code: 'copy_scan_truncated', target: disposableRoot,
      detail: `copy symlink scan stopped after ${scan.scanned} entries: absence of escaping links is not proven`,
    });
  }

  const sandboxExercised = evidence.writeDeniedOnLiveRoot === true
    && evidence.writeAllowedOnDisposable === true
    && evidence.liveRootInaccessibleInsideUnit === true;
  if (!sandboxExercised) {
    findings.push({
      code: 'sandbox_unverified', target: evidence.probePath ?? 'rehearsal write-denial probe',
      detail: 'OS-level write denial was not exercised: configured isolation is unproven',
    });
  }

  const breached = findings.some(f => f.code !== 'sandbox_unverified');
  const paths: IsolationReport['paths'] = breached ? 'breached' : 'complete';
  const sandbox: IsolationReport['sandbox'] = sandboxExercised ? 'exercised' : 'unverified';
  return {
    verdict: breached ? 'breached' : sandboxExercised ? 'isolated' : 'unverified',
    paths, sandbox, disposableRoot, deniedRoots: liveRoots, classifications, findings,
    directives: sandboxDirectives(targets),
  };
}

/**
 * systemd transient-unit directives that make the live roots unreachable and
 * everything else read-only except the disposable paths. Bounded and explicit:
 * no wildcard exemptions, no safe.directory escape hatch.
 */
export function sandboxDirectives(targets: IsolationTargets): string[] {
  const disposable = normalize(targets.disposableRoot);
  const writable = [...new Set([disposable, normalize(targets.home), targets.tmpDir ? normalize(targets.tmpDir) : disposable])]
    .filter(p => isUnder(p, disposable));
  const denied = [...new Set([...targets.liveRoots.map(normalize), ...targets.liveRoots.map(r => resolveExisting(r).resolved)])];
  return [
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    'NoNewPrivileges=yes',
    `ReadWritePaths=${writable.join(' ')}`,
    `InaccessiblePaths=${denied.join(' ')}`,
  ];
}

/** `sources.local_path` and friends, remapped from a live root into its copy. */
export function remapPath(livePath: string, copyMap: Array<{ live: string; copy: string }>): string {
  const entry = copyMap.find(({ live }) => isUnder(livePath, live));
  if (!entry) throw new Error(`cannot remap ${livePath}: not under any live root`);
  return normalize(join(normalize(entry.copy), relative(normalize(entry.live), normalize(livePath))));
}

/**
 * A disposable COPY is only a copy if it contains no trapdoors: a symlink
 * anywhere inside it that resolves outside it (back into a live root) silently
 * turns a sandboxed write into a live write. Bounded walk; truncation is
 * reported, never ignored.
 */
export function scanCopySymlinks(disposableRoot: string, maxEntries = 50_000): { escaping: string[]; scanned: number; truncated: boolean } {
  const root = normalize(disposableRoot);
  const escaping: string[] = [];
  let scanned = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      if (++scanned > maxEntries) { truncated = true; break; }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(path); } catch { escaping.push(`${path} -> <unresolvable>`); continue; }
        if (!isUnder(target, root)) escaping.push(`${path} -> ${target}`);
      } else if (entry.isDirectory()) {
        stack.push(path);
      }
    }
    if (truncated) break;
  }
  return { escaping, scanned, truncated };
}

export interface ObservedConfig {
  sources?: Record<string, { localPath?: string | null; repoPath?: string | null }>;
  home?: string;
  tmpDir?: string;
  dbUrl?: string;
  pageFiles?: string[];
}

/**
 * Remapping completeness: every live value the rehearsal still observes must
 * equal its remapped counterpart. Any live value that survived the copy
 * construction is named individually; nothing is summarized away.
 */
export function auditRemap(
  targets: IsolationTargets,
  observed: ObservedConfig,
): { complete: boolean; unremapped: Array<{ field: string; value: string; expected: string }> } {
  const unremapped: Array<{ field: string; value: string; expected: string }> = [];
  const copyMap = targets.copyMap ?? targets.liveRoots.map(live => ({ live, copy: targets.disposableRoot }));
  const expect = (field: string, value: string | null | undefined, live: string | null | undefined, fallback: string) => {
    if (!value) return;
    const expected = live && matchedLiveRoot(live, targets.liveRoots)
      ? remapPath(live, copyMap)
      : fallback;
    if (normalize(value) !== normalize(expected)) unremapped.push({ field, value, expected });
  };
  for (const source of targets.sources) {
    const seen = observed.sources?.[source.id];
    const live = targets.liveSourceValues?.[source.id];
    expect(`sources.local_path[${source.id}]`, seen?.localPath, live?.localPath, source.localPath ?? '<disposable copy>');
    expect(`sources.repo_path[${source.id}]`, seen?.repoPath, live?.repoPath, source.repoPath ?? '<disposable copy>');
  }
  for (const [field, value] of [['home', observed.home], ['tmpDir', observed.tmpDir]] as const) {
    const expected = field === 'home' ? targets.home : (targets.tmpDir ?? targets.home);
    if (value && normalize(value) !== normalize(expected)) unremapped.push({ field, value, expected });
  }
  if (observed.dbUrl && (targets.liveDbUrls ?? []).some(live => observed.dbUrl === live)) {
    unremapped.push({ field: 'dbUrl', value: observed.dbUrl, expected: targets.dbUrl });
  }
  for (const file of observed.pageFiles ?? []) {
    if (matchedLiveRoot(file, targets.liveRoots)) unremapped.push({ field: 'page_file', value: file, expected: '<disposable copy>' });
  }
  return { complete: unremapped.length === 0, unremapped };
}

export interface PreservationManifest {
  files: Array<{ path: string; sha256: string; size: number }>;
  digest: string;
}

/** Content-preservation manifest: byte identity of every live file, not counts. */
export function preservationManifest(paths: string[]): PreservationManifest {
  const files = [...paths].sort().map(path => {
    const bytes = readFileSync(path);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  });
  const digest = createHash('sha256').update(files.map(f => `${f.path}\0${f.sha256}\0${f.size}`).join('\n')).digest('hex');
  return { files, digest };
}

export function manifestsEqual(a: PreservationManifest, b: PreservationManifest): { equal: boolean; changed: string[] } {
  const before = new Map(a.files.map(f => [f.path, f]));
  const changed = b.files.filter(f => before.get(f.path)?.sha256 !== f.sha256).map(f => f.path);
  for (const f of a.files) if (!b.files.some(g => g.path === f.path)) changed.push(f.path);
  return { equal: changed.length === 0 && a.files.length === b.files.length, changed };
}

// ── CLI ─────────────────────────────────────────────────────
// `bun scripts/rehearsal-isolation-gate.ts plan --targets <json> [--out <json>]`
// prints the verdict + directives. Reading a targets file keeps the rehearsal
// harness (a shell script) free of path logic.

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const targetsFile = flag('--targets');
  if (!targetsFile || args[0] !== 'plan') {
    console.error('usage: rehearsal-isolation-gate.ts plan --targets <targets.json> [--evidence <evidence.json>] [--out <report.json>]');
    process.exit(2);
  }
  const targets = readJson<IsolationTargets>(targetsFile);
  const evidenceFile = flag('--evidence');
  const evidence = evidenceFile ? readJson<CapabilityEvidence>(evidenceFile) : {};
  const report = evaluateIsolation(targets, evidence);
  const out = flag('--out');
  const text = JSON.stringify(report, null, 2);
  if (out) await Bun.write(out, text + '\n');
  process.stdout.write(text + '\n');
  // Fail closed: anything other than proven isolation blocks the rehearsal.
  process.exit(report.verdict === 'isolated' ? 0 : 1);
}
