/**
 * Tests for the GitHub Action: markdown summary escaping, the guard --base
 * option, and action.yml structure (no expression interpolation in scripts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { formatGuardMarkdown, escapeCell, COMMENT_MARKER, type GuardReport } from '../src/action-summary';

jest.mock('../src/guard/review-runner');
import { runGuardReview } from '../src/guard/review-runner';
import { runGuard } from '../src/guard/index';
const mockedReview = runGuardReview as jest.MockedFunction<typeof runGuardReview>;

function report(overrides: Partial<GuardReport> = {}): GuardReport {
  return {
    status: 'fail',
    summary: '1 violation(s) found across 1 symbol(s).',
    violations: [
      {
        rule_id: 'no-hardcoded-secrets',
        file: 'src/config.ts',
        line_start: 3,
        severity: 'critical',
        confidence: 0.95,
        message: 'Hardcoded secret.',
      },
    ],
    symbolsReviewed: 1,
    rulesUsed: 6,
    durationMs: 1200,
    ...overrides,
  };
}

describe('escapeCell', () => {
  it('neutralizes pipes, newlines, HTML, and mentions', () => {
    const out = escapeCell('a|b\nc <img src=x> @octocat');
    expect(out).not.toContain('\n');
    expect(out).toContain('a\\|b');
    expect(out).toContain('&lt;img src=x&gt;');
    expect(out).not.toMatch(/@octocat/);
  });
});

describe('formatGuardMarkdown', () => {
  it('starts with the comment marker and shows status and a table row', () => {
    const md = formatGuardMarkdown(report());
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain('Skannr Guard: FAIL');
    expect(md).toContain('| critical | src/config.ts:3 | no-hardcoded-secrets | 95% | Hardcoded secret. |');
  });

  it('omits the table when there are no violations', () => {
    const md = formatGuardMarkdown(report({ status: 'pass', violations: [], summary: 'All 1 symbol(s) pass review.' }));
    expect(md).toContain('Skannr Guard: PASS');
    expect(md).not.toContain('| Severity |');
  });

  it('cannot be broken out of by a hostile message', () => {
    const hostile = report();
    hostile.violations[0].message = 'x |\n\n### Approved\n<script>alert(1)</script> @everyone';
    const md = formatGuardMarkdown(hostile);
    const row = md.split('\n').find((l) => l.startsWith('| critical'))!;
    expect(row).toBeDefined();
    expect(md).not.toContain('\n### Approved');
    expect(md).not.toContain('<script>');
  });

  it('caps the table at 50 rows and truncates long messages', () => {
    const many = report();
    many.violations = Array.from({ length: 60 }, () => ({ ...many.violations[0], message: 'y'.repeat(1000) }));
    const md = formatGuardMarkdown(many);
    const rows = md.split('\n').filter((l) => l.startsWith('| critical'));
    expect(rows).toHaveLength(50);
    expect(rows[0].length).toBeLessThan(400);
    expect(md).toContain('10 more violation(s) not shown');
  });
});

describe('runGuard --base', () => {
  afterEach(() => mockedReview.mockReset());

  it('rejects refs that look like options', async () => {
    await expect(runGuard({ root: '.', base: '--output=/tmp/x' })).rejects.toThrow('Invalid --base ref');
    expect(mockedReview).not.toHaveBeenCalled();
  });

  it('reviews the diff between the base ref and HEAD', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-base-'));
    try {
      const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
      git('init -b main');
      git('config user.email t@t.local');
      git('config user.name t');
      git('config commit.gpgsign false');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 1;\n');
      git('add -A');
      git('commit -m base');
      git('checkout -b feature');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'const a = 2;\n');
      git('commit -am change');

      mockedReview.mockResolvedValue({
        response: { violations: [], status: 'pass', summary: 'ok' },
        rulesUsed: [],
        symbolsReviewed: 0,
        durationMs: 1,
      });

      const { exitCode } = await runGuard({ root: repo, base: 'main' });
      expect(exitCode).toBe(0);
      const diff = mockedReview.mock.calls[0][0].diffContent!;
      expect(diff).toContain('-const a = 1;');
      expect(diff).toContain('+const a = 2;');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('action.yml', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf-8');

  /** Bodies of every `run: |` block, found by indentation. */
  function runBlocks(src: string): string[] {
    const lines = src.split(/\r?\n/);
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)run: \|\s*$/);
      if (!m) continue;
      const indent = m[1].length;
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() !== '' && l.search(/\S/) <= indent) { i--; break; }
        body.push(l);
      }
      blocks.push(body.join('\n'));
    }
    return blocks;
  }

  it('is a composite action', () => {
    expect(text).toMatch(/^\s+using: 'composite'$/m);
  });

  it('never interpolates ${{ }} expressions inside run scripts', () => {
    const blocks = runBlocks(text);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const body of blocks) expect(body).not.toContain('${{');
  });
});
