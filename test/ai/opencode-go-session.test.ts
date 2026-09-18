/**
 * OpenCode GO session-header fix (v0.48.4.1).
 *
 * GO ("OpenCode GO", the tier at https://opencode.ai/zen/go/v1) began
 * rejecting OpenAI-compatible requests that omit a nonempty
 * `x-opencode-session` header. GBrain runs two coding lanes against GO — the
 * `deepseek` and `litellm` recipes pointed at the opencode.ai base URL.
 *
 * This test pins the narrow contract:
 *   1. A `deepseek` or `litellm` recipe whose resolved base URL is on
 *      `opencode.ai` yields a NONEMPTY `x-opencode-session` default header.
 *   2. The same recipes pointed at a non-GO URL (e.g. direct
 *      `api.deepseek.com`) yield NO such header.
 *   3. Other recipes (even pointed at opencode.ai) get NO header — the fix is
 *      scoped to exactly the two GO lanes.
 *   4. The header actually rides through applyResolveAuth (the unified
 *      embedding/expansion/chat auth path) into the headers the SDK sends.
 *   5. The session value comes from the managed env var OPENCODE_GO_SESSION
 *      when present, else a documented, stable literal fallback (so restarts
 *      share a value without leaking credentials).
 */

import { describe, expect, test } from 'bun:test';
import {
  applyResolveAuth,
  opencodeGoSessionHeaders,
} from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import type { AIGatewayConfig } from '../../src/core/ai/types.ts';

const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
const DIRECT_DEEPSEEK_URL = 'https://api.deepseek.com/v1';

function cfg(baseUrls: Record<string, string>, env: Record<string, string | undefined> = {}): AIGatewayConfig {
  return {
    base_urls: baseUrls,
    env,
    // chat_model is required by the type; unused by the helpers under test.
    chat_model: 'deepseek:deepseek-v4-flash',
  } as unknown as AIGatewayConfig;
}

function envWith(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...extra };
}

const deepseek = getRecipe('deepseek');
const litellm = getRecipe('litellm');

describe('opencodeGoSessionHeaders — scoped to the GO lanes', () => {
  test('deepseek recipe on an opencode.ai base URL yields a nonempty session header', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    const headers = opencodeGoSessionHeaders(deepseek, cfg({ deepseek: GO_BASE_URL }));
    expect(headers).toBeDefined();
    const session = headers?.['x-opencode-session'];
    expect(session).toBeDefined();
    expect(session!.length).toBeGreaterThan(0);
  });

  test('litellm recipe on an opencode.ai base URL yields a nonempty session header', () => {
    if (!litellm) throw new Error('litellm recipe missing');
    const headers = opencodeGoSessionHeaders(litellm, cfg({ litellm: GO_BASE_URL }));
    expect(headers).toBeDefined();
    const session = headers?.['x-opencode-session'];
    expect(session).toBeDefined();
    expect(session!.length).toBeGreaterThan(0);
  });

  test('opencode.ai sub-domain (e.g. zen subdomain) is matched', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    const headers = opencodeGoSessionHeaders(deepseek, cfg({ deepseek: 'https://api.opencode.ai/anything' }));
    expect(headers).toBeDefined();
  });

  test.each([
    ['deepseek', DIRECT_DEEPSEEK_URL],
    ['litellm', 'http://localhost:4000/v1'],
  ])('%s recipe on a NON-opencode.ai base URL gets NO session header', (id, url) => {
    const recipe = getRecipe(id);
    if (!recipe) throw new Error(`recipe ${id} missing`);
    const headers = opencodeGoSessionHeaders(recipe, cfg({ [id]: url }));
    expect(headers).toBeUndefined();
  });

  test('a non-GO recipe pointed at opencode.ai still gets NO session header (scope is the two lanes only)', () => {
    // groq/openai declarations point their OWN terminal; force a GO URL to
    // prove the fix is not blanket host-based.
    const groq = getRecipe('groq');
    if (!groq) throw new Error('groq recipe missing');
    const headers = opencodeGoSessionHeaders(groq, cfg({ groq: GO_BASE_URL }));
    expect(headers).toBeUndefined();
  });

  test('malformed base URL does not throw; returns undefined', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    expect(() => opencodeGoSessionHeaders(deepseek, cfg({ deepseek: '::not-a-url' }))).not.toThrow();
    const headers = opencodeGoSessionHeaders(deepseek, cfg({ deepseek: '::not-a-url' }));
    expect(headers).toBeUndefined();
  });
});

describe('opencodeGoSessionHeaders — stable, non-secret session value', () => {
  test('uses OPENCODE_GO_SESSION env when present', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    const headers = opencodeGoSessionHeaders(
      deepseek,
      cfg({ deepseek: GO_BASE_URL }, envWith({ OPENCODE_GO_SESSION: 'stable-deploy-01' })),
    );
    expect(headers?.['x-opencode-session']).toBe('stable-deploy-01');
  });

  test('falls back to a documented literal (stable across restarts) when env is unset', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    const a = opencodeGoSessionHeaders(deepseek, cfg({ deepseek: GO_BASE_URL }, envWith({ HOSTNAME: 'orpheus' })));
    const b = opencodeGoSessionHeaders(deepseek, cfg({ deepseek: GO_BASE_URL }, envWith({ HOSTNAME: 'orpheus' })));
    expect(a?.['x-opencode-session']).toBe(b?.['x-opencode-session']);
    expect(a?.['x-opencode-session']).toBe('gbrain-go-session:orpheus');
  });

  test('literal fallback handles a missing HOSTNAME gracelessly', () => {
    if (!litellm) throw new Error('litellm recipe missing');
    const headers = opencodeGoSessionHeaders(litellm, cfg({ litellm: GO_BASE_URL }));
    expect(headers?.['x-opencode-session']).toBeDefined();
  });
});

describe('applyResolveAuth — the session header rides the unified auth path', () => {
  test('deepseek on GO: the resolved SDK headers include a nonempty session header', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    const auth = applyResolveAuth(deepseek, cfg({ deepseek: GO_BASE_URL }, envWith({ DEEPSEEK_API_KEY: 'k' })), 'chat');
    const headers = auth.headers ?? {};
    expect(headers['x-opencode-session']).toBeDefined();
    expect(headers['x-opencode-session']!.length).toBeGreaterThan(0);
  });

  test('deepseek on DIRECT api.deepseek.com: no session header rides through applyResolveAuth', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    const auth = applyResolveAuth(deepseek, cfg({ deepseek: DIRECT_DEEPSEEK_URL }, envWith({ DEEPSEEK_API_KEY: 'k' })), 'chat');
    expect(auth.headers?.['x-opencode-session']).toBeUndefined();
  });

  test('litellm on GO: the resolved SDK headers include a nonempty session header', () => {
    if (!litellm) throw new Error('litellm recipe missing');
    const auth = applyResolveAuth(litellm, cfg({ litellm: GO_BASE_URL }, envWith({ LITELLM_API_KEY: 'k' })), 'chat');
    expect(auth.headers?.['x-opencode-session']).toBeDefined();
  });

  test('distinct from the auth header: GO session header never shadows Authorization', () => {
    if (!deepseek) throw new Error('deepseek recipe missing');
    const env = envWith({ DEEPSEEK_API_KEY: 'sk-test' });
    const auth = applyResolveAuth(deepseek, cfg({ deepseek: GO_BASE_URL }, env), 'chat');
    // The bearer key must still ride (so the request authenticates) — the
    // session header is in addition, not a replacement.
    expect(auth.apiKey ?? auth.headers?.['authorization']).toBeTruthy();
    expect(auth.headers?.['x-opencode-session']).toBeDefined();
  });
});