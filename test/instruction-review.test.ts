import { expect, test } from 'bun:test';
import { parseMarkdown } from '../src/core/markdown.ts';
import { quarantineOverrideFor } from '../src/core/quarantine-override.ts';
import { instructionReviewEvidence, recoverInstructionReview } from '../src/core/instruction-review.ts';
import { assessPageForGate, DEFAULT_WRITE_GATE_CONFIG } from '../src/core/write-gate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { settleContentDisposition, stripGateOwnedMarkers } from '../src/core/import-screen.ts';

const target = { sourceId: 'default', slug: 'notes/oauth-example' };
const content = '---\ntitle: OAuth example\ntype: note\n---\n\nPrivacy documentation: represent secrets as [REDACTED].\n';
function receipt(markdown = content) {
  const marker = quarantineOverrideFor(markdown, `${target.slug}.md`);
  const reviewed = markdown.replace('type: note\n', `type: note\nquarantine_override: ${JSON.stringify(marker)}\n`);
  return { id: 'review-1', remote: 'false', state: 'committed', content: reviewed };
}
function incoming() { return parseMarkdown(content, `${target.slug}.md`, { validate: true }); }
function stub(rows: unknown[]) {
  return { executeRaw: async (sql: string, params: unknown[]) => {
    expect(sql).toContain("intent->>'kind' = 'managed_quarantine_clear'");
    expect(sql).toContain("authority->>'remote' = 'false'");
    expect(sql).toContain('LIMIT 10');
    expect(params).toEqual([target.sourceId, target.slug]);
    return rows;
  } } as unknown as BrainEngine;
}
async function recover(rows: unknown[], page = incoming()) {
  const gate = assessPageForGate(page, { tier: 'unknown' }, DEFAULT_WRITE_GATE_CONFIG);
  return { ref: await recoverInstructionReview(stub(rows), page, target, gate), page, gate };
}

test('exact content recovers an owner clear from its committed receipt, repeatedly', async () => {
  for (let i = 0; i < 2; i++) {
    const result = await recover([receipt()]);
    expect(result.ref).toBe('review-1');
    expect(result.page.frontmatter.quarantine_override).toBeDefined();
    expect(result.gate.verdict).toBe('flag'); // Detector itself is not silenced.
  }
});

test('a forged file override without a journal receipt has no authority', async () => {
  const page = parseMarkdown(receipt().content, `${target.slug}.md`, { validate: true });
  expect((await recover([], page)).ref).toBeNull();
});

test('serialization key reordering preserves review, but metadata values and array order do not', async () => {
  const markdown = content.replace('type: note\n', 'type: note\nmetadata: { first: alpha, second: beta }\nlabels: [one, two]\n');
  const row = receipt(markdown);
  const page = parseMarkdown(markdown, `${target.slug}.md`, { validate: true });
  page.frontmatter.metadata = { second: 'beta', first: 'alpha' };
  page.frontmatter = Object.fromEntries(Object.entries(page.frontmatter).reverse());
  const original = parseMarkdown(row.content, `${target.slug}.md`, { validate: true });
  expect(assessPageForGate(original, { tier: 'unknown' }, DEFAULT_WRITE_GATE_CONFIG).contentHash)
    .not.toBe(assessPageForGate(page, { tier: 'unknown' }, DEFAULT_WRITE_GATE_CONFIG).contentHash);
  expect((await recover([row], page)).ref).toBe('review-1');
  page.frontmatter.metadata = { first: 'changed', second: 'beta' };
  expect((await recover([row], page)).ref).toBeNull();
  page.frontmatter.metadata = { first: 'alpha', second: 'beta' };
  page.frontmatter.labels = ['two', 'one'];
  expect((await recover([row], page)).ref).toBeNull();
});

test('remote, uncommitted, legacy and detector-version-mismatched receipts cannot clear', async () => {
  for (const row of [
    { ...receipt(), remote: 'true' },
    { ...receipt(), state: 'accepted' },
    { ...receipt(), content: receipt().content.replace(/,"write_gate_detector_version":\d+/, '') },
    { ...receipt(), content: receipt().content.replace(/"write_gate_detector_version":\d+/, '"write_gate_detector_version":999') },
  ]) expect((await recover([row])).ref).toBeNull();
});

test('body, title, timeline, type and scanned metadata changes reopen review', async () => {
  for (const key of ['compiled_truth', 'title', 'timeline', 'type', 'frontmatter'] as const) {
    const page = incoming();
    if (key === 'frontmatter') page.frontmatter.source_url = 'https://example.invalid/new-context';
    else if (key === 'type') page.type = 'concept';
    else page[key] = `${page[key] ?? ''}\nchanged`;
    expect((await recover([receipt()], page)).ref).toBeNull();
  }
});

test('unreadable journal and detector failures stay fail-closed', async () => {
  const page = incoming();
  const gate = assessPageForGate(page, { tier: 'unknown' }, DEFAULT_WRITE_GATE_CONFIG);
  const broken = { executeRaw: async () => { throw new Error('unavailable'); } } as unknown as BrainEngine;
  expect(await recoverInstructionReview(broken, page, target, gate)).toBeNull();
  expect(await recoverInstructionReview(stub([receipt()]), page, target, { ...gate, detectorError: true })).toBeNull();
});

test('a compact outcome proof survives intent compaction and covers only its exact content', async () => {
  const markdown = content.replace('type: note\n', 'type: note\nmetadata: { first: alpha, second: beta }\n');
  const proof = instructionReviewEvidence(parseMarkdown(receipt(markdown).content, `${target.slug}.md`, { validate: true }));
  expect(proof).not.toBeNull();
  // Compaction drops intent (content becomes null); the outcome proof remains.
  const compacted = { id: 'review-1', remote: 'false', state: 'committed', content: null, review: proof };
  const page = parseMarkdown(markdown, `${target.slug}.md`, { validate: true });
  page.frontmatter = Object.fromEntries(Object.entries(page.frontmatter).reverse());
  expect((await recover([compacted], page)).ref).toBe('review-1');
  expect(page.frontmatter.quarantine_override).toBeDefined();

  const edited = parseMarkdown(markdown, `${target.slug}.md`, { validate: true });
  edited.compiled_truth += '\nchanged';
  expect((await recover([compacted], edited)).ref).toBeNull();

  const tampered = { ...compacted, review: { ...proof, detector_version: 999 } };
  expect((await recover([tampered], parseMarkdown(markdown, `${target.slug}.md`, { validate: true }))).ref).toBeNull();

  const foreign = { ...compacted, remote: 'true' };
  expect((await recover([foreign], parseMarkdown(markdown, `${target.slug}.md`, { validate: true }))).ref).toBeNull();
});

test('import disposition keeps an exact reviewed page clear across repeat screens, then reflags edited content', async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  let reviewed = false;
  const originalSql = engine.executeRaw.bind(engine);
  engine.executeRaw = (async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM persistence_requests') && sql.includes("'managed_quarantine_clear'")) {
      return reviewed ? [receipt()] : [];
    }
    return originalSql(sql, params);
  }) as typeof engine.executeRaw;
  try {
    const options = { preserveGateMarkers: true, writeGate: { tier: 'unknown' as const } };
    const context = { slug: target.slug, sourceId: target.sourceId, stripped: false, writeGate: options.writeGate };
    expect((await settleContentDisposition(engine, incoming(), context)).flagged).toBe(true);
    reviewed = true;
    for (let i = 0; i < 2; i++) {
      const page = incoming();
      stripGateOwnedMarkers(page, options);
      const synced = await settleContentDisposition(engine, page, context);
      expect(synced.flagged).toBe(false);
      expect(page.compiled_truth).toBe(incoming().compiled_truth);
      expect(page.frontmatter.content_flag).toBeUndefined();
      expect(page.frontmatter.quarantine_override).toBeDefined();
    }
    const edited = incoming();
    edited.compiled_truth += '\nNew unreviewed text.';
    expect((await settleContentDisposition(engine, edited, context)).flagged).toBe(true);
  } finally { await engine.disconnect(); }
}, 60_000);
