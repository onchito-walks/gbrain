import { expect, test } from 'bun:test';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { planPreservedFencePublication, validatePreservedFencePublication,
  type OriginalRecord, type PreservedFenceInputs } from '../src/core/facts/preserved-fence-publication.ts';

function fact(overrides: OriginalRecord = {}): OriginalRecord {
  return { id: '7', source_id: 'default', entity_slug: 'people/example', fact: 'Original claim',
    kind: 'fact', visibility: 'private', notability: 'medium', context: 'Original context',
    valid_from: '2026-01-01T00:00:00.000Z', valid_until: null,
    source: 'mcp:remember', confidence: 1, claim_metric: null, claim_value: null,
    claim_unit: null, claim_period: null, row_num: null, source_markdown_slug: null,
    expired_at: null, dimension: null, source_session: 'original-session', created_at: '2026-01-01T00:00:00.000Z',
    embedding: '[0.25,0.5]', attributed_to: 'original-writer', ...overrides };
}
function cell(rowNum: number, claim: string): ParsedFact {
  return { rowNum, claim, active: true, kind: 'fact', visibility: 'private', notability: 'medium',
    confidence: 1, source: 'mcp:remember' };
}
function inputs(rows = [fact()], body = '# Original body\r\n\r\nLiteral original text.\r\n'): PreservedFenceInputs {
  const source = { id: 'default', local_path: '/fixture/source', incarnation: 'original-incarnation', archived: false };
  const page = { id: 12, source_id: 'default', slug: 'people/example', compiled_truth: body,
    timeline: '', frontmatter: { provenance: 'original', nested: { literal: '  keep\r\nthis  ' } }, deleted_at: null,
    source_path: 'people/example.md', content_hash: 'original-hash' };
  return { sourceId: 'default', entitySlug: 'people/example', source, page, facts: rows, body,
    columns: { source: Object.keys(source), page: Object.keys(page), facts: Object.keys(rows[0]!) },
    candidateIds: rows.filter(r => r.expired_at === null).map(r => String(r.id)) };
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value)) frozen(v); }
  return value;
}

test('NULL and every original byte/provenance value stay literal; positions exist only in derived bindings', () => {
  const input = frozen(inputs());
  const before = JSON.stringify(input);
  const p = planPreservedFencePublication(input);
  expect(p.bindings[0]).toMatchObject({ original_fact_id: '7', original_row_num: null, derived_row_num: 1 });
  expect(p.derived_body).not.toBe(input.body);
  expect(input.facts[0]!.row_num).toBeNull();
  expect(JSON.stringify(input)).toBe(before);
  validatePreservedFencePublication(p, input);
});

test('existing5 collision maps to derived9 without changing original5 or either original fence row', () => {
  const input = inputs([fact({ row_num: 5, source_markdown_slug: 'people/example' })],
    '# Original\n' + renderFactsTable([cell(5, 'Different page-authored claim'), cell(8, 'Last occupied row')]));
  const before = structuredClone(input);
  const p = planPreservedFencePublication(input);
  expect(p.bindings[0]).toMatchObject({ original_row_num: 5, derived_row_num: 9 });
  expect(parseFactsFence(p.derived_body).facts.find(f => f.rowNum === 5)?.claim).toBe('Different page-authored claim');
  expect(input).toEqual(before);
});

test('an unoccupied existing numbered position is mapped without any original-body edit', () => {
  const input = inputs([fact({ row_num: 5, source_markdown_slug: 'people/example' })]);
  expect(planPreservedFencePublication(input).bindings[0]).toMatchObject({ original_row_num: 5, derived_row_num: 5 });
  expect(input.body).toBe(input.page.compiled_truth as string);
});

test('already-paired candidates receive exact explicit bindings, not duplicate derived rows', () => {
  const input = inputs([fact({ row_num: 5, source_markdown_slug: 'people/example' })], renderFactsTable([cell(5, 'Original claim')]));
  const p = planPreservedFencePublication(input);
  expect(p.bindings).toHaveLength(1);
  expect(parseFactsFence(p.derived_body).facts).toHaveLength(1);
  expect(p.bindings[0]).toMatchObject({ original_row_num: 5, derived_row_num: 5 });
});

test('codec whitespace/CRLF text is explicitly derived; original claim remains byte-identical', () => {
  const input = inputs([fact({ fact: '  Original\r\nclaim  ' })]);
  const p = planPreservedFencePublication(input);
  expect(p.bindings[0]!.derived_claim).toBe('Original\nclaim');
  expect(input.facts[0]!.fact).toBe('  Original\r\nclaim  ');
});

test('same inputs replan identically and input enumeration order does not invent new identity', () => {
  const input = inputs([fact(), fact({ id: '8', fact: 'Another claim' })]);
  const p = planPreservedFencePublication(input);
  expect(planPreservedFencePublication(input)).toEqual(p);
  const reordered = structuredClone(input); reordered.facts.reverse(); reordered.candidateIds.reverse();
  expect(planPreservedFencePublication(reordered)).toEqual(p);
});

test('duplicate candidate claims refuse the whole plan rather than merging identities', () => {
  const input = inputs([fact(), fact({ id: '8' })]);
  const before = structuredClone(input);
  expect(() => planPreservedFencePublication(input)).toThrow('unadoptable_candidates:duplicate_claim');
  expect(input).toEqual(before);
});

test('ambiguous original positions refuse before Map could silently choose an owner', () => {
  const input = inputs([fact({ row_num: 5, source_markdown_slug: 'people/example' }),
    fact({ id: '8', fact: 'Another claim', row_num: 5, source_markdown_slug: 'people/example' })]);
  expect(() => planPreservedFencePublication(input)).toThrow('ambiguous_original_position');
});

test('duplicate original identity and duplicate candidate identity are separate refusals', () => {
  const input = inputs(); input.facts.push(structuredClone(input.facts[0]!));
  expect(() => planPreservedFencePublication(input)).toThrow('duplicate_original_identity');
  const other = inputs(); other.candidateIds.push('7');
  expect(() => planPreservedFencePublication(other)).toThrow('duplicate_candidate_identity');
});

test('unrenderable original claims stay literal on refusal, never partially published', () => {
  for (const claim of ['~~struck~~', 'literal<br>markup', '   ']) {
    const input = inputs([fact({ fact: claim })]);
    expect(() => planPreservedFencePublication(input)).toThrow('unadoptable_candidates:');
    expect(input.facts[0]!.fact).toBe(claim);
  }
});

test('original claim, positions, provenance and even unlisted original columns each invalidate the publication', () => {
  const input = inputs(), p = planPreservedFencePublication(input);
  for (const [key, value] of Object.entries({ fact: 'Changed', row_num: 4, source_session: 'changed-session',
    created_at: '2026-02-01T00:00:00.000Z', embedding: '[0.5,0.25]', attributed_to: 'changed-writer' })) {
    const changed = structuredClone(input); changed.facts[0]![key] = value;
    expect(() => validatePreservedFencePublication(p, changed)).toThrow('original_or_derived_drift');
  }
});

test('original page content, frontmatter, hash, raw body and source binding each invalidate independently', () => {
  const input = inputs(), p = planPreservedFencePublication(input);
  const changes: Array<(i: PreservedFenceInputs) => void> = [
    i => { i.page.compiled_truth = 'Changed'; }, i => { i.page.frontmatter = { provenance: 'changed' }; },
    i => { i.page.content_hash = 'changed'; }, i => { i.body += '\n'; },
    i => { i.source.incarnation = 'changed'; }, i => { i.source.local_path = '/changed'; },
  ];
  for (const mutate of changes) { const changed = structuredClone(input); mutate(changed);
    expect(() => validatePreservedFencePublication(p, changed)).toThrow('original_or_derived_drift'); }
});

test('full original population includes noncandidate occupied rows, not only seven target IDs', () => {
  const occupied = fact({ id: '9', fact: 'Another claim', row_num: 8, source_markdown_slug: 'people/example', expired_at: '2026-01-02T00:00:00Z' });
  const input = inputs([fact(), occupied]), p = planPreservedFencePublication(input);
  expect(p.original_facts).toHaveLength(2);
  expect(p.bindings).toHaveLength(1);
  const changed = structuredClone(input); changed.facts[1]!.source_session = 'changed';
  expect(() => validatePreservedFencePublication(p, changed)).toThrow('original_or_derived_drift');
});

test('changed derived body, claim, mapping, missing binding and extra unlisted field refuse', () => {
  const input = inputs(), p = planPreservedFencePublication(input);
  const variants = [structuredClone(p), structuredClone(p), structuredClone(p), structuredClone(p), structuredClone(p)];
  variants[0]!.derived_body += '\n'; variants[1]!.bindings[0]!.derived_claim = 'Changed';
  variants[2]!.bindings[0]!.derived_row_num = 99; variants[3]!.bindings = [];
  Object.assign(variants[4]!, { allowed_transform: 'all' });
  for (const altered of variants) expect(() => validatePreservedFencePublication(altered, input)).toThrow('original_or_derived_drift');
});

test('removed columns, omitted values, added rows and missing rows do not masquerade as equality', () => {
  const input = inputs(), p = planPreservedFencePublication(input);
  const missing = structuredClone(input); delete missing.facts[0]!.source_session;
  expect(() => validatePreservedFencePublication(p, missing)).toThrow('incomplete_original_record');
  const omitted = structuredClone(input); omitted.facts[0]!.source_session = undefined;
  expect(() => validatePreservedFencePublication(p, omitted)).toThrow('incomplete_original_record');
  const added = structuredClone(input); added.facts.push(fact({ id: '9', fact: 'Added fact' }));
  expect(() => validatePreservedFencePublication(p, added)).toThrow('original_or_derived_drift');
  const removed = structuredClone(input); removed.facts = [];
  expect(() => validatePreservedFencePublication(p, removed)).toThrow('missing_candidate_identity');
});

test('schema-manifest removal cannot hide provenance drift from validation', () => {
  const input = inputs(), p = planPreservedFencePublication(input), changed = structuredClone(input);
  delete changed.facts[0]!.source_session; changed.columns.facts = changed.columns.facts.filter(c => c !== 'source_session');
  expect(() => validatePreservedFencePublication(p, changed)).toThrow('original_or_derived_drift');
});

test('source and page isolation reject cross-source originals and moved candidates', () => {
  const input = inputs(); input.facts[0]!.source_id = 'other';
  expect(() => planPreservedFencePublication(input)).toThrow('out_of_scope_original');
  const page = inputs(); page.page.source_id = 'other';
  expect(() => planPreservedFencePublication(page)).toThrow('source_or_page_mismatch');
  const moved = inputs(); moved.facts[0]!.entity_slug = 'other'; moved.facts[0]!.source_markdown_slug = 'people/example';
  expect(() => planPreservedFencePublication(moved)).toThrow('ineligible_candidate');
});

test('Postgres bigint identities stay exact, including IDs above the JS safe-integer range', () => {
  for (const id of [7n, 9007199254740993n]) {
    const input = inputs([fact({ id })]), before = structuredClone(input);
    const publication = planPreservedFencePublication(input);
    expect(publication.bindings[0]!.original_fact_id).toBe(String(id));
    expect(input).toEqual(before);
    expect(input.facts[0]!.id).toBe(id);
    validatePreservedFencePublication(publication, input);
    const changed = structuredClone(input); changed.facts[0]!.id = id + 1n;
    changed.candidateIds = [String(id + 1n)];
    expect(() => validatePreservedFencePublication(publication, changed)).toThrow('original_or_derived_drift');
  }
});

test('malformed identities are not repaired and unsafe numeric identities are not rounded', () => {
  for (const id of ['07', ' 7', '7x', 9007199254740992, 0n, -7n]) {
    expect(() => planPreservedFencePublication(inputs([fact({ id })]))).toThrow('invalid_fact_identity');
  }
});

test('inactive/ontology candidates and invalid original positions refuse', () => {
  const expired = inputs([fact({ expired_at: '2026-01-02T00:00:00Z' })]); expired.candidateIds = ['7'];
  expect(() => planPreservedFencePublication(expired)).toThrow('ineligible_candidate');
  expect(() => planPreservedFencePublication(inputs([fact({ dimension: 'role' })]))).toThrow('ineligible_candidate');
  expect(() => planPreservedFencePublication(inputs([fact({ row_num: 0 })]))).toThrow('invalid_original_position');
});

test('noncandidate conversation-domain zero coordinates remain literal without claiming a fence position', () => {
  const original = fact({ id: '8', fact: 'Conversation claim', row_num: 0, source: 'cli:extract-conversation-facts',
    source_markdown_slug: 'conversations/original-log' });
  const input = inputs([fact(), original]); input.candidateIds = ['7'];
  const before = structuredClone(input), p = planPreservedFencePublication(input);
  expect(p.original_facts).toHaveLength(2);
  expect(p.bindings).toHaveLength(1);
  expect(input.facts[1]!.row_num).toBe(0);
  expect(input).toEqual(before);
  validatePreservedFencePublication(p, input);
});

test('discarded pure planning and rejected validation do not modify inputs or grant a write capability', () => {
  const input = frozen(inputs()), before = JSON.stringify(input), p = planPreservedFencePublication(input);
  const changed = structuredClone(input); changed.page.frontmatter = { changed: true };
  expect(() => validatePreservedFencePublication(p, changed)).toThrow();
  expect(JSON.stringify(input)).toBe(before);
  expect(Object.keys(p).sort()).toEqual(['bindings', 'columns', 'derived_body', 'entity_slug', 'original_body_sha256',
    'original_facts', 'original_page_sha256', 'original_source_sha256', 'schema', 'source_id'].sort());
});
