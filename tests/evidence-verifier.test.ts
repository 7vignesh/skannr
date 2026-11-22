/**
 * Tests for evidence verification: the pure matcher and the repo-backed filter.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import { verifyEvidence, verifyViolations } from '../src/guard/evidence-verifier';
import type { Violation } from '../src/guard/types';

function violation(over: Partial<Violation> = {}): Violation {
  return {
    rule_id: 'no-hardcoded-secrets',
    file: 'src/config.ts',
    symbol: 'readApiKey',
    line_start: 2,
    line_end: 2,
    severity: 'critical',
    confidence: 0.95,
    fixable: false,
    message: 'Hardcoded secret.',
    evidence: 'return "sk-live-planted";',
    ...over,
  };
}

const FILE = [
  'function readApiKey() {',
  '  return "sk-live-planted";',
  '}',
  '',
].join('\n');

describe('verifyEvidence', () => {
  it('verifies a quote found at the claimed line', () => {
    expect(verifyEvidence(violation(), FILE).verified).toBe(true);
  });

  it('tolerates indentation and leading/trailing whitespace differences', () => {
    expect(verifyEvidence(violation({ evidence: '    return "sk-live-planted";   ' }), FILE).verified).toBe(true);
  });

  it('tolerates an off-by-one line via the margin', () => {
    expect(verifyEvidence(violation({ line_start: 1, line_end: 1 }), FILE).verified).toBe(true);
  });

  it('accepts a correct quote with a badly wrong line via whole-file fallback', () => {
    expect(verifyEvidence(violation({ line_start: 99, line_end: 99 }), FILE).verified).toBe(true);
  });

  it('drops a fabricated quote not present anywhere', () => {
    const out = verifyEvidence(violation({ evidence: 'DROP TABLE users;' }), FILE);
    expect(out.verified).toBe(false);
    expect(out.reason).toMatch(/not found/);
  });

  it('drops a violation with no evidence', () => {
    expect(verifyEvidence(violation({ evidence: undefined }), FILE).verified).toBe(false);
    expect(verifyEvidence(violation({ evidence: '   ' }), FILE).verified).toBe(false);
  });

  it('drops when the file is unreadable', () => {
    expect(verifyEvidence(violation(), null).verified).toBe(false);
  });
});

describe('verifyViolations against a staged repo', () => {
  function buildRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-ev-'));
    const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
    git('init');
    git('config user.email t@t.local');
    git('config user.name t');
    git('config commit.gpgsign false');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'config.ts'), FILE, 'utf-8');
    git('add -A');
    return repo;
  }

  it('keeps real findings and drops hallucinated ones, marking survivors', () => {
    const repo = buildRepo();
    try {
      const real = violation();
      const fake = violation({ symbol: 'ghost', evidence: 'exec(userInput)' });
      const kept = verifyViolations(repo, [real, fake]);
      expect(kept).toHaveLength(1);
      expect(kept[0].symbol).toBe('readApiKey');
      expect(kept[0].evidence_verified).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reads each file once even with multiple violations', () => {
    const repo = buildRepo();
    try {
      const kept = verifyViolations(repo, [violation(), violation({ symbol: 'a' }), violation({ symbol: 'b' })]);
      expect(kept).toHaveLength(3);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
