/**
 * Regression (B24): membership policy of scripts/run-serial-tests.sh under bad
 * scheduler output.
 *
 * The scheduler's only job in the UNSHARDED lane (1/1) is dispatch ORDER: with
 * one shard it must return an exact permutation of the discovered set. The
 * upstream failure mode is a truncated stdout tail delivered at exit 0
 * (gbrain#5669: 10,000 inputs, 8,187 lines returned, exit 0) — trusting that
 * output silently drops serial coverage with a green run.
 *
 * Pinned contract, exercised by running the REAL script in a sandbox with a
 * stubbed `bun scripts/sharding.ts`:
 *   1. unsharded + exact permutation          -> honoured, no warning;
 *   2. unsharded + missing / unexpected / duplicated entries -> the
 *      deterministic discovery order is used instead (no file skipped), with a
 *      loud warning, exit 0;
 *   3. sharded + scheduler failure            -> fails closed (never the whole
 *      corpus inside one shard);
 *   4. sharded + successful empty output      -> honoured as an empty shard.
 *
 * Non-serial on purpose: it spawns bash processes and carries no shared
 * file-wide state.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SERIAL_SH = resolve(REPO_ROOT, 'scripts/run-serial-tests.sh');
const FILES = ['test/alpha.serial.test.ts', 'test/beta.serial.test.ts', 'test/gamma.serial.test.ts'];

let SANDBOX = '';
let SHIM_DIR = '';

/** The stub scheduler replays the stdin file list according to
 *  $SHIM_SCHEDULER_MODE instead of partitioning it, so every malformed-output
 *  class is reachable without waiting for a real truncation. */
const BUN_SHIM = `#!/usr/bin/env bash
if [ "\${1:-}" != "scripts/sharding.ts" ]; then exit 0; fi
input=$(cat)
case "\${SHIM_SCHEDULER_MODE:-ok}" in
  ok) [ -n "$input" ] && printf '%s\\n' "$input" ;;
  truncated) [ -n "$input" ] && printf '%s\\n' "$input" | sed '$d' ;;
  unexpected) [ -n "$input" ] && printf '%s\\n%s\\n' "$input" "test/zzz-unexpected.serial.test.ts" ;;
  duplicate) [ -n "$input" ] && printf '%s\\n%s\\n' "$input" "$(printf '%s\\n' "$input" | sed -n 1p)" ;;
  empty) : ;;
  fail) printf 'error: scheduler exploded\\n' >&2; exit 2 ;;
esac
exit 0
`;

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'gbrain-serial-contract-'));
  mkdirSync(join(SANDBOX, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(SANDBOX, 'test'), { recursive: true });
  SHIM_DIR = join(SANDBOX, 'shim');
  mkdirSync(SHIM_DIR, { recursive: true });
  // The real script under test and the helper library it sources.
  cpSync(SERIAL_SH, join(SANDBOX, 'scripts', 'run-serial-tests.sh'));
  cpSync(resolve(REPO_ROOT, 'scripts/lib'), join(SANDBOX, 'scripts', 'lib'), { recursive: true });
  for (const f of FILES) writeFileSync(join(SANDBOX, f), "import { test } from 'bun:test';\n");
  writeFileSync(join(SHIM_DIR, 'bun'), BUN_SHIM);
  chmodSync(join(SHIM_DIR, 'bun'), 0o755);
});

function runSerial(env: Record<string, string> = {}) {
  return spawnSync('bash', [join(SANDBOX, 'scripts', 'run-serial-tests.sh'), '--dry-run-list'], {
    cwd: SANDBOX,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${SHIM_DIR}:${process.env.PATH ?? ''}`,
      SHARD: '',
      SHIM_SCHEDULER_MODE: 'ok',
      ...env,
    },
  });
}

const listed = (out: string | null): string[] =>
  (out ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

describe('serial runner scheduler-output contract', () => {
  it('honours an exact permutation of the discovered set', () => {
    const r = runSerial();
    expect(r.status).toBe(0);
    expect(listed(r.stdout)).toEqual([...FILES].sort());
    expect(r.stderr ?? '').not.toContain('WARNING');
  });

  it('falls back to the discovery order when the scheduler drops a file', () => {
    const r = runSerial({ SHIM_SCHEDULER_MODE: 'truncated' });
    expect(r.status).toBe(0);
    expect(listed(r.stdout)).toEqual([...FILES].sort());
    expect(r.stderr ?? '').toContain('WARNING');
    expect(r.stderr ?? '').toContain('not a permutation');
  });

  it('falls back to the discovery order on an unexpected entry', () => {
    const r = runSerial({ SHIM_SCHEDULER_MODE: 'unexpected' });
    expect(r.status).toBe(0);
    expect(listed(r.stdout)).toEqual([...FILES].sort());
    expect(r.stderr ?? '').toContain('unexpected 1');
  });

  it('falls back to the discovery order on a duplicated entry', () => {
    const r = runSerial({ SHIM_SCHEDULER_MODE: 'duplicate' });
    expect(r.status).toBe(0);
    expect(listed(r.stdout)).toEqual([...FILES].sort());
    expect(r.stderr ?? '').toContain('duplicate 1');
  });

  it('fails closed when the scheduler fails inside a shard', () => {
    const r = runSerial({ SHARD: '1/2', SHIM_SCHEDULER_MODE: 'fail' });
    expect(r.status).not.toBe(0);
    expect(r.stderr ?? '').toContain('ERROR');
    // The whole-corpus fallback is the hazard this guards: a shard must never
    // run the complete discovered set.
    expect(listed(r.stdout)).not.toEqual([...FILES].sort());
    expect(listed(r.stdout)).toEqual([]);
  });

  it('honours a successful empty shard', () => {
    const r = runSerial({ SHARD: '2/2', SHIM_SCHEDULER_MODE: 'empty' });
    expect(r.status).toBe(0);
    expect(listed(r.stdout)).toEqual([]);
    expect(r.stderr ?? '').not.toContain('ERROR');
  });
});
