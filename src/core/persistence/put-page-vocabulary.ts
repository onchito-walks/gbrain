import { screenImportContent } from '../import-screen.ts';
import { serializeMarkdown, type ParseOpts } from '../markdown.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { classifyStoredType, sanitizeTypeForDisplay } from '../schema-pack/type-usage.ts';
import { loadActivePackForWriteVocabulary } from '../schema-pack/write-vocabulary.ts';

/** B01: the public replacement and native owner share one explicit-type policy.
 * Unresolvable packs preserve the best-effort boundary. Invalid/oversized raw
 * content is left untouched for the importer's typed refusal, never shrunk by
 * normalization. Sync's owner-internal file imports retain upstream semantics.
 */
export function canonicalPutPageContent(content: string, slug: string, pack: ParseOpts['activePack']): string {
  if (!pack) return content;
  const screen = screenImportContent({ content, path: `${slug}.md`, activePack: pack });
  // Only an importable screen carries parsed content: a refusal keeps the raw
  // bytes for the importer's own typed refusal, and a published screen (never
  // produced by this call) has nothing to normalize.
  if (screen.status !== 'importable') return content;
  const parsed = screen.parsed;
  if (!parsed?.typeExplicit) return content;
  const classified = classifyStoredType(parsed.type, pack);
  if (classified.kind === 'undeclared') {
    const names = pack.page_types.map(type => sanitizeTypeForDisplay(type.name)).sort();
    throw new OperationError('invalid_params',
      `put_page: page type '${sanitizeTypeForDisplay(parsed.type)}' is neither a declared canonical type nor a known alias in the active schema pack.`,
      `Use a declared type (${names.slice(0, 12).join(', ') || 'none declared'}${names.length > 12 ? ', …' : ''}) or its alias, or declare the type before writing. Nothing was written or embedded.`);
  }
  return classified.kind === 'alias_of'
    ? serializeMarkdown(parsed.frontmatter, parsed.compiled_truth, parsed.timeline,
      { type: classified.canonical, title: parsed.title, tags: parsed.tags }) : content;
}

/** Read-only preflight, also used by dry runs before registration/journaling. */
export async function putPageVocabularyContent(ctx: OperationContext, params: Record<string, unknown>, sourceId: string): Promise<unknown> {
  if (typeof params.content !== 'string' || typeof params.slug !== 'string') return params.content;
  const pack = await loadActivePackForWriteVocabulary({ engine: ctx.engine, remote: ctx.remote, sourceId });
  return canonicalPutPageContent(params.content, params.slug.toLowerCase(), pack?.manifest);
}
