/**
 * Tests for skannr guard: schema validation, symbol diff, fix scoping,
 * and the gga regression case (prepended text before JSON).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock web-tree-sitter to avoid WASM loading
jest.mock('web-tree-sitter', () => ({
  default: {
    init: jest.fn().mockResolvedValue(undefined),
    Language: { load: jest.fn().mockResolvedValue(null) },
  },
}), { virtual: true });
jest.mock('../src/languages/TreeSitterAdapter', () => ({
  TreeSitterAdapter: class {
    name = 'tree-sitter';
    extensions = ['.py', '.pyi', '.go', '.rs', '.java'];
    canHandle() { return false; }
    generateSkeleton() { return { skeleton: '', lineRanges: [] }; }
    extractSymbols() { return []; }
    extractImports() { return []; }
    initializeSync() {}
    async initialize() {}
  },
}));

import { RulesFileSchema, ReviewResponseSchema } from '../src/guard/schema';
import { getFixableViolations, previewFixes, applyFixes } from '../src/guard/fix-applier';
import { installHook, uninstallHook } from '../src/guard/hook-installer';
import { buildSymbolDiffs } from '../src/guard/symbol-diff';
import { execSync } from 'child_process';
import type { Violation } from '../src/guard/types';

describe('guard schema validation', () => {
  describe('RulesFileSchema', () => {
    it('accepts a valid rules file', () => {
      const valid = {
        rules: [
          {
            id: 'no-any-type',
            description: 'Do not use any type',
            severity: 'high',
            fixable: true,
            category: 'type-safety',
          },
        ],
      };
      const result = RulesFileSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects rules file with missing fields', () => {
      const invalid = {
        rules: [{ id: 'test' }], // missing description, severity, fixable, category
      };
      const result = RulesFileSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects empty rules array', () => {
      const invalid = { rules: [] };
      const result = RulesFileSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects invalid severity', () => {
      const invalid = {
        rules: [{
          id: 'test',
          description: 'desc',
          severity: 'extreme', // invalid
          fixable: true,
          category: 'cat',
        }],
      };
      const result = RulesFileSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('ReviewResponseSchema', () => {
    it('accepts a valid pass response', () => {
      const valid = {
        violations: [],
        status: 'pass',
        summary: 'All good.',
      };
      const result = ReviewResponseSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('accepts a valid fail response with violations', () => {
      const valid = {
        violations: [{
          rule_id: 'no-any-type',
          file: 'src/foo.ts',
          symbol: 'getUser',
          line_start: 10,
          line_end: 12,
          severity: 'high',
          confidence: 0.92,
          fixable: true,
          message: 'Uses any type',
          suggested_fix: 'req: Request',
        }],
        status: 'fail',
        summary: '1 violation found.',
      };
      const result = ReviewResponseSchema.safeParse(valid);
      expect(result.success).toBe(true);
    });

    it('rejects response with invalid status', () => {
      const invalid = {
        violations: [],
        status: 'maybe',
        summary: 'Not sure.',
      };
      const result = ReviewResponseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('rejects violation with confidence > 1', () => {
      const invalid = {
        violations: [{
          rule_id: 'test',
          file: 'a.ts',
          symbol: 'x',
          line_start: 1,
          line_end: 2,
          severity: 'low',
          confidence: 1.5,
          fixable: false,
          message: 'msg',
        }],
        status: 'fail',
        summary: 'fail',
      };
      const result = ReviewResponseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('gga regression: prepended text before JSON', () => {
    it('ReviewResponseSchema parses clean JSON regardless of how it arrives', () => {
      // The provider contract extracts JSON from response text.
      // This test validates that the schema itself works with clean JSON —
      // the extractJson() function in provider.ts handles stripping preamble.
      const responseWithPreamble = `Sure! Here's my analysis:

{
  "violations": [],
  "status": "pass",
  "summary": "No issues found."
}`;
      // Extract JSON (simulating what provider.ts does)
      const firstBrace = responseWithPreamble.indexOf('{');
      const lastBrace = responseWithPreamble.lastIndexOf('}');
      const jsonStr = responseWithPreamble.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(jsonStr);
      const result = ReviewResponseSchema.safeParse(parsed);
      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('pass');
    });
  });
});

describe('guard fix scoping', () => {
  it('getFixableViolations filters to fixable:true with suggested_fix only', () => {
    const violations: Violation[] = [
      {
        rule_id: 'fixable-rule',
        file: 'a.ts',
        symbol: 'fn1',
        line_start: 1,
        line_end: 3,
        severity: 'high',
        confidence: 0.9,
        fixable: true,
        message: 'issue',
        suggested_fix: 'fixed code',
      },
      {
        rule_id: 'not-fixable',
        file: 'b.ts',
        symbol: 'fn2',
        line_start: 5,
        line_end: 7,
        severity: 'high',
        confidence: 0.8,
        fixable: false,
        message: 'another issue',
      },
      {
        rule_id: 'fixable-no-fix',
        file: 'c.ts',
        symbol: 'fn3',
        line_start: 10,
        line_end: 12,
        severity: 'medium',
        confidence: 0.7,
        fixable: true,
        message: 'issue but no fix',
        // no suggested_fix
      },
    ];

    const fixable = getFixableViolations(violations);
    expect(fixable.length).toBe(1);
    expect(fixable[0].rule_id).toBe('fixable-rule');
  });

  it('applyFixes only modifies files for fixable violations', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fix-'));

    // Create test files
    fs.writeFileSync(
      path.join(tempDir, 'fixable.ts'),
      'line 1\nconst x: any = 5;\nline 3\nline 4\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'not-fixable.ts'),
      'line 1\nline 2\nline 3\n',
    );

    const violations: Violation[] = [
      {
        rule_id: 'fix-this',
        file: 'fixable.ts',
        symbol: 'x',
        line_start: 2,
        line_end: 2,
        severity: 'high',
        confidence: 0.95,
        fixable: true,
        message: 'use unknown',
        suggested_fix: 'const x: unknown = 5;',
      },
      {
        rule_id: 'no-fix',
        file: 'not-fixable.ts',
        symbol: 'y',
        line_start: 2,
        line_end: 2,
        severity: 'high',
        confidence: 0.9,
        fixable: false,
        message: 'architectural issue',
      },
    ];

    const results = applyFixes(violations, tempDir);

    // Only the fixable one was applied
    expect(results.length).toBe(1);
    expect(results[0].applied).toBe(true);
    expect(results[0].rule_id).toBe('fix-this');

    // Verify file contents
    const fixedContent = fs.readFileSync(path.join(tempDir, 'fixable.ts'), 'utf-8');
    expect(fixedContent).toContain('const x: unknown = 5;');
    expect(fixedContent).not.toContain('any');

    // Not-fixable file should be unchanged
    const untouchedContent = fs.readFileSync(path.join(tempDir, 'not-fixable.ts'), 'utf-8');
    expect(untouchedContent).toBe('line 1\nline 2\nline 3\n');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('guard hook installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hook-'));
    fs.mkdirSync(path.join(tempDir, '.git', 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('installs hook in empty hooks dir', () => {
    const { installed, message } = installHook(tempDir);
    expect(installed).toBe(true);
    const hookContent = fs.readFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hookContent).toContain('skannr guard');
    expect(hookContent).toContain('#!/bin/sh');
  });

  it('appends to existing hook without overwriting', () => {
    const existingHook = '#!/bin/sh\necho "existing hook"\n';
    fs.writeFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), existingHook);

    const { installed } = installHook(tempDir);
    expect(installed).toBe(true);

    const hookContent = fs.readFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hookContent).toContain('existing hook');
    expect(hookContent).toContain('skannr guard');
  });

  it('does not double-install', () => {
    installHook(tempDir);
    const { message } = installHook(tempDir);
    expect(message).toContain('already installed');
  });

  it('uninstalls cleanly', () => {
    installHook(tempDir);
    const { removed } = uninstallHook(tempDir);
    expect(removed).toBe(true);

    // Hook file should be gone (was the only content)
    expect(fs.existsSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('uninstall preserves other hook content', () => {
    const existingHook = '#!/bin/sh\necho "keep me"\n';
    fs.writeFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), existingHook);

    installHook(tempDir);
    uninstallHook(tempDir);

    const hookContent = fs.readFileSync(path.join(tempDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(hookContent).toContain('keep me');
    expect(hookContent).not.toContain('skannr guard');
  });
});

describe('buildSymbolDiffs: export marker range (issue #9)', () => {
  function buildRepo(baseline: string, changed: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-sd-'));
    const git = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' });
    git('init');
    git('config user.email t@t.local');
    git('config user.name t');
    git('config commit.gpgsign false');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'config.ts'), baseline, 'utf-8');
    git('add -A');
    git('commit -m base');
    fs.writeFileSync(path.join(repo, 'src', 'config.ts'), changed, 'utf-8');
    git('add -A');
    return repo;
  }

  it('attributes a body-only change of a top-of-file exported function to that symbol', () => {
    // The function is the first symbol (line 1). The synthetic `export` marker
    // the parser emits also lives at line 1. Before the fix, that collapsed the
    // function's range to empty and the change matched no symbol.
    const baseline = [
      'export function getApiKey(): string {',
      '  return process.env.API_KEY ?? "";',
      '}',
      '',
    ].join('\n');
    const changed = [
      'export function getApiKey(): string {',
      '  return "sk-live-planted";',
      '}',
      '',
    ].join('\n');
    const repo = buildRepo(baseline, changed);
    try {
      const units = buildSymbolDiffs(repo);
      const match = units.find((u) => u.file === 'src/config.ts' && u.symbol === 'getApiKey');
      expect(match).toBeDefined();
      expect(match!.changeType).toBe('modified');
      // No synthetic export marker leaks through as its own unit.
      expect(units.every((u) => u.symbol !== 'export')).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
