/**
 * Evidence verification: drop violations whose quoted code does not appear in
 * the file. The LLM must return the exact line(s) it flags as `evidence`. A
 * deterministic check reads the staged file and confirms the quote is really
 * there. Fabricated findings (wrong line, invented code) are removed.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type { Violation } from './types';

/** Collapse runs of whitespace to a single space and trim, for tolerant matching. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Read a file as staged (index), falling back to the working tree. Returns
 * null when the file cannot be read. Cached per run via the provided map.
 */
function readStaged(root: string, file: string, cache: Map<string, string | null>): string | null {
  if (cache.has(file)) return cache.get(file)!;
  let content: string | null = null;
  try {
    content = execSync(`git show ":${file}"`, {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch {
    try {
      // Fall back to the working-tree file.
      content = fs.readFileSync(path.join(root, file), 'utf-8');
    } catch {
      content = null;
    }
  }
  cache.set(file, content);
  return content;
}

/** Result of verifying one violation. */
export interface VerifyOutcome {
  verified: boolean;
  reason?: string;
}

/**
 * Check one violation's evidence against file content. Pure given the content.
 * Exported for direct testing.
 */
export function verifyEvidence(
  violation: Pick<Violation, 'evidence' | 'line_start' | 'line_end'>,
  fileContent: string | null,
): VerifyOutcome {
  const evidence = (violation.evidence ?? '').trim();
  if (!evidence) return { verified: false, reason: 'no evidence quoted' };
  if (fileContent === null) return { verified: false, reason: 'file not readable' };

  const needle = normalize(evidence);
  if (!needle) return { verified: false, reason: 'evidence is whitespace only' };

  const lines = fileContent.split('\n');

  // First try the claimed line range (1-based, inclusive), with a small margin
  // for off-by-one line reports.
  const start = Math.max(1, (violation.line_start || 1) - 2);
  const end = Math.min(lines.length, (violation.line_end || violation.line_start || lines.length) + 2);
  if (end >= start) {
    const window = normalize(lines.slice(start - 1, end).join('\n'));
    if (window.includes(needle)) return { verified: true };
  }

  // Fall back to the whole file: a correct quote with a wrong line still counts,
  // but invented code does not appear anywhere and is dropped.
  const whole = normalize(fileContent);
  if (whole.includes(needle)) return { verified: true };

  return { verified: false, reason: 'quoted evidence not found in file' };
}

/**
 * Verify every violation against its file. Returns only the verified ones,
 * each marked `evidence_verified: true`. Reads each file at most once.
 */
export function verifyViolations(root: string, violations: Violation[]): Violation[] {
  const cache = new Map<string, string | null>();
  const kept: Violation[] = [];

  for (const v of violations) {
    const content = readStaged(root, v.file, cache);
    const outcome = verifyEvidence(v, content);
    if (outcome.verified) {
      kept.push({ ...v, evidence_verified: true });
    }
  }

  return kept;
}
