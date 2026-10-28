/**
 * #6259 receipt durability: `gbrain quarantine clear --force` must stamp a
 * compact instruction-review proof into its terminal outcome, because normal
 * journal compaction discards the intent (the full document). After compaction
 * the same unchanged page must still publish cleared, and any edit must re-arm
 * the gate. This exercises the real producer, the real compactor, and the real
 * recovery path on a managed brain — no hand-written journal rows.
 *
 * Named `.serial.test.ts`: captures console output and sets process env.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runQuarantine } from '../src/commands/quarantine.ts';
import { isQuarantined } from '../src/core/quarantine.ts';
import { QUARANTINE_OVERRIDE_KEY } from '../src/core/quarantine-override.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const JUNK = 'Our scraper analysis: the headless browser stopped at a page that said "Cloudflare Ray ID: 8f2a" before any article text.';
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${body}\n`;
const SLUG = 'notes/compaction-durability';

let engine: BrainEngine;
let close: () => Promise<void>;
let home: string;
let root: string;

class Exited extends Error { constructor(readonly code: number | undefined) { super(`process.exit(${code})`); } }
async function capture(fn: () => Promise<void>): Promise<{ out: string; exit?: number }> {
  const [log, exit] = [console.log, process.exit];
  const out: string[] = [];
  let code: number | undefined;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  process.exit = ((c?: number) => { throw new Exited(c); }) as typeof process.exit;
  try { await fn(); } catch (e) { if (!(e instanceof Exited)) throw e; code = e.code; } finally { console.log = log; process.exit = exit; }
  return { out: out.join('\n'), ...(code === undefined ? {} : { exit: code }) };
}
const ctx = () => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
  deferEmbeds: true, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
const managedPut = async (content: string) => {
  const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  return submitPageMutation(ctx(), { operation: 'put_page', params: { slug: SLUG, content, request_id: randomUUID(), ...(snapshot ? { expected_revision: snapshot.revision } : {}) } });
};
const frontmatter = async () => (await engine.getPage(SLUG, { sourceId: 'default' }))?.frontmatter as Record<string, unknown>;
const run = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);

beforeAll(async () => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-instruction-review-compact-')));
  ({ engine, close } = await isolatedSharedSkillsEngine());
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); });
  await close(); rmSync(home, { recursive: true, force: true });
});

describe('a compact review proof outlives journal compaction (#6259)', () => {
  test('a managed clear stamps the proof into its terminal outcome', () => run(async () => {
    root = join(home, 'content'); mkdirSync(root);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root, localHostId());
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    _resetCliExitVerdictForTests();
    await managedPut(page('Compaction durability', JUNK));
    expect(isQuarantined(await frontmatter())).toBe(true);
    const { out } = await capture(() => runQuarantine(engine, ['clear', SLUG, '--force']));
    expect(out).toContain('Cleared');
    expect(isQuarantined(await frontmatter())).toBe(false);

    const [row] = await engine.executeRaw<{ compacted: boolean; intent: string | null; review: Record<string, unknown> | null }>(
      `SELECT compacted, intent::text AS intent, outcome->'instruction_review' AS review
         FROM persistence_requests WHERE slug=$1 AND operation='put_page' AND state='committed'
        ORDER BY created_at DESC LIMIT 1`, [SLUG]);
    expect(row?.compacted).toBe(false);
    expect(typeof row?.intent).toBe('string');
    expect(row?.review).toMatchObject({ schema_version: 1, content_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(row?.review?.marker).toMatchObject({ binding: expect.stringMatching(/^[0-9a-f]{64}$/),
      write_gate_detector_version: expect.any(Number) });
  }), 120_000);

  test('the real compactor drops the intent but keeps the proof, and the unchanged page stays cleared', () => run(async () => {
    // Compaction only touches receipts whose effects finished; wait for the
    // consumer to drain exactly as it does before the retention window elapses.
    const [id] = await engine.executeRaw<{ id: string }>(
      `SELECT id::text AS id FROM persistence_requests WHERE slug=$1 AND operation='put_page'
        ORDER BY created_at DESC LIMIT 1`, [SLUG]);
    for (let i = 0; i < 100; i++) {
      const [{ n }] = await engine.executeRaw<{ n: number }>(
        "SELECT count(*)::int AS n FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed'", [id!.id]);
      if (n === 0) break;
      await Bun.sleep(50);
    }
    const compacted = await compactWriteReceipts(engine, 0);
    expect(compacted).toBeGreaterThan(0);
    const [row] = await engine.executeRaw<{ compacted: boolean; intent: string | null; review: Record<string, unknown> | null }>(
      `SELECT compacted, intent::text AS intent, outcome->'instruction_review' AS review
         FROM persistence_requests WHERE id=$1::uuid`, [id!.id]);
    expect(row?.compacted).toBe(true);
    expect(row?.intent).toBeNull();
    expect(row?.review?.content_digest).toBeString();

    // Re-submitting the canonical file is what every later source sync does.
    await managedPut(readFileSync(join(root, `${SLUG}.md`), 'utf8'));
    expect(isQuarantined(await frontmatter())).toBe(false);
  }), 120_000);

  test('after compaction an edited body re-arms the gate instead of reusing the proof', () => run(async () => {
    const file = readFileSync(join(root, `${SLUG}.md`), 'utf8');
    await managedPut(file.replace(JUNK, `${JUNK} A new sentence changes the reviewed content.`));
    const fm = await frontmatter();
    expect(isQuarantined(fm)).toBe(true);
    expect(fm[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();
  }), 120_000);
});
