import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSubagentCapability } from '../src/commands/doctor/checks/search-eval.ts';

const model = 'litellm:deepseek-v4.1-flash';
let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('models.subagent', model);
  await engine.setConfig('agent.use_gateway_loop', 'true');
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw('DELETE FROM chat_usage_log'); });

async function record(route = model, provider = 'litellm', age = '0 days', cached = 40) {
  await engine.executeRaw(`INSERT INTO chat_usage_log
    (model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
    VALUES ($1, $2, 100, 5, $3, 0, now() - $4::interval)`, [route, provider, cached, age]);
}

test('warns without evidence, clears for observed exact-route hits, warns again when evidence is absent', async () => {
  expect((await checkSubagentCapability(engine)).status).toBe('warn');
  await record();
  const observed = await checkSubagentCapability(engine);
  expect(observed.status).toBe('ok');
  expect(observed.message).toContain('40 cache-read tokens');
  expect(observed.message).toContain('not a guarantee for every request');
  expect(observed.details).toMatchObject({ resolved_model: model, evidence_window_days: 7,
    cache_evidence: { calls: 1, cache_read_tokens: 40 } });
  await engine.executeRaw('DELETE FROM chat_usage_log');
  expect((await checkSubagentCapability(engine)).status).toBe('warn');
});

test('another model or provider cannot prove the configured route caches', async () => {
  await record('litellm:other-model');
  await record(model, 'different-proxy');
  expect((await checkSubagentCapability(engine)).status).toBe('warn');
});

test('expired and future-dated evidence does not clear the warning', async () => {
  await record(model, 'litellm', '8 days');
  await record(model, 'litellm', '-1 days');
  expect((await checkSubagentCapability(engine)).status).toBe('warn');
});

test('zero and impossible cache counts do not clear the warning', async () => {
  await record(model, 'litellm', '0 days', 0);
  await record(model, 'litellm', '0 days', 101);
  const check = await checkSubagentCapability(engine);
  expect(check.status).toBe('warn');
  expect(check.message).toContain('unverified, not proven unsupported');
});

test('an unreadable usage ledger remains a warning, never a pass', async () => {
  const broken = {
    getConfig: (key: string) => engine.getConfig(key),
    executeRaw: async () => { throw new Error('ledger unavailable'); },
  } as unknown as PGLiteEngine;
  expect((await checkSubagentCapability(broken)).status).toBe('warn');
});
