/**
 * Existing legacy rows stay updatable while the new-write grammar and pack
 * vocabulary are unchanged: `gbrain repair visibility` must stamp an atom
 * stored under a dot-led segment (which today's op slug grammar refuses) and
 * restamp a legacy `extract_receipt` page whose type the active pack no longer
 * declares. Only the exact existing row in the same source is admitted; new
 * dot-led slugs, other sources and replacement types stay refused.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { submitPageMutation, validateMutationSlug } from '../src/core/persistence/page-mutations.ts';
import { canonicalPutPageContent } from '../src/core/persistence/put-page-vocabulary.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { planVisibilityRepair, visibilityRepair } from '../src/core/repair/visibility.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const ATOM = 'atoms/2026-07-02/.env-silently-overrides-config.yaml-fix-both-or-it-wont-stic-c34a0e2b';
const NEW_ATOM = 'atoms/2026-07-03/.env-a-new-dot-led-segment-c34a0e2b';
const RECEIPT = 'extracts/2026-09-17/facts.conversation/default/ecf-mu5t/round-full';

const refusal = (run: Promise<unknown>) => run.then(() => 'ok', (error: { code?: string }) => error.code ?? 'error');
const mutate = (ctx: OperationContext, operation: string, params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } }) as Promise<Record<string, any>>;
const markdown = (slug: string, type: string, frontmatter: Record<string, unknown> = {}) =>
  serializeMarkdown({ ...frontmatter }, `${slug} body`, '', { type: type as never, title: slug, tags: [] });

/** Seeded before the managed writer activates: the storage primitives are coordinator-only afterwards. */
async function seedAtom({ engine }: { engine: Parameters<typeof planVisibilityRepair>[0] }) {
  await engine.putPage('notes/private-origin', { type: 'note', title: 'origin', compiled_truth: 'origin body', timeline: '', frontmatter: { visibility: 'private' } });
  await engine.putPage(ATOM, { type: 'atom', title: 'atom', compiled_truth: 'atom body', timeline: '',
    frontmatter: { visibility: 'world', source_slug: 'notes/private-origin' } });
}

describe('legacy existing-row updates (repair compatibility)', () => {
  test('repair visibility stamps a dot-led atom database-only, in place', async () => {
    await managedBrain(async ({ engine, ctx, root }) => {
      const plan = await planVisibilityRepair(engine, ['default']);
      const item = plan.changes.find(change => change.slug === ATOM);
      expect(item).toMatchObject({ from: 'world', to: 'private' });
      expect(await visibilityRepair.apply(ctx, { cursor: { phase: 0, id: item!.id }, source_id: 'default', slug: ATOM,
        chars: 0, action: 'visibility world -> private', change: { from: 'world', to: 'private' } })).toBe(true);
      const after = await engine.readPageSnapshot(ATOM, { sourceId: 'default', includeDeleted: true });
      expect(after?.page.frontmatter?.visibility).toBe('private');
      expect(after?.page.slug).toBe(ATOM);
      expect(after?.page.type).toBe('atom');
      expect(existsSync(join(root, `${ATOM}.md`))).toBe(false);
    }, { setup: seedAtom });
  }, 120_000);

  test('a new dot-led slug and edit_page stay refused', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      const revision = (await engine.readPageSnapshot(ATOM, { sourceId: 'default' }))!.revision;
      expect(await refusal(mutate(ctx, 'put_page', { slug: NEW_ATOM, content: markdown(NEW_ATOM, 'atom') }))).toBe('invalid_params');
      expect(await refusal(mutate(ctx, 'edit_page', { slug: ATOM, edits: [{ old: 'atom', new: 'stamped' }], expected_revision: revision }))).toBe('invalid_params');
    }, { setup: seedAtom });
  }, 120_000);

  test('the slug admission is existing-row, same-source and traversal-safe', async () => {
    const rows: Record<string, string[]> = { default: [ATOM], archive: [] };
    const ctx = { engine: { readPageSnapshot: async (slug: string, opts: { sourceId: string }) =>
      rows[opts.sourceId]?.includes(slug) ? { revision: 'r' } : null } } as unknown as OperationContext;
    await validateMutationSlug(ctx, 'put_page', ATOM, 'default');
    expect(await refusal(validateMutationSlug(ctx, 'put_page', ATOM, 'archive'))).toBe('invalid_params');
    expect(await refusal(validateMutationSlug(ctx, 'put_page', NEW_ATOM, 'default'))).toBe('invalid_params');
    expect(await refusal(validateMutationSlug(ctx, 'put_page', 'atoms/2026-07-02/../../.env-x-c34', 'default'))).toBe('invalid_params');
    expect(await refusal(validateMutationSlug(ctx, 'edit_page', ATOM, 'default'))).toBe('invalid_params');
  });

  test('a legacy stored type survives only the same page, unchanged', () => {
    const pack = { page_types: [{ name: 'note', aliases: [], path_prefixes: [] }, { name: 'atom', aliases: [], path_prefixes: [] }] } as never;
    expect(canonicalPutPageContent(markdown(RECEIPT, 'extract_receipt'), RECEIPT, pack, { storedType: 'extract_receipt' }))
      .toContain('type: extract_receipt');
    expect(() => canonicalPutPageContent(markdown(RECEIPT, 'extract_receipt'), RECEIPT, pack)).toThrow(/neither a declared canonical type/);
    expect(() => canonicalPutPageContent(markdown(RECEIPT, 'extract_receipt_v2'), RECEIPT, pack, { storedType: 'extract_receipt' }))
      .toThrow(/neither a declared canonical type/);
    expect(() => canonicalPutPageContent(markdown(NEW_ATOM, 'extract_receipt'), NEW_ATOM, pack, { storedType: null }))
      .toThrow(/neither a declared canonical type/);
  });
});
