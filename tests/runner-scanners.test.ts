/**
 * Integration tests: scanner findings flow through runGuardReview into the
 * result, fail the review on their own, and never depend on the LLM. The LLM
 * provider is mocked; a real git repo supplies the staged change.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

jest.mock('../src/guard/provider');
jest.mock('../src/guard/rules-loader', () => ({
  ...jest.requireActual('../src/guard/rules-loader'),
  loadGuardConfig: () => ({ provider: 'ollama', model: 'x' }),
}));
jest.mock('../src/guard/scanners');

import { runGuardReview } from '../src/guard/review-runner';
import { formatGuardJson, formatGuardText } from '../src/guard/index';
import { runLlmReview } from '../src/guard/provider';
import { runScanners } from '../src/guard/scanners';
import type { Violation } from '../src/guard/types';

const mockedLlm = runLlmReview as jest.MockedFunction<typeof runLlmReview>;
const mockedScan = runScanners as jest.MockedFunction<typeof runScanners>;

const secret: Violation = {
  rule_id: 'gitleaks:aws-access-token',
  file: 'src/config.js',
  symbol: '',
  line_start: 2,
  line_end: 2,
  severity: 'critical',
  confidence: 0.9,
  fixable: false,
  message: 'Possible secret detected.',
  source: 'gitleaks',
};

function buildRepo(files: Record<string, string>, staged: Record<string, string>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-rr-'));
  const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
  git('init');
  git('config user.email t@t.local');
  git('config user.name t');
  git('config commit.gpgsign false');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git('add -A');
  git('commit -m base');
  for (const [name, body] of Object.entries(staged)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), body);
  }
  git('add -A');
  return repo;
}

const FN_BASE = 'function f() {\n  return 1;\n}\n';
const FN_NEW = 'function f() {\n  return 2;\n}\n';

describe('runGuardReview with scanners', () => {
  afterEach(() => {
    mockedLlm.mockReset();
    mockedScan.mockReset();
  });

  it('merges scanner findings with LLM findings, tagged by source', async () => {
    const repo = buildRepo({ 'src/a.js': FN_BASE }, { 'src/a.js': FN_NEW });
    try {
      mockedScan.mockReturnValue({ violations: [secret], report: { ran: ['gitleaks'], skipped: [] } });
      mockedLlm.mockResolvedValue({
        violations: [
          {
            rule_id: 'no-console-log', file: 'src/a.js', symbol: 'f', line_start: 2, line_end: 2,
            severity: 'low', confidence: 0.9, fixable: false, message: 'm', evidence: 'return 2;',
            // A model must not be able to pass itself off as a scanner:
            source: 'gitleaks',
          },
        ],
        status: 'pass',
        summary: 's',
      });

      const result = await runGuardReview({ root: repo });
      const bySource = Object.fromEntries(result.response.violations.map((v) => [v.rule_id, v.source]));
      expect(bySource).toEqual({ 'no-console-log': 'llm', 'gitleaks:aws-access-token': 'gitleaks' });
      expect(result.scanners).toEqual({ ran: ['gitleaks'], skipped: [] });
      expect(result.response.summary).toContain('1 from scanners');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails the review on a critical scanner finding even when the LLM finds nothing', async () => {
    const repo = buildRepo({ 'src/a.js': FN_BASE }, { 'src/a.js': FN_NEW });
    try {
      mockedScan.mockReturnValue({ violations: [secret], report: { ran: ['gitleaks'], skipped: [] } });
      mockedLlm.mockResolvedValue({ violations: [], status: 'pass', summary: 's' });
      const result = await runGuardReview({ root: repo });
      expect(result.response.status).toBe('fail');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not run evidence verification on scanner findings', async () => {
    const repo = buildRepo({ 'src/a.js': FN_BASE }, { 'src/a.js': FN_NEW });
    try {
      // The secret has no quoted evidence; the verifier would drop it if applied.
      mockedScan.mockReturnValue({ violations: [secret], report: { ran: ['gitleaks'], skipped: [] } });
      mockedLlm.mockResolvedValue({ violations: [], status: 'pass', summary: 's' });
      const result = await runGuardReview({ root: repo });
      expect(result.response.violations).toHaveLength(1);
      expect(result.response.violations[0].evidence).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports a secret in a file with no parsed symbols, without calling the LLM', async () => {
    const repo = buildRepo({ 'README.md': 'hi\n' }, { '.env': 'key=abc\n' });
    try {
      mockedScan.mockReturnValue({
        violations: [{ ...secret, file: '.env', line_start: 1, line_end: 1 }],
        report: { ran: ['gitleaks'], skipped: [] },
      });
      const result = await runGuardReview({ root: repo });
      expect(mockedLlm).not.toHaveBeenCalled();
      expect(result.response.status).toBe('fail');
      expect(result.response.violations[0].file).toBe('.env');
      expect(result.symbolsReviewed).toBe(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still fails with the scanner findings when the LLM call throws and a scanner found a blocking issue', async () => {
    const repo = buildRepo({ 'src/a.js': FN_BASE }, { 'src/a.js': FN_NEW });
    try {
      mockedScan.mockReturnValue({ violations: [secret], report: { ran: ['gitleaks'], skipped: [] } });
      mockedLlm.mockRejectedValue(new Error('Provider call failed (ollama): fetch failed'));
      const result = await runGuardReview({ root: repo });
      expect(result.response.status).toBe('fail');
      expect(result.response.violations).toEqual([secret]);
      expect(result.response.summary).toContain('LLM review did not complete');
      expect(result.response.summary).toContain('fetch failed');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still throws when the LLM call fails and no scanner finding is blocking', async () => {
    const repo = buildRepo({ 'src/a.js': FN_BASE }, { 'src/a.js': FN_NEW });
    try {
      mockedLlm.mockRejectedValue(new Error('Provider call failed (ollama): fetch failed'));
      mockedScan.mockReturnValue({ violations: [], report: { ran: ['gitleaks'], skipped: [] } });
      await expect(runGuardReview({ root: repo })).rejects.toThrow('fetch failed');

      const minor = { ...secret, severity: 'low' as const };
      mockedScan.mockReturnValue({ violations: [minor], report: { ran: ['semgrep'], skipped: [] } });
      await expect(runGuardReview({ root: repo })).rejects.toThrow('fetch failed');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps the old "no symbols" pass when scanners find nothing', async () => {
    const repo = buildRepo({ 'README.md': 'hi\n' }, { 'README.md': 'hello\n' });
    try {
      mockedScan.mockReturnValue({ violations: [], report: { ran: ['gitleaks'], skipped: [] } });
      const result = await runGuardReview({ root: repo });
      expect(result.response.status).toBe('pass');
      expect(result.response.summary).toBe('No staged changes with identifiable symbols to review.');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not run scanners with noScanners, and omits the scanners report', async () => {
    const repo = buildRepo({ 'src/a.js': FN_BASE }, { 'src/a.js': FN_NEW });
    try {
      mockedLlm.mockResolvedValue({ violations: [], status: 'pass', summary: 's' });
      const result = await runGuardReview({ root: repo, noScanners: true });
      expect(mockedScan).not.toHaveBeenCalled();
      expect(result.scanners).toBeUndefined();
      expect(JSON.parse(formatGuardJson(result))).not.toHaveProperty('scanners');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('passes range-mode context to the scanners when a diff is supplied', async () => {
    const repo = buildRepo({ 'src/a.js': FN_BASE }, { 'src/a.js': FN_NEW });
    try {
      mockedScan.mockReturnValue({ violations: [], report: { ran: [], skipped: [] } });
      mockedLlm.mockResolvedValue({ violations: [], status: 'pass', summary: 's' });
      await runGuardReview({ root: repo, diffContent: 'diff --git a/x b/x\n', baseRef: 'origin/main' });
      expect(mockedScan).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'range', baseRef: 'origin/main', diffText: 'diff --git a/x b/x\n' }),
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('output formatting', () => {
  const base = {
    response: { violations: [secret], status: 'fail' as const, summary: '1 violation(s) found by scanners.' },
    rulesUsed: [],
    symbolsReviewed: 0,
    durationMs: 5,
  };

  it('prints which scanners ran and which were skipped, and omits an empty Symbol line', () => {
    const text = formatGuardText({
      ...base,
      scanners: { ran: ['gitleaks'], skipped: [{ name: 'semgrep', reason: 'not installed' }] },
    });
    expect(text).toContain('Scanners run: gitleaks');
    expect(text).toContain('Scanner skipped: semgrep (not installed)');
    expect(text).toContain('Rule: gitleaks:aws-access-token');
    expect(text).not.toContain('Symbol:');
  });

  it('includes the scanner report and violation source in JSON', () => {
    const json = JSON.parse(formatGuardJson({ ...base, scanners: { ran: ['gitleaks'], skipped: [] } }));
    expect(json.scanners).toEqual({ ran: ['gitleaks'], skipped: [] });
    expect(json.violations[0].source).toBe('gitleaks');
  });
});
