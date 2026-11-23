/**
 * Review runner — orchestrates the full guard pipeline:
 * build symbol diffs → enrich with call context → batch → call LLM → validate.
 */

import { loadRules, loadGuardConfig } from './rules-loader';
import { buildSymbolDiffs, buildSymbolDiffsFromDiff } from './symbol-diff';
import { enrichWithCallContext } from './call-context';
import { runLlmReview } from './provider';
import { verifyViolations } from './evidence-verifier';
import { runScanners } from './scanners';
import type { GuardResult, ReviewResponse, SymbolDiffUnit, Violation } from './types';

/** Maximum symbols to include in a single LLM call. */
const BATCH_SIZE = 15;

export interface RunOptions {
  /** Project root directory. */
  root: string;
  /** If provided, review this diff instead of staged files. */
  diffContent?: string;
  /** Skip cross-file caller/callee context (faster, cheaper). */
  diffOnly?: boolean;
  /** Skip symbol cache. */
  noCache?: boolean;
  /** Base ref the `diffContent` was measured from (for example `origin/main`). */
  baseRef?: string;
  /** Skip the deterministic scanners (gitleaks, semgrep, osv-scanner). */
  noScanners?: boolean;
}

/** Same threshold the LLM findings have always used: a confident high/critical finding fails the review. */
function isBlocking(v: Violation): boolean {
  return v.confidence >= 0.7 && (v.severity === 'high' || v.severity === 'critical');
}

/**
 * Run the full guard review pipeline.
 * Returns a GuardResult with violations, or throws with exit code 2 errors.
 */
export async function runGuardReview(options: RunOptions): Promise<GuardResult> {
  const { root, diffContent, baseRef, diffOnly = false, noScanners = false } = options;
  const started = Date.now();

  // 1. Load rules
  const rules = loadRules(root);

  // 2. Load provider config
  const config = loadGuardConfig(root);

  // 2b. Deterministic scanners. They run before the symbol check so a secret in a
  //     file with no parsed symbols (.env, a lockfile) is still scanned, and they
  //     skip the evidence check below because they have no quoted evidence.
  const scan = noScanners
    ? undefined
    : runScanners({ root, mode: diffContent ? 'range' : 'staged', diffText: diffContent, baseRef });
  const scannerViolations = scan?.violations ?? [];

  // 3. Build symbol-level diffs
  let units: SymbolDiffUnit[];
  if (diffContent) {
    units = buildSymbolDiffsFromDiff(root, diffContent);
  } else {
    units = buildSymbolDiffs(root);
  }

  if (units.length === 0) {
    return {
      response: {
        violations: scannerViolations,
        status: scannerViolations.some(isBlocking) ? 'fail' : 'pass',
        summary: scannerViolations.length > 0
          ? `${scannerViolations.length} violation(s) found by scanners.`
          : 'No staged changes with identifiable symbols to review.',
      },
      rulesUsed: rules,
      symbolsReviewed: 0,
      durationMs: Date.now() - started,
      scanners: scan?.report,
    };
  }

  // 4. Enrich with call context (unless --diff-only)
  if (!diffOnly) {
    units = enrichWithCallContext(units, root);
  }

  // 5. Batch and review
  const allViolations: ReviewResponse['violations'] = [];
  const batches = batchUnits(units, BATCH_SIZE);

  // Run batches concurrently (up to 3 in parallel)
  const CONCURRENCY = 3;
  try {
    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const chunk = batches.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((batch) => runLlmReview(config, rules, batch)),
      );
      for (const result of results) {
        allViolations.push(...result.violations);
      }
    }
  } catch (err) {
    // Exit code 2 (tool error) is non-blocking in the pre-commit hook, so an LLM
    // outage must not hide a blocking finding a scanner already made, such as a
    // leaked secret. Any other failure keeps its old behaviour and still throws.
    if (!scannerViolations.some(isBlocking)) throw err;
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return {
      response: {
        violations: scannerViolations,
        status: 'fail',
        summary: `${scannerViolations.length} violation(s) found by scanners. The LLM review did not complete: ${reason}`,
      },
      rulesUsed: rules,
      symbolsReviewed: units.length,
      durationMs: Date.now() - started,
      scanners: scan?.report,
    };
  }

  // 6. Verify each finding's quoted evidence against the file. Drop any whose
  //    quote is not in the code (hallucinated line, invented snippet).
  const verified = verifyViolations(root, allViolations)
    .map((v): Violation => ({ ...v, source: 'llm' }));

  // 7. Merge scanner findings and determine status.
  const all = [...verified, ...scannerViolations];
  const hasHighConfidenceFail = all.some(isBlocking);

  const response: ReviewResponse = {
    violations: all,
    status: hasHighConfidenceFail ? 'fail' : 'pass',
    summary: all.length === 0
      ? `All ${units.length} symbol(s) pass review.`
      : scannerViolations.length > 0
        ? `${all.length} violation(s) found (${scannerViolations.length} from scanners) across ${units.length} symbol(s).`
        : `${all.length} violation(s) found across ${units.length} symbol(s).`,
  };

  return {
    response,
    rulesUsed: rules,
    symbolsReviewed: units.length,
    durationMs: Date.now() - started,
    scanners: scan?.report,
  };
}

/** Split units into batches of the given size. */
function batchUnits(units: SymbolDiffUnit[], size: number): SymbolDiffUnit[][] {
  const batches: SymbolDiffUnit[][] = [];
  for (let i = 0; i < units.length; i += size) {
    batches.push(units.slice(i, i + size));
  }
  return batches;
}
