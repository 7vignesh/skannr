/**
 * Deterministic scanners (gitleaks, semgrep, osv-scanner) for guard.
 *
 * Each scanner is optional: a missing binary or a failed run is reported in
 * the result and never fails the review. Findings are converted to the same
 * `Violation` shape the LLM review uses, tagged with their `source`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import parseDiff from 'parse-diff';
import { defaultExec } from './exec';
import { gitleaksAdapter } from './gitleaks';
import { osvAdapter } from './osv';
import { semgrepAdapter } from './semgrep';
import type { ScannerReport, Severity, Violation } from '../types';
import type { ExecFn, RawFinding, ScanContext, ScannerAdapter, ScannerName } from './types';

export const DEFAULT_ADAPTERS: ScannerAdapter[] = [gitleaksAdapter, semgrepAdapter, osvAdapter];

export interface ScanRunOptions {
  root: string;
  /** `staged` reviews the git index; `range` reviews `baseRef...HEAD`. */
  mode: 'staged' | 'range';
  /** The `baseRef...HEAD` diff text. Required in range mode. */
  diffText?: string;
  /** Base ref for range mode (for example `origin/main`). */
  baseRef?: string;
  exec?: ExecFn;
  adapters?: ScannerAdapter[];
}

export interface ScanRunResult {
  violations: Violation[];
  report: ScannerReport;
}

/** Changed (non-deleted) files and their added line numbers, from a unified diff. */
export function parseChangedLines(diffText: string): Pick<ScanContext, 'changedFiles' | 'addedLines'> {
  const changedFiles: string[] = [];
  const addedLines = new Map<string, Set<number>>();

  for (const file of parseDiff(diffText)) {
    const to = file.to;
    if (!to || to === '/dev/null') continue;
    changedFiles.push(to);
    const lines = new Set<number>();
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === 'add') lines.add(change.ln);
      }
    }
    addedLines.set(to, lines);
  }
  return { changedFiles, addedLines };
}

function buildContext(opts: ScanRunOptions, exec: ExecFn): ScanContext {
  let diffText = opts.diffText ?? '';
  let baseRev: string | undefined;

  if (opts.mode === 'staged') {
    const r = exec(
      'git',
      ['-c', 'core.quotepath=false', 'diff', '--cached', '-U0', '--no-color', '--no-ext-diff'],
      { cwd: opts.root, timeoutMs: 30_000 },
    );
    diffText = !r.error && r.status === 0 ? r.stdout : '';
    baseRev = 'HEAD';
  } else if (opts.baseRef) {
    const r = exec('git', ['merge-base', opts.baseRef, 'HEAD'], { cwd: opts.root, timeoutMs: 30_000 });
    if (!r.error && r.status === 0 && r.stdout.trim()) baseRev = r.stdout.trim();
  }

  const readChanged = (file: string): string | null => {
    const spec = opts.mode === 'staged' ? `:${file}` : `HEAD:${file}`;
    const r = exec('git', ['show', spec], { cwd: opts.root, timeoutMs: 30_000 });
    return !r.error && r.status === 0 ? r.stdout : null;
  };

  return { root: opts.root, mode: opts.mode, baseRev, readChanged, ...parseChangedLines(diffText) };
}

function severityFromScore(score: number | undefined): Severity {
  if (score === undefined) return 'medium';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function semgrepConfidence(tags: string[]): number {
  if (tags.includes('HIGH CONFIDENCE')) return 0.9;
  if (tags.includes('MEDIUM CONFIDENCE')) return 0.75;
  if (tags.includes('LOW CONFIDENCE')) return 0.6;
  return 0.8;
}

/** Convert one scanner finding into a guard violation. */
export function toViolation(name: ScannerName, f: RawFinding, mode: ScanContext['mode']): Violation {
  const base = {
    rule_id: `${name}:${f.ruleId}`,
    file: f.file,
    symbol: '',
    line_start: f.line,
    line_end: f.endLine,
    fixable: false,
    source: name,
  } as const;

  if (name === 'gitleaks') {
    const history = mode === 'range'
      ? ' It was found in a commit on this branch and stays in git history even if a later commit removes it.'
      : '';
    return {
      ...base,
      severity: 'critical',
      confidence: 0.9,
      message: `Possible secret detected by rule "${f.ruleId}". Remove it from the change and rotate the credential.${history}`,
    };
  }

  if (name === 'semgrep') {
    return {
      ...base,
      severity: f.level === 'error' ? 'high' : f.level === 'warning' ? 'medium' : 'low',
      confidence: semgrepConfidence(f.tags),
      message: f.message,
    };
  }

  return { ...base, severity: severityFromScore(f.securityScore), confidence: 0.95, message: f.message };
}

/** Run the scanners that apply to this change. Never throws. */
export function runScanners(opts: ScanRunOptions): ScanRunResult {
  const exec = opts.exec ?? defaultExec;
  const adapters = opts.adapters ?? DEFAULT_ADAPTERS;
  const report: ScannerReport = { ran: [], skipped: [] };
  const violations: Violation[] = [];

  let tmpDir: string | undefined;
  try {
    const ctx = buildContext(opts, exec);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-scan-'));
    const seen = new Set<string>();

    for (const adapter of adapters) {
      let result;
      try {
        result = adapter.run(ctx, exec, tmpDir);
      } catch (err) {
        result = { skipped: err instanceof Error ? err.message.split('\n')[0] : 'unexpected error' };
      }
      if (result === null) continue;
      if ('skipped' in result) {
        report.skipped.push({ name: adapter.name, reason: result.skipped });
        continue;
      }

      report.ran.push(adapter.name);
      for (const finding of result.findings) {
        const v = toViolation(adapter.name, finding, ctx.mode);
        const key = `${v.rule_id}|${v.file}|${v.line_start}|${v.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push(v);
      }
    }
  } catch (err) {
    report.skipped.push({ name: 'scanners', reason: err instanceof Error ? err.message.split('\n')[0] : 'unexpected error' });
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { violations, report };
}
