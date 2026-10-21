/**
 * An explicitly external source default (`sources set-trust <id> external_untrusted`)
 * is evidenced provenance for legacy rows (#5575: A8, CEO-17).
 *
 * Protects: rows written before trust tiers in a source whose config says
 * `trust_tier: external_untrusted` are classified external_untrusted by
 * `gbrain trust backfill` (pages and the facts, takes and timeline entries that
 * inherit or belong to that source), with the native `write_origin.channel`
 * `trust_backfill` receipt, while row content is untouched and a repeat run is
 * idempotent; a source the owner declared at `operator_curated` keeps its old
 * behavior (a backfill alone never lifts its rows); tiers a row already carries
 * (agent_written, user_confirmed) are preserved; the claim preview projects
 * zero operator_curated for the external source, `listClaimSources` marks it
 * nonclaimable with the `external_default` blocker, `recordSourceClaims` and
 * the CLI refuse it instead of overwriting the explicit default, and the
 * declared-own source still claims and lifts as before.
 *
 * Fixture pages carry a null `source_kind`, null stamps (`write_origin`,
 * `content_hash`, `import_filename`) and frontmatter with no clipper marker, so
 * the source default is the only classifying signal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runTrustBackfill } from '../src/core/trust/backfill.ts';
import { liftClaimedSources, listClaimSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { TRUST_CLAIMED_AT_KEY } from '../src/core/trust/claim-state.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { runTrustClaimSources } from '../src/commands/trust-claim.ts';
import { run as runTrustCli } from '../src/cli/commands/trust.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../src/core/write-gate-schema.ts';

let engine: BrainEngine;
beforeAll(async () => {
  const pg = new PGLiteEngine(); await pg.connect({}); await pg.initSchema();
  engine = pg;
  // Everything seeded here stands in for content from before trust tiers.
  await engine.executeRaw('UPDATE config SET value = $2 WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY,
    JSON.stringify({ detector_version: 0, until: { pages: 1e12, facts: 1e12, takes: 1e12, timeline_entries: 1e12 } })]);
}, 180_000);
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { __setConfirmationIoForTests(null); process.exitCode = 0; });

function tty(answer: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  __setConfirmationIoForTests({ probe: { stdinIsTTY: true, stdoutIsTTY: true, env: { GBRAIN_INTERACTIVE: '1' } }, input, output, timeoutMs: 2000 });
  input.write(`${answer}\n`);
}
async function runCli(args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const write = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { await runTrustClaimSources(engine, args); } finally { console.log = log; process.stderr.write = write; }
  return { out: out.join('\n'), err: err.join('') };
}

const configOf = async (id: string) => {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  return (typeof row!.config === 'string' ? JSON.parse(row!.config) : row!.config) as Record<string, unknown>;
};
const tierOf = async (table: string, id: number) =>
  (await engine.executeRaw<{ t: string; o: unknown }>(`SELECT trust_tier AS t, write_origin AS o FROM ${table} WHERE id=$1`, [id]))[0]!;

/**
 * The Readwise-shaped fixture: an external-by-default mirror with legacy
 * `unknown` rows and no clipper/ingest frontmatter, a page already classified
 * at two higher tiers, and a declared-own source that must keep its old
 * behavior.
 */
async function seed() {
  const tag = randomUUID().slice(0, 8);
  const external = `rw-${tag}`, own = `own-${tag}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/mirror/readwise',$2::text::jsonb)`,
    [external, JSON.stringify({ trust_tier: 'external_untrusted' })]);
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,$2::text::jsonb)`,
    [own, JSON.stringify({ trust_tier: 'operator_curated', remote_url: 'https://example.com/notes.git' })]);
  const pages: Record<string, number> = {};
  const page = async (key: string, source: string) => {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,source_kind,frontmatter,
        write_origin,content_hash,import_filename)
      VALUES($1,'note','Highlights','Clipped-looking text but no clipper marker.',$2,NULL,'{}'::jsonb,NULL,NULL,NULL) RETURNING id`,
    [`p/${key}`, source]);
    pages[key] = Number(row!.id);
  };
  await page('a', external);
  await page('b', external);
  await page('known', external);
  await page('confirmed', external);
  await page('own-plain', own);
  // Previously classified rows keep their tier: written as a backfill/copy would (the trigger clamps plain SQL).
  await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.executeRaw(`UPDATE pages SET trust_tier='agent_written' WHERE id=$1`, [pages.known]);
    await tx.executeRaw(`UPDATE pages SET trust_tier='user_confirmed' WHERE id=$1`, [pages.confirmed]);
  });
  const facts: Record<string, number> = {};
  const fact = async (key: string, sourceId: string, fenced: string | null) => {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,source_markdown_slug,row_num)
      VALUES($1,'e',$2,'fact','manual',$3,$4) RETURNING id`, [sourceId, `highlight ${key}`, fenced, fenced ? 1 : null]);
    facts[key] = Number(row!.id);
  };
  await fact('direct', external, null);
  await fact('fenced', external, 'p/a');
  const [take] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight)
    VALUES($1,1,'A highlight','take','world',0.5) RETURNING id`, [pages.a]);
  const [entry] = await engine.executeRaw<{ id: number }>(`INSERT INTO timeline_entries(page_id,date,summary,detail)
    VALUES($1,'2026-01-01','Imported highlight','Imported highlight body') RETURNING id`, [pages.b]);
  return { external, own, pages, facts, take: Number(take!.id), entry: Number(entry!.id) };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

/** Content and stamps a backfill must not touch, per source. */
const contentOf = async (s: Fixture) => JSON.stringify({
  pages: await engine.executeRaw(`SELECT id, slug, type, title, compiled_truth, frontmatter, source_kind, content_hash, import_filename
    FROM pages WHERE source_id = ANY($1::text[]) ORDER BY id`, [[s.external, s.own]]),
  facts: await engine.executeRaw(`SELECT id, source_id, fact, kind, source, source_markdown_slug FROM facts WHERE source_id = ANY($1::text[]) ORDER BY id`, [[s.external, s.own]]),
  takes: await engine.executeRaw(`SELECT id, page_id, claim, kind, holder, weight FROM takes WHERE id=$1`, [s.take]),
  entries: await engine.executeRaw(`SELECT id, page_id, date, summary FROM timeline_entries WHERE id=$1`, [s.entry]),
});
const storedTrust = async (s: Fixture) => JSON.stringify({
  pages: await engine.executeRaw(`SELECT id, trust_tier, write_origin FROM pages WHERE source_id = ANY($1::text[]) ORDER BY id`, [[s.external, s.own]]),
  facts: await engine.executeRaw(`SELECT id, trust_tier, write_origin FROM facts WHERE source_id = ANY($1::text[]) ORDER BY id`, [[s.external, s.own]]),
  takes: await engine.executeRaw(`SELECT id, trust_tier, write_origin FROM takes WHERE id=$1`, [s.take]),
  entries: await engine.executeRaw(`SELECT id, trust_tier, write_origin FROM timeline_entries WHERE id=$1`, [s.entry]),
});

describe('an explicit external_untrusted source default', () => {
  test('classifies its legacy rows external with native receipts, preserves content and known tiers, and repeats idempotently', async () => {
    const s = await seed();
    const content = await contentOf(s);

    // Claim preview: the explicit default keeps the projection external and the source nonclaimable.
    const listing = await listClaimSources(engine);
    const external = listing.sources.find(x => x.id === s.external)!;
    expect(external).toMatchObject({ claimable: false, blocker: 'external_default', claimed: false });
    expect(external.projected_if_claimed.operator_curated).toBe(0);
    expect(external.projected_if_claimed.external_untrusted).toBe(6);
    // The two rows already classified keep their stored tiers through the projection.
    expect(external.projected_if_claimed).toMatchObject({ user_confirmed: 1, agent_written: 1 });
    expect(external.projected_if_claimed.operator_curated).toBe(0);
    const own = listing.sources.find(x => x.id === s.own)!;
    expect(own).toMatchObject({ claimable: true, claimed: false });
    expect(own.projected_if_claimed.operator_curated).toBe(1);

    // A claim refuses rather than overwriting the declaration.
    await expect(recordSourceClaims(engine, [s.external])).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(recordSourceClaims(engine, [s.external])).rejects.toThrow(/external, untrusted/);
    const untouched = await configOf(s.external);
    expect(untouched).toEqual({ trust_tier: 'external_untrusted' });
    expect(untouched[TRUST_CLAIMED_AT_KEY]).toBeUndefined();

    // Dry run is read-only and names the new signal.
    const preview = await runTrustBackfill(engine, { dryRun: true });
    expect(preview.signals).toContain('source_trust_default');
    expect(preview.projected.operator_curated).toBe(0);
    // The only user_confirmed row is the one already classified that way: nothing new is confirmed.
    expect(preview.projected.user_confirmed).toBe(1);
    expect(await contentOf(s)).toBe(content);
    expect((await tierOf('pages', s.pages.a!)).t).toBe('unknown');

    const applied = await runTrustBackfill(engine, { log: () => {} });
    expect(applied.mode).toBe('apply');
    for (const table of ['pages', 'facts', 'takes', 'timeline_entries']) {
      expect({ table, updated: applied.tables.find(t => t.table === table)!.updated }).toEqual({ table, updated: expect.any(Number) });
    }

    const pageA = await tierOf('pages', s.pages.a!);
    expect(pageA.t).toBe('external_untrusted');
    expect(pageA.o).toEqual({ channel: 'trust_backfill' });
    expect((await tierOf('pages', s.pages.b!)).t).toBe('external_untrusted');
    expect((await tierOf('pages', s.pages.known!)).t).toBe('agent_written');
    expect((await tierOf('pages', s.pages.confirmed!)).t).toBe('user_confirmed');
    expect((await tierOf('facts', s.facts.direct)).t).toBe('external_untrusted');
    expect((await tierOf('facts', s.facts.fenced)).t).toBe('external_untrusted');
    expect((await tierOf('facts', s.facts.fenced)).o).toEqual({ channel: 'trust_backfill' });
    expect((await tierOf('takes', s.take)).t).toBe('external_untrusted');
    expect((await tierOf('timeline_entries', s.entry)).t).toBe('external_untrusted');
    // A declared-own default is no signal: without a claim its legacy row stays unknown.
    expect((await tierOf('pages', s.pages['own-plain']!)).t).toBe('unknown');
    expect(await contentOf(s)).toBe(content);

    // Idempotent: a repeat run moves nothing and leaves tiers, receipts and content as they were.
    const after = await storedTrust(s);
    const again = await runTrustBackfill(engine, { log: () => {} });
    for (const t of again.tables) expect({ table: t.table, updated: t.updated ?? 0 }).toEqual({ table: t.table, updated: 0 });
    expect(await storedTrust(s)).toBe(after);
    expect(await contentOf(s)).toBe(content);
  }, 120_000);

  test('the CLI refuses the external source at a TTY instead of overwriting the default', async () => {
    const s = await seed();
    tty(s.external);
    const { err } = await runCli(['--source', s.external]);
    expect(err).toContain('invalid_params');
    expect(err).toContain('external, untrusted');
    expect(err).toContain(`gbrain sources set-trust ${s.external} operator_curated`);
    expect(await configOf(s.external)).toEqual({ trust_tier: 'external_untrusted' });
    expect((await tierOf('pages', s.pages.a!)).t).toBe('unknown');
    const { out } = await runCli(['--dry-run']);
    expect(out).toContain('explicitly "external, untrusted" by default: cannot be claimed');
  }, 120_000);

  test('a declared-own source still claims and lifts its legacy rows as before', async () => {
    const s = await seed();
    await recordSourceClaims(engine, [s.own]);
    expect((await configOf(s.own)).trust_tier).toBe('operator_curated');
    expect(typeof (await configOf(s.own))[TRUST_CLAIMED_AT_KEY]).toBe('string');
    const lift = await liftClaimedSources(engine);
    expect(lift.sources.map(x => x.id)).toEqual([s.own]);
    const page = await tierOf('pages', s.pages['own-plain']!);
    expect(page.t).toBe('operator_curated');
    expect(page.o).toEqual({ channel: 'trust_claim' });
    // The external source's rows keep their own default while the own claim runs.
    expect((await tierOf('pages', s.pages.a!)).t).toBe('unknown');
  }, 120_000);
  test('CLI source scope classifies only that source with backfill, not claim, receipts', async () => {
    const s = await seed();
    const content = await contentOf(s);
    const log = console.log;
    console.log = () => {};
    try { await runTrustCli(engine, ['backfill', '--source', s.external], {} as never); }
    finally { console.log = log; }
    expect((await tierOf('pages', s.pages.a!)).t).toBe('external_untrusted');
    expect((await tierOf('pages', s.pages.a!)).o).toEqual({ channel: 'trust_backfill' });
    expect((await tierOf('pages', s.pages['own-plain']!)).t).toBe('unknown');
    expect((await configOf(s.external))[TRUST_CLAIMED_AT_KEY]).toBeUndefined();
    expect(await contentOf(s)).toBe(content);
  });
});
