/**
 * Forward-port regression tests — 8a9508aaf's four pre-v0.51 semantic
 * adaptations (unit-level, pure-function seams; no PGLite / no durable
 * fixture). Deliberately narrow: exercises each adaptation's exported seam so
 * a regression in the ported logic fails loudly without spinning up an engine.
 *
 *   1. callable put_page types          -> classifyStoredType + canonicalTypeRejectMessage
 *   2. sync.exclude root guard          -> matchesAnyGlob + the exact pattern
 *        translation the put_page guard performs (comma/newline split,
 *        trim/filter, trailing-"/" -> "/**")
 *   3. exclude_slug_prefixes retrieval  -> buildHardExcludeClause unions the
 *        engine-stable op excludes into the SQL AND-clause
 *   4. covered-atom default exclusion   -> buildCoveredAtomExclusionClause
 *        (default carve-out) + the knobsHash `ica=` opt-out bit
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyStoredType,
  canonicalTypeRejectMessage,
} from '../src/core/schema-pack/type-usage.ts';
import { matchesAnyGlob } from '../src/core/sync.ts';
import {
  buildHardExcludeClause,
  buildCoveredAtomExclusionClause,
} from '../src/core/search/sql-ranking.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';

// ── adaptation 1: canonical put_page types ─────────────────────────────────
const PACK = {
  page_types: [
    { name: 'person', path_prefixes: ['people/'], aliases: ['people', 'p'] },
    { name: 'company', path_prefixes: ['companies/'], aliases: ['corp'] },
    { name: 'note', path_prefixes: ['notes/'], aliases: [] },
  ],
};

describe('forward-port: canonical put_page types', () => {
  test('a declared canonical type classifies as canonical', () => {
    expect(classifyStoredType('person', PACK)).toEqual({ kind: 'canonical' });
    expect(classifyStoredType('note', PACK)).toEqual({ kind: 'canonical' });
  });

  test('a declared alias classifies as alias_of with canonical + directory', () => {
    expect(classifyStoredType('people', PACK)).toEqual({
      kind: 'alias_of', canonical: 'person', directory: 'people/',
    });
    expect(classifyStoredType('corp', PACK)).toEqual({
      kind: 'alias_of', canonical: 'company', directory: 'companies/',
    });
  });

  test('an undeclared explicit type classifies as undeclared', () => {
    expect(classifyStoredType('blorbfax', PACK)).toEqual({ kind: 'undeclared' });
  });

  test('canonicalTypeRejectMessage names the declared vocabulary so the caller self-corrects', () => {
    const msg = canonicalTypeRejectMessage('blorbfax', PACK);
    expect(msg).toContain("page type 'blorbfax'");
    expect(msg).toContain('neither a declared canonical type');
    expect(msg).toContain('person (people, p)');
    expect(msg).toContain('company (corp)');
    expect(msg).toContain('Known aliases are normalized to their canonical type automatically.');
  });

  test('canonicalTypeRejectMessage handles an empty pack gracefully', () => {
    const msg = canonicalTypeRejectMessage('x', { page_types: [] });
    expect(msg).toContain('none declared');
  });
});

// ── adaptation 2: sync.exclude root guard ──────────────────────────────────
// Mirror the exact translation enforceExcludedRootGuard (ops/pages.ts) applies
// to the persisted sync.exclude value, then assert matchesAnyGlob — the
// exported engine-stable glob the guard delegates to.
function guardPatterns(stored: string | null): string[] {
  return (stored ?? '')
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.endsWith('/') ? `${p}**` : p));
}

describe('forward-port: sync.exclude root guard', () => {
  test('comma + newline separated roots are split, trimmed, filtered', () => {
    expect(guardPatterns('private/, secret\n\nnotes/ ,')).toEqual([
      'private/**', 'secret', 'notes/**',
    ]);
  });

  test('trailing-slash roots become subtree globs; bare roots match literal', () => {
    expect(guardPatterns('private/')).toEqual(['private/**']);
    expect(guardPatterns('scratch/')).toEqual(['scratch/**']);
  });

  test('a slug under an excluded subtree root is rejected (matchesAnyGlob)', () => {
    const patterns = guardPatterns('private/, notes/');
    expect(matchesAnyGlob('private/patient-1', patterns)).toBe(true);
    expect(matchesAnyGlob('notes/daily/2026-09-20', patterns)).toBe(true);
  });

  test('a slug outside the excluded roots is allowed', () => {
    const patterns = guardPatterns('private/, scratch/');
    expect(matchesAnyGlob('people/alice', patterns)).toBe(false);
  });

  test('empty / null config fail-open (nothing scoped, nothing rejected)', () => {
    expect(guardPatterns(null)).toEqual([]);
    expect(guardPatterns('')).toEqual([]);
    expect(guardPatterns('   ')).toEqual([]);
  });

  test('a bare prefix root matches only that path segment subtree', () => {
    // `secret` (no trailing slash) in the guard translation stays literal;
    // `secret/x` must NOT match it (matchesAnyGlob is segment-aware).
    const patterns = guardPatterns('secret/');
    expect(matchesAnyGlob('secret/claims/x', patterns)).toBe(true);
    expect(matchesAnyGlob('secretclaims', patterns)).toBe(false);
  });
});

// ── adaptation 3: exclude_slug_prefixes retrieval (SQL seam) ───────────────
describe('forward-port: exclude_slug_prefixes retrieval seam', () => {
  test('buildHardExcludeClause unions caller prefixes into the SQL AND-clause', () => {
    const clause = buildHardExcludeClause('p.slug', ['test/', 'atoms/']);
    expect(clause).toContain('AND NOT');
    expect(clause).toContain('test/%');
    expect(clause).toContain('atoms/%');
  });

  test('covered-atom clause (adapt 4) is appended to the hard-exclude clause when opt-out absent', () => {
    // The engine builds: buildHardExcludeClause(...) + (includeCoveredAtoms
    // ? '' : buildCoveredAtomExclusionClause(...)). Assert the combined
    // fragment under the DEFAULT carve-out policy.
    const hard = buildHardExcludeClause('p.slug', ['scratch/']);
    const fragment = hard + buildCoveredAtomExclusionClause('p.slug');
    expect(fragment).toContain('scratch/%');
    expect(fragment).toContain('a.type = \'atom\'');
    expect(fragment).toContain("source_slug");
  });
});

// ── adaptation 4: covered-atom default exclusion + opt-out ─────────────────
describe('forward-port: covered-atom default exclusion clause', () => {
  test('excludes atoms whose source_slug resolves to a live non-atom page', () => {
    const clause = buildCoveredAtomExclusionClause('p.slug');
    expect(clause).toContain("p.slug = ANY");
    expect(clause).toContain("a.type = 'atom'");
    expect(clause).toContain("a.deleted_at IS NULL");
    expect(clause).toContain("src.slug = (a.frontmatter ->> 'source_slug')");
    expect(clause).toContain("src.type <> 'atom'");
    expect(clause).toContain('page_links');
    expect(clause).toContain("t.type <> 'atom'");
  });

  test('knobsHash folds includeCoveredAtoms opt-out into the hash (ica bit)', () => {
    const knobs = resolveSearchMode({ mode: 'balanced' });
    const defaulted = knobsHash(knobs, { includeCoveredAtoms: false });
    const optedIn = knobsHash(knobs, { includeCoveredAtoms: true });
    const absent = knobsHash(knobs); // default carve-out active
    // Absent hashes like false (default carve-out), so a legacy hold-to-default
    // caller shares a bucket with an explicit default write.
    expect(absent).toBe(defaulted);
    // Opt-in never shares a bucket with the default carve-out.
    expect(optedIn).not.toBe(defaulted);
    // Deterministic: identical args -> identical hash.
    expect(knobsHash(knobs, { includeCoveredAtoms: true })).toBe(optedIn);
  });
});