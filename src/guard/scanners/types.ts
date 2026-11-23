/**
 * Shared types for the deterministic scanner adapters (gitleaks, semgrep,
 * osv-scanner).
 */

import type { ViolationSource } from '../types';

export type ScannerName = Exclude<ViolationSource, 'llm'>;

/** What is being reviewed: the git index, or the commits between a base and HEAD. */
export interface ScanContext {
  root: string;
  mode: 'staged' | 'range';
  /** Revision the change is measured from: `HEAD` when staged, the merge-base in range mode. */
  baseRev?: string;
  /** Non-deleted files in the change (repo-relative, forward slashes). */
  changedFiles: string[];
  /** Added line numbers (in the new file) per changed file. */
  addedLines: Map<string, Set<number>>;
  /** Content of a changed file as reviewed (index when staged, HEAD in range mode); null if unreadable. */
  readChanged(file: string): string | null;
}

/** A scanner result before it is converted to a guard violation. */
export interface RawFinding {
  ruleId: string;
  message: string;
  /** Repo-relative path with forward slashes. */
  file: string;
  line: number;
  endLine: number;
  level: string;
  /** CVSS-style score from `security-severity`, when the tool provides one. */
  securityScore?: number;
  tags: string[];
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

/** Runs a program without a shell. Injected so tests never need real binaries. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => ExecResult;

export type AdapterResult = { findings: RawFinding[] } | { skipped: string };

export interface ScannerAdapter {
  name: ScannerName;
  /** Returns null when the scanner does not apply to this change. */
  run(ctx: ScanContext, exec: ExecFn, tmpDir: string): AdapterResult | null;
}
