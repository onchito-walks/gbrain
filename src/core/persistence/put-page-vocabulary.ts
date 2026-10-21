import { screenImportContent } from '../import-screen.ts';
import { serializeMarkdown, type ParseOpts } from '../markdown.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { classifyStoredType, sanitizeTypeForDisplay } from '../schema-pack/type-usage.ts';
import { loadActivePackForWriteVocabulary } from '../schema-pack/write-vocabulary.ts';
import type { ResolvedPack } from '../schema-pack/registry.ts';
import { normalizeSubagentPageInput } from './page-input.ts';

/**
 * One request resolves the write-vocabulary pack at most once. Preflight and
 * preparation share the same operation context, so the second resolve is a
 * memo hit instead of two more config round trips. Nothing is cached across
 * requests (a later write to a changed pack or source override resolves
 * fresh), and the loader keeps its own best-effort, never-throwing contract.
 */
const resolvedByContext = new WeakMap<object, Map<string, ResolvedPack | null>>();

async function writeVocabularyPack(ctx: OperationContext, sourceId: string): Promise<ResolvedPack | null> {
  let perContext = resolvedByContext.get(ctx);
  if (!perContext) { perContext = new Map(); resolvedByContext.set(ctx, perContext); }
  const cached = perContext.get(sourceId);
  if (cached !== undefined) return cached;
  const pack = await loadActivePackForWriteVocabulary({ engine: ctx.engine, remote: ctx.remote, sourceId });
  perContext.set(sourceId, pack);
  return pack;
}

/** B01: the public replacement and native owner share one explicit-type policy.
 * Unresolvable packs preserve the best-effort boundary. Invalid/oversized raw
 * content is left untouched for the importer's typed refusal, never shrunk by
 * normalization. Sync's owner-internal file imports retain upstream semantics.
 *
 * `opts.storedType` is the type already stored on THIS page in THIS source. It
 * admits an explicit type the active pack no longer declares (an older row such
 * as `extract_receipt`) only when the content declares exactly that type, and
 * returns the content unchanged: a repair may restamp such a row, while a new
 * page and any replacement type stay refused.
 */
export function canonicalPutPageContent(content: string, slug: string, pack: ParseOpts['activePack'],
  opts: { storedType?: string | null } = {}): string {
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
    if (opts.storedType && parsed.type === opts.storedType) return content;
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
  const pack = await writeVocabularyPack(ctx, sourceId);
  // Only server-bound generated scope can normalize; caller params never
  // manufacture this context. Use the actual write source's resolved pack.
  const intent: Record<string, unknown> & { slug: string } = { ...params, slug: params.slug.toLowerCase() };
  normalizeSubagentPageInput(ctx, intent, pack?.manifest);
  const content = intent.content as string;
  // A legacy stored type (e.g. `extract_receipt`, no longer declared) may only
  // survive an update of the page that already carries it. The lookup is lazy:
  // only content with a frontmatter `type:` line can need it, and the admission
  // still requires an exact match on this same source+slug row.
  const storedType = FRONTMATTER_TYPE_LINE_RE.test(content) ? await storedPageType(ctx, sourceId, intent.slug) : null;
  return canonicalPutPageContent(content, intent.slug, pack?.manifest, { storedType });
}

const FRONTMATTER_TYPE_LINE_RE = /^[ \t]*type[ \t]*:/m;

async function storedPageType(ctx: OperationContext, sourceId: string, slug: string): Promise<string | null> {
  const [row] = await ctx.engine.executeRaw<{ type: string }>(
    'SELECT type FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  return row?.type ?? null;
}
