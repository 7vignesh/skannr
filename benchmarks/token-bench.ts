/**
 * Token and latency benchmark for skannr's AST skeletons.
 *
 * For each target directory it discovers the TypeScript files once, then
 * measures the same file list two ways:
 *   - raw: the source text, counted with the o200k_base tokenizer
 *   - skeleton: buildSkeletonForFile() output for each file, counted the same way
 * plus the median wall-clock time to build all skeletons.
 *
 * Nothing here is estimated except the dollar figure, which applies an assumed
 * reference rate to the measured token counts.
 *
 * Usage: npm run bench:tokens [-- --targets dirA,dirB,dirC]
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { performance } from 'perf_hooks';
import { countTokens } from 'gpt-tokenizer';
import { buildSkeletonForFile } from '../src/skeletonizer';

/** Assumed price of one million input tokens. A reference rate, not a measurement. */
export const ASSUMED_USD_PER_1M_INPUT_TOKENS = 2.5;

/** Directory names skipped at any depth below a target root. */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git', '.next']);

export const DEFAULT_WARMUP_RUNS = 1;
export const DEFAULT_TIMED_RUNS = 5;

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, '.fixtures');
const RESULTS_FILE = path.join(__dirname, 'results', 'token-bench.json');

/** A third-party repository pinned to one commit, cloned on demand. */
export interface FixtureSpec {
  name: string;
  url: string;
  sha: string;
  /** Directory inside the clone that is measured. */
  subdir: string;
}

export const TRPC_FIXTURE: FixtureSpec = {
  name: 'trpc',
  url: 'https://github.com/trpc/trpc.git',
  sha: '8405090580983cc54b9fe4b062f6fc39e4e9549c',
  subdir: 'packages/server/src',
};

export interface TargetSpec {
  label: string;
  root: string;
}

export type SkeletonFn = (file: string, rootDir: string) => string;

export interface MeasureOptions {
  warmup: number;
  runs: number;
  skeletonFn: SkeletonFn;
  /** Monotonic clock in milliseconds. */
  now: () => number;
  countTokens: (text: string) => number;
}

export interface TargetResult {
  label: string;
  /** Path relative to the repository root, or the directory name if outside it. */
  path: string;
  files: number;
  lines: number;
  rawChars: number;
  rawTokens: number;
  rawSha256: string;
  skeletonChars: number;
  skeletonTokens: number;
  /** Percent of raw tokens removed. Negative when the skeleton is larger. Null when raw is empty. */
  reductionPct: number | null;
  /** USD saved on one query's input at the assumed rate. Negative when the skeleton is larger. */
  costSavedUsd: number;
  latency: {
    warmupRuns: number;
    timedRuns: number;
    runsMs: number[];
    medianMs: number;
    medianPerFileMs: number;
  };
  /** Files whose skeleton is the "Failed to parse" placeholder. */
  parseFailures: number;
  /** True when every timed run produced byte-identical skeletons. */
  skeletonStable: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Plain code-unit comparison, so the order does not depend on the locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * List the `.ts` and `.tsx` files under `root`, sorted by relative path.
 * Skips `*.d.ts`, the directories in EXCLUDED_DIRS at any depth, and symlinks.
 * The root itself is never excluded by name.
 */
export function discoverFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        const isTs = entry.name.endsWith('.ts') || entry.name.endsWith('.tsx');
        if (isTs && !entry.name.endsWith('.d.ts')) found.push(full);
      }
    }
  };

  walk(root);
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join('/');
  return found.sort((a, b) => byCodeUnit(rel(a), rel(b)));
}

/** Median of a non-empty list. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Percent of `raw` removed by `skeleton`. Negative when the skeleton is larger. Null when raw is 0. */
export function reductionPct(raw: number, skeleton: number): number | null {
  if (raw === 0) return null;
  return ((raw - skeleton) / raw) * 100;
}

/** USD saved on one query when sending the skeleton instead of the raw source. */
export function costSavedUsd(
  rawTokens: number,
  skeletonTokens: number,
  usdPerMillion: number = ASSUMED_USD_PER_1M_INPUT_TOKENS,
): number {
  return ((rawTokens - skeletonTokens) / 1_000_000) * usdPerMillion;
}

/** Normalize CRLF to LF so line endings (a checkout setting) do not change token counts. */
export function normalizeEol(text: string): string {
  return text.split('\r\n').join('\n');
}

/** Number of physical lines: newline-terminated lines plus a final unterminated one. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/** Token count that treats special-token text such as `<|endoftext|>` as ordinary source. */
export function countSourceTokens(text: string): number {
  return countTokens(text, { disallowedSpecial: new Set<string>() });
}

export interface CliArgs {
  targets?: string[];
  help: boolean;
}

/** Parse `--targets a,b,c` (or `--targets=a,b,c`). Throws a readable error on bad input. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--targets' || arg.startsWith('--targets=')) {
      const value = arg === '--targets' ? argv[++i] : arg.slice('--targets='.length);
      if (value === undefined || value.startsWith('--')) throw new Error('--targets needs a comma-separated list of directories');
      const list = value.split(',').map((t) => t.trim()).filter((t) => t !== '');
      if (list.length === 0) throw new Error('--targets needs at least one directory');
      args.targets = list;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Measure one target. The same sorted file list feeds the raw and the skeleton pass. */
export function measureTarget(spec: TargetSpec, opts: MeasureOptions): TargetResult {
  if (opts.runs < 1) throw new Error('at least one timed run is required');
  const root = path.resolve(spec.root);
  const files = discoverFiles(root);
  if (files.length === 0) throw new Error(`No .ts or .tsx files found under ${spec.root}`);

  const rawTexts = files.map((f) => normalizeEol(fs.readFileSync(f, 'utf-8')));
  const raw = rawTexts.join('\n');

  const runPass = (): string[] => files.map((f) => opts.skeletonFn(f, root));

  let firstOutputs: string[] | undefined;
  for (let i = 0; i < opts.warmup; i++) {
    const out = runPass();
    firstOutputs ??= out;
  }

  const runsMs: number[] = [];
  let stable = true;
  for (let i = 0; i < opts.runs; i++) {
    const t0 = opts.now();
    const out = runPass();
    const t1 = opts.now();
    runsMs.push(t1 - t0);
    if (firstOutputs === undefined) {
      firstOutputs = out;
    } else if (out.length !== firstOutputs.length || out.some((s, k) => s !== firstOutputs![k])) {
      stable = false;
    }
  }

  const skeletons = (firstOutputs ?? []).map(normalizeEol);
  const skeleton = skeletons.join('\n');
  const rawTokens = opts.countTokens(raw);
  const skeletonTokens = opts.countTokens(skeleton);
  const medianMs = median(runsMs);

  const relToRepo = path.relative(REPO_ROOT, root).split(path.sep).join('/');
  const portablePath = relToRepo === '' || relToRepo.startsWith('..') ? path.basename(root) : relToRepo;

  return {
    label: spec.label,
    path: portablePath,
    files: files.length,
    lines: rawTexts.reduce((sum, t) => sum + countLines(t), 0),
    rawChars: raw.length,
    rawTokens,
    rawSha256: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    skeletonChars: skeleton.length,
    skeletonTokens,
    reductionPct: reductionPct(rawTokens, skeletonTokens),
    costSavedUsd: costSavedUsd(rawTokens, skeletonTokens),
    latency: {
      warmupRuns: opts.warmup,
      timedRuns: opts.runs,
      runsMs,
      medianMs,
      medianPerFileMs: medianMs / files.length,
    },
    parseFailures: skeletons.filter((s) => s.startsWith('/* Failed to parse')).length,
    skeletonStable: stable,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat('en-US');
const fmtInt = (n: number): string => nf.format(n);
const fmtMs = (n: number): string => nf.format(Math.round(n));

function fmtPct(p: number | null): string {
  return p === null ? 'n/a' : `${p.toFixed(1)}%`;
}

function fmtUsd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(4)}`;
}

/** Render results as a Markdown table followed by the two caveats a reader needs. */
export function renderMarkdown(results: TargetResult[]): string {
  const lines = [
    '| Target | Files | Lines | Raw tokens | Skeleton tokens | Token reduction | Input cost saved per query* | Median skeleton time (ms) | Per file (ms) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.label} | ${fmtInt(r.files)} | ${fmtInt(r.lines)} | ${fmtInt(r.rawTokens)} | ${fmtInt(r.skeletonTokens)} | ${fmtPct(r.reductionPct)} | ${fmtUsd(r.costSavedUsd)} | ${fmtMs(r.latency.medianMs)} | ${fmtMs(r.latency.medianPerFileMs)} |`,
    );
  }
  lines.push('');
  lines.push(
    `\\* Assumed reference rate of $${ASSUMED_USD_PER_1M_INPUT_TOKENS.toFixed(2)} per 1M input tokens, applied to the measured token counts. It is not a measured price.`,
  );
  lines.push(
    'Tokens: o200k_base (gpt-tokenizer). Time: median of the timed runs for building every skeleton in the target, including reading the files.',
  );
  const failures = results.filter((r) => r.parseFailures > 0);
  for (const r of failures) {
    lines.push(`Warning: ${r.label} has ${r.parseFailures} file(s) that failed to parse; their skeleton is a placeholder.`);
  }
  const unstable = results.filter((r) => !r.skeletonStable);
  for (const r of unstable) {
    lines.push(`Warning: ${r.label} produced different skeletons between runs.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { ok: !r.error && r.status === 0, out: (r.stdout ?? '').trim(), err: ((r.stderr ?? '') + (r.error?.message ?? '')).trim() };
}

/**
 * Make sure `spec` is cloned at its pinned commit under `fixturesDir`, and return its path.
 * Fetches that one commit with depth 1. Refuses to measure a clone at any other commit.
 */
export function ensureFixture(spec: FixtureSpec, fixturesDir: string = FIXTURES_DIR): string {
  const dir = path.join(fixturesDir, spec.name);

  if (fs.existsSync(path.join(dir, '.git'))) {
    const head = git(dir, ['rev-parse', 'HEAD']);
    if (!head.ok || head.out !== spec.sha) {
      throw new Error(
        `${dir} is at ${head.ok ? head.out : 'an unknown commit'}, expected ${spec.sha}. Delete that directory to re-clone, or pass --targets.`,
      );
    }
    return dir;
  }

  process.stderr.write(`Cloning ${spec.url} at ${spec.sha.slice(0, 7)} into ${dir} ...\n`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const steps: string[][] = [
      ['init', '-q'],
      ['remote', 'add', 'origin', spec.url],
      ['-c', 'core.autocrlf=false', 'fetch', '-q', '--depth', '1', 'origin', spec.sha],
      ['-c', 'core.autocrlf=false', 'checkout', '-q', '--detach', 'FETCH_HEAD'],
    ];
    for (const step of steps) {
      const r = git(dir, step);
      if (!r.ok) throw new Error(`git ${step.join(' ')} failed: ${r.err || 'unknown error'}`);
    }
    const head = git(dir, ['rev-parse', 'HEAD']);
    if (!head.ok || head.out !== spec.sha) throw new Error(`cloned ${head.out}, expected ${spec.sha}`);
    return dir;
  } catch (err) {
    // Remove only the directory created above, and only if it is inside the fixtures directory.
    const inside = path.resolve(dir).startsWith(path.resolve(fixturesDir) + path.sep);
    if (inside) fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Could not fetch fixture ${spec.name}: ${err instanceof Error ? err.message : err}. Pass --targets to measure directories you already have.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function defaultTargets(): TargetSpec[] {
  const fixture = ensureFixture(TRPC_FIXTURE);
  return [
    { label: 'skannr `src/guard` (small)', root: path.join(REPO_ROOT, 'src', 'guard') },
    { label: 'skannr `src` (medium)', root: path.join(REPO_ROOT, 'src') },
    {
      label: `trpc/trpc \`${TRPC_FIXTURE.subdir}\` @${TRPC_FIXTURE.sha.slice(0, 7)} (large)`,
      root: path.join(fixture, TRPC_FIXTURE.subdir),
    },
  ];
}

function describeEnvironment(): Record<string, unknown> {
  const head = git(REPO_ROOT, ['rev-parse', 'HEAD']);
  const dirty = git(REPO_ROOT, ['status', '--porcelain', '--', 'src']);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tokenizerVersion: string = require('gpt-tokenizer/package.json').version;
  return {
    generatedAt: new Date().toISOString(),
    skannrCommit: head.ok ? head.out : 'unknown',
    skannrSourceModified: dirty.ok ? dirty.out !== '' : null,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    cpuThreads: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1024 ** 3),
    tokenizer: { package: 'gpt-tokenizer', version: tokenizerVersion, encoding: 'o200k_base' },
    assumedUsdPer1MInputTokens: ASSUMED_USD_PER_1M_INPUT_TOKENS,
    skeletonCall: 'buildSkeletonForFile(file, targetRoot)',
    lineEndings: 'CRLF normalized to LF before counting, for raw and skeleton alike',
  };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\nUsage: npm run bench:tokens -- [--targets dirA,dirB,dirC]\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(
      'Usage: npm run bench:tokens -- [--targets dirA,dirB,dirC]\n' +
        'Without --targets: skannr src/guard, skannr src, and a pinned trpc/trpc clone in benchmarks/.fixtures/.\n',
    );
    return 0;
  }

  let targets: TargetSpec[];
  try {
    if (args.targets) {
      targets = args.targets.map((t) => {
        const root = path.resolve(t);
        if (!fs.existsSync(root)) throw new Error(`Target not found: ${t}`);
        if (!fs.statSync(root).isDirectory()) throw new Error(`Target is not a directory: ${t}`);
        return { label: t, root };
      });
    } else {
      targets = defaultTargets();
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    return 1;
  }

  const opts: MeasureOptions = {
    warmup: DEFAULT_WARMUP_RUNS,
    runs: DEFAULT_TIMED_RUNS,
    skeletonFn: (file, rootDir) => buildSkeletonForFile(file, rootDir).skeleton,
    now: () => performance.now(),
    countTokens: countSourceTokens,
  };

  const results: TargetResult[] = [];
  try {
    for (const spec of targets) {
      process.stderr.write(`Measuring ${spec.label} (${opts.warmup} warmup + ${opts.runs} timed passes) ...\n`);
      results.push(measureTarget(spec, opts));
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    return 1;
  }

  process.stdout.write(renderMarkdown(results) + '\n');
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ schemaVersion: 1, environment: describeEnvironment(), results }, null, 2) + '\n');
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, RESULTS_FILE).split(path.sep).join('/')}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}
