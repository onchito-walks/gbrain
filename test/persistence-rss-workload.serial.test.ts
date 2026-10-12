import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReadLatencyWorkload } from '../scripts/persistence/read-workload.ts';
import { withEnv } from './helpers/with-env.ts';

// Preserve both original full public-write/read regressions and their 60s
// per-test bound. Run the serial lane with GBRAIN_SERIAL_POOL=1 on small hosts;
// unlike the fast unit accounting tests, these measure a real PGLite workload.
// Scoped RSS injection prevents one timed-out workload poisoning another test's
// process.memoryUsage global. All benchmark defaults and invariants are intact.
describe('read-load RSS integration', () => {
  test.each([false, true])('unavailable RSS stays explicit without invalidating real reads and writes (all=%s)', async all => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-read-rss-'));
    const original = process.memoryUsage;
    let calls = 0;
    const observeRss = () => {
      if (++calls === 1 || all) throw new Error('Failed to get memory usage');
      return original.call(process).rss;
    };
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const result = await runReadLatencyWorkload({ pages: 4, queries: 200, writers: 1, writesPerWriter: 100, observeRss });
        expect(process.memoryUsage).toBe(original);
        expect(result.ok).toBe(true);
        expect(result.phase_a.queries_run).toBe(200);
        expect(result.phase_b.queries_run).toBe(200);
        expect(result.phase_b.writes_completed).toBeGreaterThan(0);
        expect(result.phase_b.writes_failed).toBe(0);
        expect(result.phase_b.writes_committed_during_reads).toBeGreaterThan(0);
        expect(result.overlap_pct).toBeGreaterThanOrEqual(90);
        expect(result.rss_unavailable_samples).toBeGreaterThan(0);
        expect(result.metrics[0].rss_bytes).toBeNull();
        if (all) {
          expect(result.metrics.every((sample: { rss_bytes: number | null }) => sample.rss_bytes === null)).toBe(true);
          expect(result.peak_rss_bytes).toBeNull();
          expect(result.rss_unavailable_samples).toBe(result.metrics_retention.total);
        } else {
          expect(result.rss_unavailable_samples).toBe(1);
          expect(result.peak_rss_bytes).toBeGreaterThan(0);
        }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 60000);
});
