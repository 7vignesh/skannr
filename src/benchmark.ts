/**
 * Benchmark script for code-analyzer
 * Runs against a repository root to measure token reduction.
 * Compares full-scan token cost vs skeletonized analysis across representative queries.
 */

import { analyzeProject } from './index';
import { scanTypeScriptFiles } from './scanner';
import { countTokens } from './tokenizer';
import * as path from 'path';
import * as fs from 'fs';

interface BenchmarkScenario {
  moduleKey: string;
  query: string;
  limit: number;
}

interface BenchmarkResult {
  projectName: string;
  projectRoot: string;
  query: string;
  // Baseline: what an LLM would consume reading ALL files
  allFilesCount: number;
  allFilesTotalTokens: number;
  // Our tool output
  analyzedFileCount: number;
  analyzedOriginalTokens: number;
  analyzedSkeletonTokens: number;
  tokenReductionVsFullScan: number;   // skeleton vs full-repo scan
  tokenReductionVsTopN: number;       // skeleton vs top-N original files
  top1KeywordCoverage: number;
  avgTopKKeywordCoverage: number;
  pathIntentMatchRate: number;
  directoryDiversity: number;
  enhancedRanking: boolean;
  executionTimeMs: number;
  topFiles: {
    path: string;
    score: number;
    originalTokens: number;
    skeletonTokens: number;
    reductionPct: number;
  }[];
}

function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length > 2);
}

function computeKeywordCoverage(pathValue: string, skeleton: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = `${pathValue} ${skeleton}`.toLowerCase();
  const hits = terms.filter(term => haystack.includes(term)).length;
  return hits / terms.length;
}

function computeRankingQuality(
  files: { path: string; skeleton: string }[],
  query: string
): {
  top1KeywordCoverage: number;
  avgTopKKeywordCoverage: number;
  pathIntentMatchRate: number;
  directoryDiversity: number;
} {
  if (files.length === 0) {
    return {
      top1KeywordCoverage: 0,
      avgTopKKeywordCoverage: 0,
      pathIntentMatchRate: 0,
      directoryDiversity: 0,
    };
  }

  const terms = extractQueryTerms(query);
  const topK = files.slice(0, Math.min(5, files.length));
  const coverages = topK.map(file => computeKeywordCoverage(file.path, file.skeleton, terms));

  const top1KeywordCoverage = coverages[0] ?? 0;
  const avgTopKKeywordCoverage = coverages.reduce((sum, value) => sum + value, 0) / topK.length;

  const pathIntentMatches = topK.filter(file =>
    terms.some(term => file.path.toLowerCase().includes(term))
  ).length;
  const pathIntentMatchRate = pathIntentMatches / topK.length;

  const uniqueDirs = new Set(
    topK.map(file => path.dirname(file.path).toLowerCase())
  );
  const directoryDiversity = uniqueDirs.size / topK.length;

  return {
    top1KeywordCoverage,
    avgTopKKeywordCoverage,
    pathIntentMatchRate,
    directoryDiversity,
  };
}

export const BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  { moduleKey: 'src', query: 'authentication flow and permission checks', limit: 10 },
  { moduleKey: 'lib', query: 'database connection management', limit: 10 },
  { moduleKey: 'packages', query: 'API endpoint and routing structure', limit: 10 },
];

/**
 * Read scenarios from a JSON file: `[{ "moduleKey": "src", "query": "...", "limit": 10 }]`.
 * `moduleKey` is a directory under the repo root; `limit` defaults to 10.
 */
export function loadScenarios(file: string): BenchmarkScenario[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot read scenarios file ${file}: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Scenarios file ${file} must be a non-empty JSON array`);
  }
  return parsed.map((raw, i) => {
    const s = raw as { moduleKey?: unknown; query?: unknown; limit?: unknown };
    if (typeof s.moduleKey !== 'string' || s.moduleKey.trim() === '') {
      throw new Error(`Scenario ${i + 1} in ${file}: "moduleKey" must be a non-empty string`);
    }
    if (typeof s.query !== 'string' || s.query.trim() === '') {
      throw new Error(`Scenario ${i + 1} in ${file}: "query" must be a non-empty string`);
    }
    if (s.limit !== undefined && (!Number.isInteger(s.limit) || (s.limit as number) < 1)) {
      throw new Error(`Scenario ${i + 1} in ${file}: "limit" must be a positive integer`);
    }
    return { moduleKey: s.moduleKey, query: s.query, limit: (s.limit as number | undefined) ?? 10 };
  });
}

/** Value of `--scenarios <file>` in `argv`, if present. */
function scenariosFileFromArgs(argv: string[]): string | undefined {
  const at = argv.indexOf('--scenarios');
  if (at === -1) return undefined;
  const file = argv[at + 1];
  if (!file || file.startsWith('--')) throw new Error('--scenarios needs a file path');
  return file;
}

/**
 * Quickly sum tokens across all .ts/.tsx files in a directory.
 * Uses a capped sample to stay fast, then extrapolates.
 */
function sampleDirectoryTokens(
  rootPath: string,
  maxFiles = 50
): { fileCount: number; totalTokens: number; isSampled: boolean } {
  const allFiles = scanTypeScriptFiles(rootPath);
  const isSampled = allFiles.length > maxFiles;
  const filesToRead = isSampled ? allFiles.slice(0, maxFiles) : allFiles;

  let totalTokens = 0;
  for (const f of filesToRead) {
    try {
      const content = fs.readFileSync(f, 'utf-8');
      totalTokens += countTokens(content);
    } catch {
      // skip unreadable
    }
  }

  const estimatedTotal = isSampled
    ? Math.round((totalTokens / filesToRead.length) * allFiles.length)
    : totalTokens;

  return { fileCount: allFiles.length, totalTokens: estimatedTotal, isSampled };
}

/**
 * Run a single benchmark scenario
 */
async function benchmarkProject(
  appRoot: string,
  moduleKey: string,
  projectName: string,
  query: string,
  options: { limit?: number; enhancedRanking?: boolean } = {}
): Promise<BenchmarkResult> {
  const limit = options.limit ?? 10;
  const moduleFullPath = fs.existsSync(path.join(appRoot, moduleKey))
    ? path.join(appRoot, moduleKey)
    : appRoot;

  // Baseline: estimate full-module token cost (what we are comparing against)
  const baseline = sampleDirectoryTokens(moduleFullPath, 200);

  const start = Date.now();
  const result = await analyzeProject({
    root: appRoot,
    question: query,
    limit,
    enhancedRanking: options.enhancedRanking ?? true,
    moduleKeys: [moduleKey],
    generateMapping: false,
  });
  const executionTimeMs = Date.now() - start;

  let analyzedOriginal = 0;
  let analyzedSkeleton = 0;

  const topFiles = result.files.map(f => {
    analyzedOriginal += f.originalTokenCount;
    analyzedSkeleton += f.skeletonTokenCount;
    return {
      path: f.path,
      score: f.score,
      originalTokens: f.originalTokenCount,
      skeletonTokens: f.skeletonTokenCount,
      reductionPct:
        f.originalTokenCount > 0
          ? ((f.originalTokenCount - f.skeletonTokenCount) / f.originalTokenCount) * 100
          : 0,
    };
  });

  const tokenReductionVsFullScan =
    baseline.totalTokens > 0
      ? ((baseline.totalTokens - analyzedSkeleton) / baseline.totalTokens) * 100
      : 0;

  const tokenReductionVsTopN =
    analyzedOriginal > 0
      ? ((analyzedOriginal - analyzedSkeleton) / analyzedOriginal) * 100
      : 0;

  const rankingQuality = computeRankingQuality(
    result.files.map(file => ({ path: file.path, skeleton: file.skeleton })),
    query
  );

  return {
    projectName,
    projectRoot: moduleFullPath,
    query,
    allFilesCount: baseline.fileCount,
    allFilesTotalTokens: baseline.totalTokens,
    analyzedFileCount: result.files.length,
    analyzedOriginalTokens: analyzedOriginal,
    analyzedSkeletonTokens: analyzedSkeleton,
    tokenReductionVsFullScan,
    tokenReductionVsTopN,
    top1KeywordCoverage: rankingQuality.top1KeywordCoverage,
    avgTopKKeywordCoverage: rankingQuality.avgTopKKeywordCoverage,
    pathIntentMatchRate: rankingQuality.pathIntentMatchRate,
    directoryDiversity: rankingQuality.directoryDiversity,
    enhancedRanking: options.enhancedRanking ?? true,
    executionTimeMs,
    topFiles,
  };
}

/**
 * Format results for console output
 */
function formatResults(results: BenchmarkResult[]): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════════════');
  lines.push('          CODE ANALYZER BENCHMARK — Generic Repository');
  lines.push('═══════════════════════════════════════════════════════════════════════\n');

  for (const r of results) {
    lines.push(`\n📊  ${r.projectName}`);
    lines.push(`    Query: "${r.query}"`);
    lines.push('');
    lines.push(`    🗂  Repository Baseline (naive full-scan):`);
    lines.push(`        Total .ts/.tsx files : ${r.allFilesCount.toLocaleString()}`);
    lines.push(`        Estimated tokens     : ${r.allFilesTotalTokens.toLocaleString()}`);
    lines.push('');
    lines.push(`    ⚙️  Our Tool (top ${r.analyzedFileCount} files, enhanced ranking: ${r.enhancedRanking ? '✓' : '✗'}):`);
    lines.push(`        Original tokens sent : ${r.analyzedOriginalTokens.toLocaleString()}`);
    lines.push(`        Skeleton tokens sent : ${r.analyzedSkeletonTokens.toLocaleString()}`);
    lines.push(`        Reduction vs full scan  : ${r.tokenReductionVsFullScan.toFixed(1)}% ⬇️`);
    lines.push(`        Reduction vs top-N raw  : ${r.tokenReductionVsTopN.toFixed(1)}% ⬇️`);
    lines.push(`        Top-1 keyword coverage  : ${(r.top1KeywordCoverage * 100).toFixed(1)}%`);
    lines.push(`        Avg top-K coverage      : ${(r.avgTopKKeywordCoverage * 100).toFixed(1)}%`);
    lines.push(`        Path intent match rate  : ${(r.pathIntentMatchRate * 100).toFixed(1)}%`);
    lines.push(`        Directory diversity     : ${(r.directoryDiversity * 100).toFixed(1)}%`);
    lines.push(`        Execution time          : ${r.executionTimeMs}ms`);
    lines.push('');
    lines.push(`    📁  Top Ranked Files:`);
    for (let i = 0; i < Math.min(5, r.topFiles.length); i++) {
      const f = r.topFiles[i];
      lines.push(
        `        ${i + 1}. ${f.path}`
      );
      lines.push(
        `           Score: ${f.score.toFixed(3)}  |  ${f.originalTokens} → ${f.skeletonTokens} tokens  (${f.reductionPct.toFixed(1)}% ⬇️)`
      );
    }
    lines.push('');
    lines.push('───────────────────────────────────────────────────────────────────────');
  }

  // Summary
  const avgReductionFullScan =
    results.reduce((s, r) => s + r.tokenReductionVsFullScan, 0) / results.length;
  const avgReductionTopN =
    results.reduce((s, r) => s + r.tokenReductionVsTopN, 0) / results.length;
  const avgTop1Coverage =
    results.reduce((s, r) => s + r.top1KeywordCoverage, 0) / results.length;
  const avgTopKCoverage =
    results.reduce((s, r) => s + r.avgTopKKeywordCoverage, 0) / results.length;
  const avgPathIntentMatch =
    results.reduce((s, r) => s + r.pathIntentMatchRate, 0) / results.length;
  const avgTime =
    results.reduce((s, r) => s + r.executionTimeMs, 0) / results.length;

  lines.push('\n📊  SUMMARY');
  lines.push('───────────────────────────────────────────────────────────────────────');
  lines.push(`    Benchmarks run               : ${results.length}`);
  lines.push(`    Avg reduction vs full scan   : ${avgReductionFullScan.toFixed(1)}%`);
  lines.push(`    Avg reduction vs top-N raw   : ${avgReductionTopN.toFixed(1)}%`);
  lines.push(`    Avg top-1 coverage           : ${(avgTop1Coverage * 100).toFixed(1)}%`);
  lines.push(`    Avg top-K coverage           : ${(avgTopKCoverage * 100).toFixed(1)}%`);
  lines.push(`    Avg path intent match rate   : ${(avgPathIntentMatch * 100).toFixed(1)}%`);
  lines.push(`    Avg execution time           : ${avgTime.toFixed(0)}ms`);
  lines.push('═══════════════════════════════════════════════════════════════════════\n');

  return lines.join('\n');
}

/**
 * Save benchmark output to JSON
 */
function saveResults(results: BenchmarkResult[], outputPath: string): void {
  const out = {
    generatedAt: new Date().toISOString(),
    root: results[0]?.projectRoot ?? '',
    summary: {
      avgReductionVsFullScan:
        results.reduce((s, r) => s + r.tokenReductionVsFullScan, 0) / results.length,
      avgReductionVsTopN:
        results.reduce((s, r) => s + r.tokenReductionVsTopN, 0) / results.length,
      avgTop1KeywordCoverage:
        results.reduce((s, r) => s + r.top1KeywordCoverage, 0) / results.length,
      avgTopKKeywordCoverage:
        results.reduce((s, r) => s + r.avgTopKKeywordCoverage, 0) / results.length,
      avgPathIntentMatchRate:
        results.reduce((s, r) => s + r.pathIntentMatchRate, 0) / results.length,
      avgExecutionTimeMs:
        results.reduce((s, r) => s + r.executionTimeMs, 0) / results.length,
    },
    benchmarks: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2), 'utf-8');
  console.log(`\n✅  Results saved → ${outputPath}`);
}

/**
 * Main entry point
 */
async function runBenchmarks(): Promise<void> {
  const repoRoot = process.cwd();
  const scenariosFile = scenariosFileFromArgs(process.argv.slice(2));
  const scenarios = scenariosFile ? loadScenarios(scenariosFile) : BENCHMARK_SCENARIOS;

  // Verify repo exists
  if (!fs.existsSync(repoRoot)) {
    console.error(`❌  Repository not found at ${repoRoot}`);
    process.exit(1);
  }

  const appRoot = repoRoot;
  console.log('🚀  Code Analyzer — Generic Repository Benchmarks\n');
  console.log(`    Repo : ${repoRoot}`);
  console.log('    Computing baseline (first 50 files sample)...');
  const fullBaseline = sampleDirectoryTokens(appRoot, 50);
  console.log(`    Baseline → ${fullBaseline.fileCount} .ts files, ` +
    `~${fullBaseline.totalTokens.toLocaleString()} tokens (${fullBaseline.isSampled ? 'extrapolated' : 'exact'})\n`);

  const results: BenchmarkResult[] = [];

  let i = 1;
  for (const scenario of scenarios) {
    console.log(`▶  [${i}/${scenarios.length}] ${scenario.query} (${scenario.moduleKey})`);
    results.push(await benchmarkProject(
      repoRoot,
      scenario.moduleKey,
      `Repo › ${scenario.moduleKey}`,
      scenario.query,
      { limit: scenario.limit, enhancedRanking: true }
    ));
    console.log(`   ✓ ${results.at(-1)!.executionTimeMs}ms\n`);
    i++;
  }

  // ── Output ────────────────────────────────────────────────────────────────────
  console.log(formatResults(results));

  // Append full-app baseline note to the formatted output
  console.log(`ℹ️  Full app/ baseline (naive full-scan):`);
  console.log(`    ${fullBaseline.fileCount} files  →  ~${fullBaseline.totalTokens.toLocaleString()} tokens`);
  console.log(`    vs our tool avg skeleton: ~${Math.round(results.reduce((s, r) => s + r.analyzedSkeletonTokens, 0) / results.length).toLocaleString()} tokens per query\n`);

  const outputPath = path.join(__dirname, '..', 'benchmark-results.json');
  // Attach baseline to JSON output
  const extendedResults = {
    fullAppBaseline: {
      root: appRoot,
      fileCount: fullBaseline.fileCount,
      estimatedTotalTokens: fullBaseline.totalTokens,
      isSampled: fullBaseline.isSampled,
    },
    benchmarks: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(extendedResults, null, 2), 'utf-8');
  console.log(`✅  Saved → ${outputPath}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  runBenchmarks()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌  Benchmark failed:', err);
      process.exit(1);
    });
}

export { benchmarkProject, formatResults, saveResults };
