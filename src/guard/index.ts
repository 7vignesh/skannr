/**
 * Skannr Guard — entry point.
 * Reviews staged changes against team-defined rules using symbol-level analysis.
 */

import * as path from 'path';
import { runGuardReview } from './review-runner';
import { previewFixes, applyFixes, formatFixResults } from './fix-applier';
import { installHook, uninstallHook } from './hook-installer';
import { loadRules, loadGuardConfig } from './rules-loader';
import type { GuardResult, Violation } from './types';

export interface GuardCliOptions {
  root: string;
  fix?: boolean;
  dryRun?: boolean;
  prMode?: boolean;
  /** Base ref for --pr-mode (e.g. origin/develop). Implies prMode. */
  base?: string;
  diffOnly?: boolean;
  noCache?: boolean;
  json?: boolean;
}

/**
 * Run the guard review and return the result + exit code.
 * Exit codes: 0 = pass, 1 = fail (violations), 2 = tool error.
 */
export async function runGuard(options: GuardCliOptions): Promise<{ result: GuardResult; exitCode: number }> {
  const { root, fix = false, dryRun = false, prMode = false, base, diffOnly = false, noCache = false } = options;
  const absoluteRoot = path.resolve(root);

  // Get PR diff if in --pr-mode
  let diffContent: string | undefined;
  if (base !== undefined) {
    if (base === '' || base.startsWith('-')) {
      throw new Error(`Invalid --base ref: "${base}"`);
    }
    const { execFileSync } = await import('child_process');
    diffContent = execFileSync('git', ['diff', `${base}...HEAD`], {
      cwd: absoluteRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } else if (prMode) {
    const { execSync } = await import('child_process');
    try {
      diffContent = execSync('git diff origin/main...HEAD', {
        cwd: absoluteRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      diffContent = execSync('git diff main...HEAD', {
        cwd: absoluteRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    }
  }

  const result = await runGuardReview({
    root: absoluteRoot,
    diffContent,
    diffOnly,
    noCache,
  });

  // Handle --fix
  if (fix && result.response.violations.length > 0) {
    if (dryRun) {
      const previews = previewFixes(result.response.violations, absoluteRoot);
      const output = formatFixResults(previews, true);
      process.stdout.write(output + '\n');
    } else {
      const applied = applyFixes(result.response.violations, absoluteRoot);
      const output = formatFixResults(applied, false);
      process.stdout.write(output + '\n');
    }
  }

  const exitCode = result.response.status === 'fail' ? 1 : 0;
  return { result, exitCode };
}

/**
 * Format the guard result for terminal output.
 */
export function formatGuardText(result: GuardResult): string {
  const lines: string[] = [];
  const { response } = result;

  lines.push('');
  lines.push('  Skannr Guard');
  lines.push('  ' + '─'.repeat(50));
  lines.push('');
  lines.push(`  Status: ${response.status.toUpperCase()}`);
  lines.push(`  ${response.summary}`);
  lines.push(`  Reviewed ${result.symbolsReviewed} symbol(s) against ${result.rulesUsed.length} rule(s) in ${result.durationMs}ms`);
  lines.push('');

  if (response.violations.length > 0) {
    lines.push('  Violations:');
    lines.push('');

    for (const v of response.violations) {
      const fixTag = v.fixable ? ' [FIXABLE]' : '';
      const confTag = `(${Math.round(v.confidence * 100)}% confidence)`;
      lines.push(`    ${v.severity.toUpperCase()} ${v.file}:${v.line_start} ${confTag}${fixTag}`);
      lines.push(`      Rule: ${v.rule_id}`);
      lines.push(`      Symbol: ${v.symbol}`);
      lines.push(`      ${v.message}`);
      if (v.suggested_fix) {
        lines.push(`      Fix: ${v.suggested_fix}`);
      }
      lines.push('');
    }

    const fixableCount = response.violations.filter((v) => v.fixable).length;
    if (fixableCount > 0) {
      lines.push(`  ${fixableCount} violation(s) are auto-fixable. Run: skannr guard --fix`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format the guard result as JSON.
 */
export function formatGuardJson(result: GuardResult): string {
  return JSON.stringify({
    status: result.response.status,
    summary: result.response.summary,
    violations: result.response.violations,
    symbolsReviewed: result.symbolsReviewed,
    rulesUsed: result.rulesUsed.length,
    durationMs: result.durationMs,
  }, null, 2);
}

// Re-export for CLI/MCP wiring
export { installHook, uninstallHook } from './hook-installer';
export { loadRules, loadGuardConfig } from './rules-loader';
export type { GuardResult, Violation } from './types';
