/**
 * gitleaks adapter: secret detection.
 *
 * Staged mode scans the staged diff. Range mode scans every commit in
 * `base..HEAD`, so a secret added in one commit and deleted in the next is
 * still reported (it would still be pushed). Secrets are redacted in output.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describeFailure } from './exec';
import { parseSarif } from './sarif';
import type { ScannerAdapter } from './types';

export const gitleaksAdapter: ScannerAdapter = {
  name: 'gitleaks',
  run(ctx, exec, tmpDir) {
    if (ctx.mode === 'range' && !ctx.baseRev) return { skipped: 'no base revision' };

    const report = path.join(tmpDir, 'gitleaks.sarif');
    const args = [
      'git', '--no-banner', '--redact', '--exit-code', '0',
      '--report-format', 'sarif', '--report-path', report,
    ];
    args.push(ctx.mode === 'staged' ? '--staged' : `--log-opts=${ctx.baseRev}..HEAD`);
    args.push('.');

    const r = exec('gitleaks', args, { cwd: ctx.root, timeoutMs: 60_000 });
    if (r.error || r.status !== 0) return { skipped: describeFailure(r) };
    if (!fs.existsSync(report)) return { skipped: 'produced no report' };

    try {
      return { findings: parseSarif(fs.readFileSync(report, 'utf-8'), ctx.root) };
    } catch {
      return { skipped: 'produced an unreadable report' };
    }
  },
};
