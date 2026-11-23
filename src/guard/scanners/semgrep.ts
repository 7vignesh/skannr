/**
 * semgrep adapter: static analysis (SAST) of the changed files.
 *
 * The files are scanned exactly as reviewed (index content when staged, HEAD
 * content in range mode), copied into a temp dir. Scanning the working tree
 * instead would misplace line numbers whenever it differs from what is being
 * committed. Uses the `p/default` registry pack, so rules are downloaded on
 * first use. Metrics are off. Findings are kept only on added lines.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describeFailure } from './exec';
import { parseSarif } from './sarif';
import type { ScannerAdapter } from './types';

export const semgrepAdapter: ScannerAdapter = {
  name: 'semgrep',
  run(ctx, exec, tmpDir) {
    const srcDir = path.join(tmpDir, 'semgrep-src');
    const base = path.resolve(srcDir) + path.sep;
    const targets: string[] = [];

    for (const file of ctx.changedFiles) {
      const content = ctx.readChanged(file);
      if (content === null) continue;
      const dest = path.resolve(srcDir, file);
      if (!dest.startsWith(base)) continue; // never write outside the temp dir
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf-8');
      targets.push(file);
    }
    if (targets.length === 0) return null;

    const report = path.join(tmpDir, 'semgrep.sarif');
    const args = [
      'scan', '--config', 'p/default', '--metrics', 'off', '--sarif',
      '--output', report, '--quiet', '--disable-version-check',
      '--', ...targets.map((f) => `./${f}`),
    ];

    const r = exec('semgrep', args, { cwd: srcDir, timeoutMs: 180_000 });
    if (r.error || r.status !== 0) return { skipped: describeFailure(r) };
    if (!fs.existsSync(report)) return { skipped: 'produced no report' };

    let all;
    try {
      all = parseSarif(fs.readFileSync(report, 'utf-8'), srcDir);
    } catch {
      return { skipped: 'produced an unreadable report' };
    }

    const findings = all.filter((f) => {
      const added = ctx.addedLines.get(f.file);
      if (!added) return false;
      for (let line = f.line; line <= f.endLine; line++) if (added.has(line)) return true;
      return false;
    });
    return { findings };
  },
};
