/**
 * Tests for `skannr demo`: repo construction, planted bug, sample fallback,
 * and temp-dir cleanup on both success and failure paths.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { buildDemoRepo, runDemo } from '../src/demo';
import { buildSymbolDiffs } from '../src/guard/symbol-diff';

// Prevent any real provider call: the review runner is mocked per-test.
jest.mock('../src/guard/review-runner');
import { runGuardReview } from '../src/guard/review-runner';
const mockedReview = runGuardReview as jest.MockedFunction<typeof runGuardReview>;

/** Count skannr-demo temp dirs to assert cleanup. */
function demoDirs(): string[] {
  const tmp = os.tmpdir();
  return fs.readdirSync(tmp).filter((d) => d.startsWith('skannr-demo-'));
}

describe('buildDemoRepo', () => {
  it('creates a git repo with a staged hardcoded-secret change', () => {
    const repo = buildDemoRepo();
    try {
      // It is a git repo.
      expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);

      // The planted file exists with the secret.
      const content = fs.readFileSync(path.join(repo, 'src', 'config.ts'), 'utf-8');
      expect(content).toContain('sk-live-');

      // The change is staged (not just working-tree).
      const staged = execSync('git diff --cached --name-only', { cwd: repo, encoding: 'utf-8' });
      expect(staged).toContain('src/config.ts');

      // HEAD baseline does NOT contain the secret (so it's a real diff).
      const head = execSync('git show HEAD:src/config.ts', { cwd: repo, encoding: 'utf-8' });
      expect(head).not.toContain('sk-live-');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('produces a reviewable symbol unit (guards against the demo showing 0 symbols)', () => {
    const repo = buildDemoRepo();
    try {
      const units = buildSymbolDiffs(repo);
      expect(units.length).toBeGreaterThan(0);
      expect(units.some((u) => u.file === 'src/config.ts')).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('runDemo', () => {
  afterEach(() => mockedReview.mockReset());

  it('returns a sample review and cleans up when forced', async () => {
    const before = demoDirs().length;
    const output = await runDemo({ forceSample: true });

    expect(output).toContain('SAMPLE');
    expect(output).toContain('no-hardcoded-secrets');
    expect(output).toContain('FAIL');
    expect(mockedReview).not.toHaveBeenCalled();

    // Temp repo removed: no net increase in demo dirs.
    expect(demoDirs().length).toBe(before);
  });

  it('falls back to the sample and cleans up when the provider call throws', async () => {
    mockedReview.mockRejectedValue(new Error('no provider'));
    const before = demoDirs().length;

    const output = await runDemo({});

    expect(mockedReview).toHaveBeenCalled();
    expect(output).toContain('SAMPLE');
    expect(demoDirs().length).toBe(before);
  });

  it('formats the real result and cleans up on success', async () => {
    mockedReview.mockResolvedValue({
      response: {
        violations: [
          {
            rule_id: 'no-hardcoded-secrets',
            file: 'src/config.ts',
            symbol: 'getApiKey',
            line_start: 3,
            line_end: 3,
            severity: 'critical',
            confidence: 0.95,
            fixable: false,
            message: 'Hardcoded secret.',
          },
        ],
        status: 'fail',
        summary: '1 violation(s) found across 1 symbol(s).',
      },
      rulesUsed: [],
      symbolsReviewed: 1,
      durationMs: 5,
    });
    const before = demoDirs().length;

    const output = await runDemo({});

    expect(mockedReview).toHaveBeenCalled();
    expect(output).not.toContain('SAMPLE');
    expect(output).toContain('no-hardcoded-secrets');
    expect(output).toContain('FAIL');
    expect(demoDirs().length).toBe(before);
  });
});
