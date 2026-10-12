import type { Recipe, AIGatewayConfig } from './types.ts';

/** Nonsecret deployment identity, scoped to the two OpenCode GO lanes. */
export function opencodeGoSessionHeaders(recipe: Recipe, cfg: AIGatewayConfig): Record<string, string> | undefined {
  if (recipe.id !== 'deepseek' && recipe.id !== 'litellm') return undefined;
  const baseURL = cfg.base_urls?.[recipe.id] ?? recipe.base_url_default;
  if (!baseURL) return undefined;
  let host: string;
  try { host = new URL(baseURL).hostname.toLowerCase(); } catch { return undefined; }
  if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return undefined;
  return { 'x-opencode-session': cfg.env.OPENCODE_GO_SESSION?.trim() || `gbrain-go-session:${cfg.env.HOSTNAME ?? 'local'}` };
}
