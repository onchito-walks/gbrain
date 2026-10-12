import { execFile } from './spawn.ts';
import { open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gitRelativePath } from './sync-git.ts';
import { isPathPruned, isSyncable, pathToSlug } from './sync.ts';

export type DriftSyncOptions = NonNullable<Parameters<typeof isSyncable>[1]>;

export class DriftDeadlineError extends Error {
  constructor() { super('Multi-source drift verification deadline exceeded'); }
}

/** Bounds the verifier's wait, NOT cancellation of an engine's in-flight read. */
export async function beforeDriftDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DriftDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DriftDeadlineError()), remaining); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface DriftGitScope { slugPrefix: string; pathPrefix: string }
const executeFile = promisify(execFile);
export async function resolveDriftGitScope(localPath: string, deadline: number): Promise<DriftGitScope> {
  return beforeDriftDeadline(deadline, async () => {
    const scopeRoot = await realpath(localPath);
    const { stdout } = await executeFile('git', ['rev-parse', '--show-toplevel'], {
      cwd: scopeRoot, timeout: Math.max(1, Math.min(30_000, deadline - Date.now())), encoding: 'utf8',
    });
    const gitRoot = await realpath(stdout.trim());
    const pathPrefix = gitRelativePath(gitRoot, scopeRoot);
    if (pathPrefix === '..' || pathPrefix.startsWith('../') || isAbsolute(pathPrefix)) {
      throw new Error('Source scope escapes Git root');
    }
    const slugPrefix = pathPrefix ? pathToSlug(join(pathPrefix, 'x.md')).slice(0, -2) : '';
    // Empty/partially empty Git scope segments must not alias another namespace.
    if (pathPrefix && !slugPrefix) throw new Error('Git scope has no usable slug');
    return { slugPrefix, pathPrefix };
  });
}

export interface DriftFile { relPath: string; content: string }
export interface DriftWalkResult { files: DriftFile[]; truncated: boolean; errors: number }

/** Same persistent sync classifiers; filesystem/read errors are coverage failures. */
export async function walkDriftMarkdown(
  root: string, limit: number, deadline: number, opts: DriftSyncOptions,
): Promise<DriftWalkResult> {
  const result: DriftWalkResult = { files: [], truncated: false, errors: 0 };
  async function walk(dir: string): Promise<void> {
    if (result.truncated) return;
    const entries = await beforeDriftDeadline(deadline, () => readdir(dir, { withFileTypes: true }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (Date.now() >= deadline) throw new DriftDeadlineError();
      const path = join(dir, entry.name);
      const relPath = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) continue; // importer refuses symlinks too
      if (entry.isDirectory()) {
        if (isPathPruned(relPath, ['**'])) continue; // dot waiver cannot admit vendored/raw directories
        if (!opts.includeHidden?.length && isPathPruned(relPath)) continue;
        try { await walk(path); }
        catch (error) { if (error instanceof DriftDeadlineError) throw error; result.errors++; }
        if (result.truncated) return;
      } else if (isSyncable(relPath, opts)) {
        if (!entry.isFile()) { result.errors++; continue; }
        if (result.files.length >= limit) { result.truncated = true; return; }
        try {
          // Open once, refuse a raced symlink and inspect the actual open file.
          // Close a late-opened handle even when the outer deadline already won.
          const handle = await beforeDriftDeadline(deadline, async () => {
            const opened = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            if (Date.now() >= deadline) { await opened.close(); throw new DriftDeadlineError(); }
            return opened;
          });
          try {
            const stat = await beforeDriftDeadline(deadline, () => handle.stat());
            if (!stat.isFile() || stat.size > 5_000_000) { result.errors++; continue; }
            const content = await beforeDriftDeadline(deadline, () => handle.readFile('utf8'));
            result.files.push({ relPath, content: content.replace(/^\uFEFF/, '') });
          } finally { await handle.close(); }
        } catch (error) { if (error instanceof DriftDeadlineError) throw error; result.errors++; }
      }
    }
  }
  try { await walk(root); }
  catch (error) {
    if (error instanceof DriftDeadlineError) result.truncated = true;
    else result.errors++;
  }
  return result;
}
