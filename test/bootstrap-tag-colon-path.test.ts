import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('marketplace ref guard handles colon paths, multiple refs and trailing Markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-sha256:'));
  const doc = join(root, 'docs', 'guide:fixture.md');
  mkdirSync(join(root, 'docs'));
  const run = () => spawnSync('bash', [join(import.meta.dir, '..', 'scripts', 'check-bootstrap-tag.sh')], {
    encoding: 'utf8', env: { ...process.env, GBRAIN_BOOTSTRAP_GUARD_ROOT: root },
  });
  try {
    writeFileSync(doc, '`codex plugin marketplace add garrytan/gbrain@codex-plugin` <!-- comment -->\nplugin marketplace add garrytan/gbrain@latest-stable\n');
    expect(run().status).toBe(0);
    writeFileSync(doc, 'plugin marketplace add garrytan/gbrain@master and plugin marketplace add garrytan/gbrain@codex-plugin\n');
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(`${doc}:1`);
    expect(rejected.stderr).toContain('gbrain@master');
  } finally { rmSync(root, { force: true, recursive: true }); }
});
