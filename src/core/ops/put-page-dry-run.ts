import { preflightPutPageAdmission } from '../persistence/page-mutations.ts';
import { suffixedSlugDryRun } from '../persistence/suffixed-slug.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from './context.ts';
import type { OperationContext } from './contract.ts';

/**
 * put_page's dry run, peeled out of ops/pages.ts (module-size ratchet).
 *
 * It passes the same admission checks the live write passes (the canonical
 * type vocabulary and the indexing scope), then the slug guards and the suffixed-slug preview,
 * and returns the dry-run receipt without journaling a request, writing a file
 * or touching an existing page. Keeping the preflight shared is what makes a
 * preview refuse exactly what the live write would refuse.
 */
export async function putPageDryRun(ctx: OperationContext, params: Record<string, unknown>, sourceId: string): Promise<Record<string, unknown>> {
  await preflightPutPageAdmission(ctx, params);
  if (typeof params.slug === 'string') {
    validatePageSlug(params.slug);
    enforceClientSlugFence(ctx, params.slug, 'put_page');
    enforceSubagentSlugFence(ctx, params.slug, 'put_page');
    await suffixedSlugDryRun(ctx, sourceId, params.slug);
  }
  return { dry_run: true, action: 'put_page', slug: params.slug };
}
