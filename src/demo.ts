/**
 * `skannr demo`: build a throwaway repo with a planted bug and run guard on it.
 *
 * Lets a user see a real review in seconds without pointing skannr at their own
 * code. The temp repo is always cleaned up. If no LLM provider is available,
 * a clearly-labelled sample review is shown so the demo never dead-ends.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { runGuardReview } from './guard/review-runner';
import { formatGuardText } from './guard/index';
import type { GuardResult } from './guard/types';

/** A file written into the demo repo. */
interface DemoFile {
  relPath: string;
  /** Committed baseline content (clean). */
  baseline: string;
  /** Staged content with the planted bug. */
  changed: string;
}

/**
 * The planted change: `config.ts` starts clean, then a hardcoded secret is
 * added. This triggers the built-in `no-hardcoded-secrets` rule.
 */
const DEMO_FILES: DemoFile[] = [
  {
    relPath: 'src/config.ts',
    baseline: [
      'function readApiKey(): string {',
      '  return process.env.API_KEY ?? "";',
      '}',
      '',
      'module.exports = { readApiKey };',
      '',
    ].join('\n'),
    changed: [
      'function readApiKey(): string {',
      '  // Planted bug: hardcoded secret instead of env var',
      '  return "sk-live-9fK2m7Qx8vT4nR1pLz0wYbHcEaDgJsU";',
      '}',
      '',
      'module.exports = { readApiKey };',
      '',
    ].join('\n'),
  },
];

/** The canned sample shown when no provider is available. */
function sampleReview(): string {
  return [
    '',
    '  skannr guard  (SAMPLE - no LLM provider detected)',
    '  ' + '-'.repeat(50),
    '',
    '  Status: FAIL',
    '  1 violation(s) found across 1 symbol(s).',
    '',
    '  Violations:',
    '',
    '    CRITICAL src/config.ts:3 (95% confidence)',
    '      Rule: no-hardcoded-secrets',
    '      Symbol: readApiKey',
    '      Hardcoded API key returned directly. Use an environment variable.',
    '',
    '  This is a sample. Install a provider (claude, gemini, kiro, or ollama)',
    '  and run `skannr guard` for a real review.',
    '',
  ].join('\n');
}

/** Run a git command in the demo repo, swallowing output. */
function git(repo: string, args: string): void {
  execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
}

/**
 * Create a temp git repo, commit the clean baseline, then stage the planted
 * change. Returns the repo path.
 */
export function buildDemoRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-demo-'));

  git(repo, 'init');
  // Local identity so commits work without global git config.
  git(repo, 'config user.email demo@skannr.local');
  git(repo, 'config user.name skannr-demo');
  git(repo, 'config commit.gpgsign false');

  // Write + commit clean baseline.
  for (const f of DEMO_FILES) {
    const full = path.join(repo, f.relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.baseline, 'utf-8');
  }
  git(repo, 'add -A');
  git(repo, 'commit -m baseline');

  // Introduce + stage the planted bug.
  for (const f of DEMO_FILES) {
    fs.writeFileSync(path.join(repo, f.relPath), f.changed, 'utf-8');
  }
  git(repo, 'add -A');

  return repo;
}

export interface DemoOptions {
  /** Force the sample output path (used by tests; skips the LLM call). */
  forceSample?: boolean;
}

/**
 * Run the demo end-to-end. Returns the text to print. Always cleans up the
 * temp repo, even on error.
 */
export async function runDemo(options: DemoOptions = {}): Promise<string> {
  const repo = buildDemoRepo();

  try {
    if (options.forceSample) {
      return sampleReview();
    }

    let result: GuardResult;
    try {
      result = await runGuardReview({ root: repo });
    } catch {
      // No provider available (or provider call failed): show the sample.
      return sampleReview();
    }
    return formatGuardText(result);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
