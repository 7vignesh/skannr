/**
 * Markdown formatter for the skannr GitHub Action.
 *
 * Turns `skannr guard --json` output into a job summary / PR comment.
 * Violation text comes from an LLM reviewing untrusted PR code, so every
 * value is escaped before it is placed in markdown.
 *
 * Usage: node dist/action-summary.js <report.json>
 */

import * as fs from 'fs';

/** Hidden marker used to find and update the action's PR comment. */
export const COMMENT_MARKER = '<!-- skannr-guard -->';

/** Max table rows, keeps the comment well under GitHub's 65536-char limit. */
const MAX_ROWS = 50;
/** Max characters of a single message cell. */
const MAX_MESSAGE = 300;

interface ReportViolation {
  rule_id: string;
  file: string;
  line_start: number;
  severity: string;
  confidence: number;
  message: string;
}

export interface GuardReport {
  status: 'pass' | 'fail';
  summary: string;
  violations: ReportViolation[];
  symbolsReviewed: number;
  rulesUsed: number;
  durationMs: number;
}

/**
 * Escape a value for a markdown table cell: strip newlines, neutralize HTML,
 * pipes, and @mentions.
 */
export function escapeCell(value: unknown): string {
  return String(value)
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/@/g, '@\u200b');
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 3) + '...' : value;
}

/** Render a guard report as markdown. */
export function formatGuardMarkdown(report: GuardReport): string {
  const lines: string[] = [
    COMMENT_MARKER,
    `### Skannr Guard: ${report.status.toUpperCase()}`,
    '',
    `${escapeCell(report.summary)} Reviewed ${report.symbolsReviewed} symbol(s) against ${report.rulesUsed} rule(s) in ${report.durationMs}ms.`,
  ];

  if (report.violations.length > 0) {
    lines.push('', '| Severity | Location | Rule | Confidence | Message |', '|---|---|---|---|---|');
    for (const v of report.violations.slice(0, MAX_ROWS)) {
      lines.push(
        `| ${escapeCell(v.severity)} | ${escapeCell(`${v.file}:${v.line_start}`)} | ${escapeCell(v.rule_id)} | ${Math.round(v.confidence * 100)}% | ${escapeCell(truncate(v.message, MAX_MESSAGE))} |`,
      );
    }
    if (report.violations.length > MAX_ROWS) {
      lines.push('', `${report.violations.length - MAX_ROWS} more violation(s) not shown. See the report artifact.`);
    }
  }

  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    process.stderr.write('Usage: action-summary <report.json>\n');
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as GuardReport;
  process.stdout.write(formatGuardMarkdown(report));
}
