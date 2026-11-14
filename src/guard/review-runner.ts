/**
 * Review runner — orchestrates the full guard pipeline:
 * build symbol diffs → enrich with call context → batch → call LLM → validate.
 */

import { loadRules, loadGuardConfig } from './rules-loader';
import { buildSymbolDiffs, buildSymbolDiffsFromDiff } from './symbol-diff';
import { enrichWithCallContext } from './call-context';
import { runLlmReview } from './provider';
import { verifyViolations } from './evidence-verifier';
import type { GuardResult, ReviewResponse, SymbolDiffUnit } from './types';

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
}

/**
 * Run the full guard review pipeline.
 * Returns a GuardResult with violations, or throws with exit code 2 errors.
 */
export async function runGuardReview(options: RunOptions): Promise<GuardResult> {
  const { root, diffContent, diffOnly = false } = options;
  const started = Date.now();

  // 1. Load rules
  const rules = loadRules(root);

  // 2. Load provider config
  const config = loadGuardConfig(root);

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
        violations: [],
        status: 'pass',
        summary: 'No staged changes with identifiable symbols to review.',
      },
      rulesUsed: rules,
      symbolsReviewed: 0,
      durationMs: Date.now() - started,
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
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((batch) => runLlmReview(config, rules, batch)),
    );
    for (const result of results) {
      allViolations.push(...result.violations);
    }
  }

  // 6. Verify each finding's quoted evidence against the file. Drop any whose
  //    quote is not in the code (hallucinated line, invented snippet).
  const verified = verifyViolations(root, allViolations);

  // 7. Determine status from verified violations only.
  const hasHighConfidenceFail = verified.some(
    (v) => v.confidence >= 0.7 && (v.severity === 'high' || v.severity === 'critical'),
  );

  const response: ReviewResponse = {
    violations: verified,
    status: hasHighConfidenceFail ? 'fail' : 'pass',
    summary: verified.length === 0
      ? `All ${units.length} symbol(s) pass review.`
      : `${verified.length} violation(s) found across ${units.length} symbol(s).`,
  };

  return {
    response,
    rulesUsed: rules,
    symbolsReviewed: units.length,
    durationMs: Date.now() - started,
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
