/**
 * Tests for the deterministic scanner layer. Adapters run against an injected
 * `exec`, so no scanner binary is needed. The SARIF fixtures under
 * tests/fixtures/sarif are real output from gitleaks 8.30.1, semgrep 1.186.0
 * and osv-scanner 2.7.1.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeUri, parseSarif } from '../src/guard/scanners/sarif';
import { describeFailure } from '../src/guard/scanners/exec';
import { parseChangedLines, runScanners, toViolation } from '../src/guard/scanners';
import { gitleaksAdapter } from '../src/guard/scanners/gitleaks';
import { semgrepAdapter } from '../src/guard/scanners/semgrep';
import { osvAdapter } from '../src/guard/scanners/osv';
import type { ExecFn, ExecResult, ScanContext, ScannerAdapter } from '../src/guard/scanners/types';

const FIX = path.join(__dirname, 'fixtures', 'sarif');
const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf-8');

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '' });
const missing: ExecResult = {
  status: null,
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-sc-test-'));
}

/** Option value following `flag` in an argument list. */
function argAfter(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

function ctx(over: Partial<ScanContext> = {}): ScanContext {
  return {
    root: '/repo',
    mode: 'staged',
    baseRev: 'HEAD',
    changedFiles: [],
    addedLines: new Map(),
    readChanged: () => null,
    ...over,
  };
}

describe('normalizeUri', () => {
  it('keeps repo-relative paths and strips ./', () => {
    expect(normalizeUri('src/a.js', '/repo')).toBe('src/a.js');
    expect(normalizeUri('./src/a.js', '/repo')).toBe('src/a.js');
  });

  it('makes absolute paths under root relative', () => {
    expect(normalizeUri('/repo/src/a.js', '/repo')).toBe('src/a.js');
    expect(normalizeUri('C:/Work/repo/src/a.js', 'C:\\work\\repo')).toBe('src/a.js');
    expect(normalizeUri('file:///C:/Work/repo/src/a.js', 'C:\\Work\\repo')).toBe('src/a.js');
  });

  it('leaves paths outside root absolute so they match no changed file', () => {
    expect(normalizeUri('/elsewhere/a.js', '/repo')).toBe('/elsewhere/a.js');
    expect(normalizeUri('/repository/a.js', '/repo')).toBe('/repository/a.js');
  });

  it('converts backslashes', () => {
    expect(normalizeUri('src\\deep\\a.js', '/repo')).toBe('src/deep/a.js');
  });
});

describe('parseSarif with real tool output', () => {
  it('reads gitleaks results (redacted secrets, rule ids, lines)', () => {
    const found = parseSarif(fixture('gitleaks.sarif'), '/repo');
    expect(found.map((f) => f.ruleId).sort()).toEqual(['aws-access-token', 'github-pat', 'stripe-access-token']);
    const aws = found.find((f) => f.ruleId === 'aws-access-token')!;
    expect(aws.file).toBe('src/a.js');
    expect(aws.line).toBe(2);
    expect(JSON.stringify(found)).not.toContain('AKIAQYLPMN5HHHFPZAM2');
  });

  it('reads semgrep results with the rule confidence tags', () => {
    const found = parseSarif(fixture('semgrep.sarif'), '/tmp/sg');
    expect(found).toHaveLength(2);
    const cp = found.find((f) => f.ruleId.endsWith('detect-child-process'))!;
    expect(cp.file).toBe('src/a.js');
    expect(cp.line).toBe(3);
    expect(cp.tags).toContain('LOW CONFIDENCE');
  });

  it('reads osv results with CVSS scores', () => {
    const found = parseSarif(fixture('osv.sarif'), '/repo');
    expect(found).toHaveLength(7);
    expect(found.every((f) => f.securityScore !== undefined)).toBe(true);
    expect(found.some((f) => /lodash@4\.17\.15/.test(f.message))).toBe(true);
  });

  it('tolerates empty and result-less logs and throws on invalid JSON', () => {
    expect(parseSarif('{"runs":[]}', '/r')).toEqual([]);
    expect(parseSarif('{"runs":[{"results":[]}]}', '/r')).toEqual([]);
    expect(() => parseSarif('not json', '/r')).toThrow();
  });
});

describe('describeFailure', () => {
  it('maps spawn errors to short reasons', () => {
    expect(describeFailure(missing)).toBe('not installed');
    const timedOut = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) };
    expect(describeFailure(timedOut)).toBe('timed out');
  });

  it('uses the first non-empty stderr line without colour codes', () => {
    const r = { status: 2, stdout: '', stderr: '\n\u001b[31mERR\u001b[0m boom\nmore' };
    expect(describeFailure(r)).toBe('exited with status 2: ERR boom');
  });
});

describe('parseChangedLines', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,0 +2,2 @@',
    '+const x = 1;',
    '+const y = 2;',
    'diff --git a/old.js b/old.js',
    'deleted file mode 100644',
    '--- a/old.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    'diff --git a/new dir/n.js b/new dir/n.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new dir/n.js',
    '@@ -0,0 +1 @@',
    '+hi',
    '',
  ].join('\n');

  it('lists non-deleted files and their added lines, including paths with spaces', () => {
    const { changedFiles, addedLines } = parseChangedLines(diff);
    expect(changedFiles).toEqual(['src/a.js', 'new dir/n.js']);
    expect([...addedLines.get('src/a.js')!]).toEqual([2, 3]);
    expect([...addedLines.get('new dir/n.js')!]).toEqual([1]);
  });

  it('returns nothing for an empty diff', () => {
    expect(parseChangedLines('').changedFiles).toEqual([]);
  });
});

describe('gitleaksAdapter', () => {
  it('scans the index in staged mode and parses the report', () => {
    const dir = tmp();
    try {
      let seen: string[] = [];
      const exec: ExecFn = (cmd, args) => {
        seen = [cmd, ...args];
        fs.writeFileSync(argAfter(args, '--report-path'), fixture('gitleaks.sarif'));
        return ok();
      };
      const out = gitleaksAdapter.run(ctx(), exec, dir)!;
      expect('findings' in out && out.findings).toHaveLength(3);
      expect(seen[0]).toBe('gitleaks');
      expect(seen).toContain('--staged');
      expect(seen).toContain('--redact');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans every commit in base..HEAD in range mode', () => {
    const dir = tmp();
    try {
      let args: string[] = [];
      const exec: ExecFn = (_cmd, a) => {
        args = a;
        fs.writeFileSync(argAfter(a, '--report-path'), '{"runs":[]}');
        return ok();
      };
      gitleaksAdapter.run(ctx({ mode: 'range', baseRev: 'abc123' }), exec, dir);
      expect(args).toContain('--log-opts=abc123..HEAD');
      expect(args).not.toContain('--staged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when the binary is missing, fails, or writes garbage', () => {
    const dir = tmp();
    try {
      expect(gitleaksAdapter.run(ctx(), () => missing, dir)).toEqual({ skipped: 'not installed' });
      expect(gitleaksAdapter.run(ctx(), () => ({ status: 3, stdout: '', stderr: 'bad flag' }), dir)).toEqual({
        skipped: 'exited with status 3: bad flag',
      });
      const garbage: ExecFn = (_c, a) => {
        fs.writeFileSync(argAfter(a, '--report-path'), 'nope');
        return ok();
      };
      expect(gitleaksAdapter.run(ctx(), garbage, dir)).toEqual({ skipped: 'produced an unreadable report' });
      const emptyDir = tmp();
      try {
        expect(gitleaksAdapter.run(ctx(), () => ok(), emptyDir)).toEqual({ skipped: 'produced no report' });
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips range mode without a base revision', () => {
    const result = gitleaksAdapter.run(ctx({ mode: 'range', baseRev: undefined }), () => ok(), tmp());
    expect(result).toEqual({ skipped: 'no base revision' });
  });
});

describe('semgrepAdapter', () => {
  const semgrepCtx = (): ScanContext =>
    ctx({
      changedFiles: ['src/a.js', '../escape.js'],
      addedLines: new Map([['src/a.js', new Set([3])]]),
      readChanged: (f) => `// content of ${f}\n`,
    });

  it('scans staged content copied to a temp dir, passing paths after "--"', () => {
    const dir = tmp();
    try {
      let call: { args: string[]; cwd: string } | undefined;
      const exec: ExecFn = (_cmd, args, opts) => {
        call = { args, cwd: opts.cwd };
        fs.writeFileSync(argAfter(args, '--output'), fixture('semgrep.sarif'));
        return ok();
      };
      semgrepAdapter.run(semgrepCtx(), exec, dir);
      expect(call!.cwd).toBe(path.join(dir, 'semgrep-src'));
      expect(argAfter(call!.args, '--metrics')).toBe('off');
      const sep = call!.args.indexOf('--');
      expect(call!.args.slice(sep + 1)).toEqual(['./src/a.js']);
      expect(fs.readFileSync(path.join(dir, 'semgrep-src', 'src', 'a.js'), 'utf-8')).toBe('// content of src/a.js\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never writes outside its temp dir for paths that climb out', () => {
    const dir = tmp();
    try {
      const exec: ExecFn = (_c, a) => {
        fs.writeFileSync(argAfter(a, '--output'), '{"runs":[]}');
        return ok();
      };
      semgrepAdapter.run(semgrepCtx(), exec, dir);
      expect(fs.existsSync(path.join(dir, 'escape.js'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only findings that touch added lines', () => {
    const dir = tmp();
    try {
      const exec: ExecFn = (_c, a) => {
        fs.writeFileSync(argAfter(a, '--output'), fixture('semgrep.sarif'));
        return ok();
      };
      const out = semgrepAdapter.run(semgrepCtx(), exec, dir)!;
      // The fixture has findings on lines 3 and 4; only line 3 was added.
      expect('findings' in out && out.findings.map((f) => f.line)).toEqual([3]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not apply when no changed file is readable, and skips when semgrep is missing', () => {
    const dir = tmp();
    try {
      expect(semgrepAdapter.run(ctx({ changedFiles: ['a.js'], readChanged: () => null }), () => ok(), dir)).toBeNull();
      expect(semgrepAdapter.run(semgrepCtx(), () => missing, dir)).toEqual({ skipped: 'not installed' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('osvAdapter', () => {
  /**
   * A fake exec: `git show base:file` returns `baseContent` (null = file absent
   * at base), and osv-scanner reports the real fixture when the scanned
   * lockfile contains "VULN" and nothing otherwise.
   */
  function setup(baseContent: string | null, changedContent = 'VULN') {
    const calls: string[][] = [];
    const exec: ExecFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git') {
        return baseContent === null ? { status: 128, stdout: '', stderr: 'fatal' } : ok(baseContent);
      }
      const body = fs.readFileSync(argAfter(args, '-L'), 'utf-8');
      const hit = body.includes('VULN');
      fs.writeFileSync(argAfter(args, '--output-file'), hit ? fixture('osv.sarif') : '{"runs":[]}');
      return { status: hit ? 1 : 0, stdout: '', stderr: '' };
    };
    const c = ctx({ changedFiles: ['package-lock.json', 'src/a.js'], readChanged: () => changedContent });
    return { c, exec, calls };
  }

  it('does not apply when no lockfile changed', () => {
    expect(osvAdapter.run(ctx({ changedFiles: ['src/a.js'] }), () => ok(), tmp())).toBeNull();
  });

  it('reports every vulnerability in a lockfile that is new', () => {
    const dir = tmp();
    try {
      const { c, exec } = setup(null);
      const out = osvAdapter.run(c, exec, dir)!;
      expect('findings' in out && out.findings).toHaveLength(7);
      expect('findings' in out && out.findings.every((f) => f.file === 'package-lock.json' && f.line === 1)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports only vulnerabilities the base revision did not already have', () => {
    const dir = tmp();
    try {
      const { c, exec } = setup('VULN already at base');
      const out = osvAdapter.run(c, exec, dir)!;
      expect(out).toEqual({ findings: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports new vulnerabilities when the base lockfile was clean', () => {
    const dir = tmp();
    try {
      const { c, exec } = setup('clean at base');
      const out = osvAdapter.run(c, exec, dir)!;
      expect('findings' in out && out.findings).toHaveLength(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans each lockfile under its real name so osv picks the right parser', () => {
    const dir = tmp();
    try {
      const { c, exec, calls } = setup(null);
      osvAdapter.run(c, exec, dir);
      const osvCall = calls.find((x) => x[0] === 'osv-scanner')!;
      expect(path.basename(argAfter(osvCall, '-L'))).toBe('package-lock.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats "no packages" (exit 128) as an empty result, not a failure', () => {
    const dir = tmp();
    try {
      const exec: ExecFn = (cmd) =>
        cmd === 'git' ? { status: 128, stdout: '', stderr: '' } : { status: 128, stdout: '', stderr: 'No package sources found' };
      const out = osvAdapter.run(ctx({ changedFiles: ['package-lock.json'], readChanged: () => '{}' }), exec, dir)!;
      expect(out).toEqual({ findings: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when osv-scanner is missing', () => {
    const dir = tmp();
    try {
      const exec: ExecFn = (cmd) => (cmd === 'git' ? ok('x') : missing);
      const c = ctx({ changedFiles: ['package-lock.json'], readChanged: () => '{}' });
      expect(osvAdapter.run(c, exec, dir)).toEqual({ skipped: 'not installed' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toViolation', () => {
  const raw = (over = {}) => ({
    ruleId: 'r',
    message: 'm',
    file: 'a.js',
    line: 3,
    endLine: 4,
    level: 'warning',
    tags: [] as string[],
    ...over,
  });

  it('marks every scanner finding with its source and a prefixed rule id', () => {
    const v = toViolation('gitleaks', raw({ ruleId: 'aws-access-token' }), 'staged');
    expect(v.source).toBe('gitleaks');
    expect(v.rule_id).toBe('gitleaks:aws-access-token');
    expect(v.fixable).toBe(false);
    expect(v.line_start).toBe(3);
    expect(v.line_end).toBe(4);
  });

  it('treats secrets as critical and blocking, and mentions history in range mode', () => {
    expect(toViolation('gitleaks', raw(), 'staged')).toMatchObject({ severity: 'critical', confidence: 0.9 });
    expect(toViolation('gitleaks', raw(), 'range').message).toMatch(/git history/);
    expect(toViolation('gitleaks', raw(), 'staged').message).not.toMatch(/git history/);
  });

  it('maps CVSS scores to severities', () => {
    const sev = (score?: number) => toViolation('osv-scanner', raw({ securityScore: score }), 'staged').severity;
    expect([sev(9.8), sev(7.5), sev(5.3), sev(2), sev(undefined)]).toEqual(['critical', 'high', 'medium', 'low', 'medium']);
  });

  it('maps semgrep level and confidence tags', () => {
    expect(toViolation('semgrep', raw({ level: 'error' }), 'staged').severity).toBe('high');
    expect(toViolation('semgrep', raw({ level: 'warning' }), 'staged').severity).toBe('medium');
    expect(toViolation('semgrep', raw({ tags: ['LOW CONFIDENCE'] }), 'staged').confidence).toBe(0.6);
    expect(toViolation('semgrep', raw({ tags: ['HIGH CONFIDENCE'] }), 'staged').confidence).toBe(0.9);
  });
});

describe('runScanners', () => {
  const fakeAdapter = (name: ScannerAdapter['name'], run: ScannerAdapter['run']): ScannerAdapter => ({ name, run });
  const git: ExecFn = (cmd, args) => {
    if (cmd === 'git' && args.includes('diff')) {
      return ok('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -0,0 +1 @@\n+x\n');
    }
    return ok('abc123\n');
  };
  const finding = { ruleId: 'r', message: 'm', file: 'a.js', line: 1, endLine: 1, level: 'error', tags: [] as string[] };

  it('collects findings, reports who ran and who was skipped, and never throws', () => {
    const out = runScanners({
      root: '/repo',
      mode: 'staged',
      exec: git,
      adapters: [
        fakeAdapter('gitleaks', () => ({ findings: [finding] })),
        fakeAdapter('semgrep', () => ({ skipped: 'not installed' })),
        fakeAdapter('osv-scanner', () => null),
      ],
    });
    expect(out.violations).toHaveLength(1);
    expect(out.violations[0].source).toBe('gitleaks');
    expect(out.report).toEqual({ ran: ['gitleaks'], skipped: [{ name: 'semgrep', reason: 'not installed' }] });
  });

  it('turns an adapter that throws into a skip and keeps going', () => {
    const out = runScanners({
      root: '/repo',
      mode: 'staged',
      exec: git,
      adapters: [
        fakeAdapter('gitleaks', () => {
          throw new Error('boom\nstack');
        }),
        fakeAdapter('semgrep', () => ({ findings: [finding] })),
      ],
    });
    expect(out.report.skipped).toEqual([{ name: 'gitleaks', reason: 'boom' }]);
    expect(out.violations).toHaveLength(1);
  });

  it('removes duplicate findings', () => {
    const out = runScanners({
      root: '/repo',
      mode: 'staged',
      exec: git,
      adapters: [fakeAdapter('semgrep', () => ({ findings: [finding, { ...finding }] }))],
    });
    expect(out.violations).toHaveLength(1);
  });

  it('resolves the merge base for range mode and removes its temp dir', () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('skannr-scan-')));
    let seenBase: string | undefined;
    runScanners({
      root: '/repo',
      mode: 'range',
      baseRef: 'origin/main',
      diffText: '',
      exec: git,
      adapters: [
        fakeAdapter('gitleaks', (c) => {
          seenBase = c.baseRev;
          return { findings: [] };
        }),
      ],
    });
    expect(seenBase).toBe('abc123');
    const leaked = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('skannr-scan-') && !before.has(d));
    expect(leaked).toEqual([]);
  });
});
