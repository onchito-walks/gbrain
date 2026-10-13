import type { OperationContext } from '../ops/contract.ts';
import { screenImportContent } from '../import-screen.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import type { SchemaPackManifest } from '../schema-pack/manifest-v1.ts';
import { loadActivePackForWriteVocabulary, undeclaredPageTypeMessage, undeclaredPageTypeSuggestion } from '../schema-pack/write-vocabulary.ts';
import { classifyStoredType, safeCliToken, sanitizeTypeForDisplay } from '../schema-pack/type-usage.ts';

/** Normalize model-authored types once at admission, after an existing UUID has replayed. */
export function normalizeSubagentPageInput(ctx: OperationContext, intent: Record<string, unknown>, pack: SchemaPackManifest | undefined): void {
  if (ctx.viaSubagent !== true || !ctx.allowedSlugPrefixes?.length
    || typeof intent.content !== 'string' || typeof intent.slug !== 'string') return;
  if (!pack) return;
  // Screen ORIGINAL bytes, including size, YAML and slug identity. A producer
  // transformation must never repair a refused input into an acceptable one.
  const screen = screenImportContent({ content: intent.content, path: `${intent.slug}.md`, expectedSlug: intent.slug, activePack: pack });
  if (screen.status !== 'importable') return;
  const parsed = screen.parsed;
  if (parsed?.typeExplicit !== true) return;
  if (classifyStoredType(parsed.type, pack).kind !== 'undeclared'
    || !pack.page_types.some(type => type.name === 'note')) return;
  intent.content = serializeMarkdown({ ...parsed.frontmatter, legacy_type: parsed.type },
    parsed.compiled_truth, parsed.timeline, { type: 'note', title: parsed.title, tags: parsed.tags });
  ctx.logger.warn(`undeclared type '${sanitizeTypeForDisplay(parsed.type)}' normalized to 'note' `
    + `(legacy_type kept; pack ${pack.name})`);
}

export interface PageTypeWarning {
  code: 'page_type_undeclared';
  type: string;
  pack: string;
  cause: string;
  fix: string;
  docs: string;
}

/**
 * #5880: put_page stores an explicit type the write source's active pack
 * neither declares nor aliases as-is (warn, never reject); the caller gets
 * this warning in the committed result and on its logger.
 */
export async function undeclaredPageTypeWarning(ctx: OperationContext, intent: Record<string, unknown>, sourceId: string): Promise<PageTypeWarning | null> {
  if (typeof intent.content !== 'string' || typeof intent.slug !== 'string') return null;
  let parsed: ReturnType<typeof parseMarkdown>;
  try { parsed = parseMarkdown(intent.content, `${intent.slug}.md`); }
  catch { return null; }
  if (parsed.typeExplicit !== true) return null;
  const pack = await loadActivePackForWriteVocabulary({ engine: ctx.engine, remote: ctx.remote, sourceId });
  if (!pack || classifyStoredType(parsed.type, pack.manifest).kind !== 'undeclared') return null;
  const type = sanitizeTypeForDisplay(parsed.type);
  const warning: PageTypeWarning = {
    code: 'page_type_undeclared',
    type,
    pack: pack.manifest.name,
    cause: `${undeclaredPageTypeMessage(type, pack, 'put_page')} The page was stored with this type as-is.`,
    fix: `${undeclaredPageTypeSuggestion(pack)} To declare it: gbrain schema add-type ${safeCliToken(parsed.type) ?? '<type>'} (with its primitive and prefix)`,
    docs: 'docs/architecture/schema-packs.md#undeclared-page-types',
  };
  ctx.logger.warn(`[${warning.code}] ${warning.cause} ${warning.fix}`);
  return warning;
}
