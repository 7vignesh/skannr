/**
 * osv-scanner adapter: known vulnerabilities in changed lockfiles.
 *
 * Reports only vulnerabilities the change introduces: the lockfile is scanned
 * as it will be (staged or HEAD) and as it was (the base revision), and
 * findings present in both are dropped. Otherwise every commit that touches
 * a lockfile would be blocked by vulnerabilities that were already there.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describeFailure } from './exec';
import { parseSarif } from './sarif';
import type { ExecFn, RawFinding, ScanContext, ScannerAdapter } from './types';

/** Lockfile names this adapter hands to osv-scanner (it picks the parser by file name). */
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'requirements.txt', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.mod',
  'Gemfile.lock', 'composer.lock',
]);

const TIMEOUT_MS = 120_000;

function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

/** Read `rev:file` from git; null when it does not exist at that revision. */
function gitShow(ctx: ScanContext, exec: ExecFn, spec: string): string | null {
  const r = exec('git', ['show', spec], { cwd: ctx.root, timeoutMs: 30_000 });
  return !r.error && r.status === 0 ? r.stdout : null;
}

type ScanOutcome = { findings: RawFinding[] } | { error: string };

/** Write `content` under its real file name in its own temp dir and scan it. */
function scanContent(content: string, name: string, dir: string, ctx: ScanContext, exec: ExecFn): ScanOutcome {
  fs.mkdirSync(dir, { recursive: true });
  const lockfile = path.join(dir, name);
  const report = path.join(dir, 'osv.sarif');
  fs.writeFileSync(lockfile, content, 'utf-8');

  const r = exec(
    'osv-scanner',
    ['scan', 'source', '-L', lockfile, '--format', 'sarif', '--output-file', report],
    { cwd: ctx.root, timeoutMs: TIMEOUT_MS },
  );
  // osv-scanner exits 1 when it finds vulnerabilities and 128 when the lockfile
  // lists no packages (for example an empty baseline). Neither is a failure.
  if (r.error) return { error: describeFailure(r) };
  if (r.status === 128) return { findings: [] };
  if (r.status !== 0 && r.status !== 1) return { error: describeFailure(r) };
  if (!fs.existsSync(report)) return { error: 'produced no report' };
  try {
    return { findings: parseSarif(fs.readFileSync(report, 'utf-8'), dir) };
  } catch {
    return { error: 'produced an unreadable report' };
  }
}

export const osvAdapter: ScannerAdapter = {
  name: 'osv-scanner',
  run(ctx, exec, tmpDir) {
    const lockfiles = ctx.changedFiles.filter((f) => LOCKFILES.has(baseName(f)));
    if (lockfiles.length === 0) return null;
    if (!ctx.baseRev) return { skipped: 'no base revision' };

    const findings: RawFinding[] = [];
    for (const [i, file] of lockfiles.entries()) {
      const now = ctx.readChanged(file);
      if (now === null) continue;
      const name = baseName(file);

      const after = scanContent(now, name, path.join(tmpDir, `osv-${i}-after`), ctx, exec);
      if ('error' in after) return { skipped: after.error };

      const baseContent = gitShow(ctx, exec, `${ctx.baseRev}:${file}`);
      const before = new Set<string>();
      if (baseContent !== null) {
        const b = scanContent(baseContent, name, path.join(tmpDir, `osv-${i}-before`), ctx, exec);
        if ('error' in b) return { skipped: `baseline scan failed: ${b.error}` };
        for (const f of b.findings) before.add(f.message);
      }

      for (const f of after.findings) {
        if (!before.has(f.message)) findings.push({ ...f, file, line: 1, endLine: 1 });
      }
    }
    return { findings };
  },
};
