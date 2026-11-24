/**
 * Tests for the token benchmark's pure logic: file discovery, the median,
 * the reduction and cost formulas, argument parsing, and that the raw and
 * skeleton passes use one file list. Nothing here times real work: the clock
 * and the skeleton function are injected.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countTokens } from 'gpt-tokenizer';

import {
  ASSUMED_USD_PER_1M_INPUT_TOKENS,
  costSavedUsd,
  countLines,
  countSourceTokens,
  discoverFiles,
  main,
  measureTarget,
  median,
  normalizeEol,
  parseArgs,
  reductionPct,
  renderMarkdown,
  type MeasureOptions,
} from '../benchmarks/token-bench';

function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-tb-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

const rel = (root: string, files: string[]): string[] => files.map((f) => path.relative(root, f).split(path.sep).join('/'));

describe('discoverFiles', () => {
  it('finds .ts and .tsx files, sorted, and nothing else', () => {
    const root = makeTree({
      'b.ts': '', 'a.tsx': '', 'c.js': '', 'd.json': '', 'sub/z.ts': '', 'sub/deeper/y.tsx': '', 'notes.md': '',
    });
    try {
      expect(rel(root, discoverFiles(root))).toEqual(['a.tsx', 'b.ts', 'sub/deeper/y.tsx', 'sub/z.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes declaration files, and node_modules, dist, .git and .next at any depth', () => {
    const root = makeTree({
      'keep.ts': '',
      'types.d.ts': '',
      'node_modules/pkg/index.ts': '',
      'dist/out.ts': '',
      '.git/hooks/x.ts': '',
      '.next/server/page.tsx': '',
      'packages/a/node_modules/dep/i.ts': '',
      'packages/a/dist/x.ts': '',
      'packages/a/src/real.ts': '',
      'packages/a/src/gen.d.ts': '',
    });
    try {
      expect(rel(root, discoverFiles(root))).toEqual(['keep.ts', 'packages/a/src/real.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not exclude the target root itself even if it is named like an excluded directory', () => {
    const outer = makeTree({ 'dist/inside.ts': '', 'dist/sub/more.ts': '' });
    try {
      expect(rel(path.join(outer, 'dist'), discoverFiles(path.join(outer, 'dist')))).toEqual(['inside.ts', 'sub/more.ts']);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it('is deterministic and ordered by code unit, not by locale', () => {
    const root = makeTree({ 'B.ts': '', 'a.ts': '', 'Z.ts': '', '_x.ts': '' });
    try {
      const first = rel(root, discoverFiles(root));
      expect(first).toEqual(['B.ts', 'Z.ts', '_x.ts', 'a.ts']);
      expect(rel(root, discoverFiles(root))).toEqual(first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('median', () => {
  it('returns the middle value for an odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([9, 2, 7, 4, 5])).toBe(5);
  });

  it('averages the two middle values for an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not change the input and rejects an empty list', () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
    expect(() => median([])).toThrow(/empty/);
  });

  it('is not thrown off by one slow outlier', () => {
    expect(median([10, 11, 10, 12, 5000])).toBe(11);
  });
});

describe('reductionPct and costSavedUsd', () => {
  it('computes the percent of raw tokens removed', () => {
    expect(reductionPct(1000, 250)).toBe(75);
    expect(reductionPct(200, 200)).toBe(0);
  });

  it('keeps a negative value verbatim when the skeleton is larger', () => {
    expect(reductionPct(100, 150)).toBe(-50);
    expect(costSavedUsd(100, 150)).toBeLessThan(0);
  });

  it('returns null, not NaN or Infinity, when there are no raw tokens', () => {
    expect(reductionPct(0, 0)).toBeNull();
  });

  it('prices the difference at the assumed rate per million tokens', () => {
    expect(ASSUMED_USD_PER_1M_INPUT_TOKENS).toBe(2.5);
    expect(costSavedUsd(1_000_000, 0)).toBeCloseTo(2.5, 10);
    expect(costSavedUsd(1_200_000, 200_000)).toBeCloseTo(2.5, 10);
    expect(costSavedUsd(100_000, 40_000, 10)).toBeCloseTo(0.6, 10);
  });
});

describe('text helpers', () => {
  it('normalizes CRLF without touching lone LF or CR', () => {
    expect(normalizeEol('a\r\nb\nc\rd')).toBe('a\nb\nc\rd');
  });

  it('counts physical lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('\n\n')).toBe(2);
  });

  it('counts special-token text as ordinary source instead of throwing', () => {
    const text = 'const marker = "<|endoftext|>";';
    expect(() => countTokens(text)).toThrow(/special token/);
    expect(countSourceTokens(text)).toBeGreaterThan(5);
  });

  it('uses the o200k_base encoding', () => {
    // The default export of gpt-tokenizer; its count differs from cl100k_base on this text.
    expect(countSourceTokens('function foo(a: number): number { return a + 1; }')).toBe(countTokens('function foo(a: number): number { return a + 1; }'));
  });
});

describe('parseArgs', () => {
  it('parses --targets in both forms and trims blanks', () => {
    expect(parseArgs(['--targets', 'a, b ,,c']).targets).toEqual(['a', 'b', 'c']);
    expect(parseArgs(['--targets=x,y']).targets).toEqual(['x', 'y']);
  });

  it('defaults to no targets and recognizes --help', () => {
    expect(parseArgs([])).toEqual({ help: false });
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects a missing value, an empty list, and unknown flags', () => {
    expect(() => parseArgs(['--targets'])).toThrow(/comma-separated/);
    expect(() => parseArgs(['--targets', '--help'])).toThrow(/comma-separated/);
    expect(() => parseArgs(['--targets', ' , '])).toThrow(/at least one/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument: --nope/);
  });
});

describe('measureTarget', () => {
  function opts(over: Partial<MeasureOptions> = {}): MeasureOptions {
    return {
      warmup: 1,
      runs: 5,
      skeletonFn: (file) => `S:${path.basename(file)}`,
      now: (() => { let t = 0; return () => (t += 10); })(),
      countTokens: (text) => text.length,
      ...over,
    };
  }

  it('feeds the same sorted file list to the raw pass and the skeleton pass', () => {
    const root = makeTree({ 'b.ts': 'bbb', 'a.ts': 'aaaa', 'c.d.ts': 'declared', 'node_modules/x/i.ts': 'nope' });
    try {
      const seen: string[][] = [];
      let current: string[] = [];
      const result = measureTarget(
        { label: 't', root },
        opts({
          skeletonFn: (file) => { current.push(path.basename(file)); return 'x'; },
          now: (() => { let t = 0; return () => { if (current.length) { seen.push(current); current = []; } return (t += 1); }; })(),
        }),
      );
      expect(result.files).toBe(2);
      // Each pass visits a.ts then b.ts: the same order the raw text was built in.
      for (const pass of seen) expect(pass).toEqual(['a.ts', 'b.ts']);
      // Raw is exactly the two files joined with a newline, in that order.
      expect(result.rawChars).toBe('aaaa\nbbb'.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs one warmup plus five timed passes by default and records every timed run', () => {
    const root = makeTree({ 'a.ts': 'x' });
    try {
      let passes = 0;
      const result = measureTarget({ label: 't', root }, opts({ skeletonFn: () => { passes++; return 's'; } }));
      expect(passes).toBe(6);
      expect(result.latency.warmupRuns).toBe(1);
      expect(result.latency.timedRuns).toBe(5);
      expect(result.latency.runsMs).toHaveLength(5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the median of the timed runs, not the warmup and not the mean', () => {
    const root = makeTree({ 'a.ts': 'x' });
    try {
      // now() is called twice per timed pass: start then end. Durations: 100, 20, 30, 40, 9999.
      const durations = [100, 20, 30, 40, 9999];
      const stamps: number[] = [];
      let acc = 0;
      for (const d of durations) { stamps.push(acc); acc += d; stamps.push(acc); acc += 1; }
      let i = 0;
      const result = measureTarget({ label: 't', root }, opts({ now: () => stamps[i++] }));
      expect(result.latency.runsMs).toEqual(durations);
      expect(result.latency.medianMs).toBe(40);
      expect(result.latency.medianPerFileMs).toBe(40);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('computes reduction and cost from the measured token counts', () => {
    const root = makeTree({ 'a.ts': 'x'.repeat(400) });
    try {
      const result = measureTarget({ label: 't', root }, opts({ skeletonFn: () => 'y'.repeat(100) }));
      expect(result.rawTokens).toBe(400);
      expect(result.skeletonTokens).toBe(100);
      expect(result.reductionPct).toBe(75);
      expect(result.costSavedUsd).toBeCloseTo((300 / 1_000_000) * 2.5, 12);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a negative reduction when the skeleton is larger than the source', () => {
    const root = makeTree({ 'a.ts': 'x'.repeat(100) });
    try {
      const result = measureTarget({ label: 'grows', root }, opts({ skeletonFn: () => 'y'.repeat(150) }));
      expect(result.reductionPct).toBe(-50);
      expect(result.costSavedUsd).toBeLessThan(0);
      const md = renderMarkdown([result]);
      expect(md).toContain('-50.0%');
      expect(md).toContain('-$');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats CRLF and LF checkouts of the same source as the same size', () => {
    const lf = makeTree({ 'a.ts': 'const a = 1;\nconst b = 2;\n' });
    const crlf = makeTree({ 'a.ts': 'const a = 1;\r\nconst b = 2;\r\n' });
    try {
      const a = measureTarget({ label: 'lf', root: lf }, opts({ countTokens: countSourceTokens }));
      const b = measureTarget({ label: 'crlf', root: crlf }, opts({ countTokens: countSourceTokens }));
      expect(b.rawTokens).toBe(a.rawTokens);
      expect(b.rawSha256).toBe(a.rawSha256);
      expect(b.lines).toBe(a.lines);
    } finally {
      fs.rmSync(lf, { recursive: true, force: true });
      fs.rmSync(crlf, { recursive: true, force: true });
    }
  });

  it('flags parse failures and unstable output instead of hiding them', () => {
    const root = makeTree({ 'a.ts': 'x', 'b.ts': 'y' });
    try {
      let n = 0;
      const result = measureTarget(
        { label: 't', root },
        opts({ skeletonFn: (file) => (path.basename(file) === 'a.ts' ? '/* Failed to parse file: boom */' : `s${n++}`) }),
      );
      expect(result.parseFailures).toBe(1);
      expect(result.skeletonStable).toBe(false);
      const md = renderMarkdown([result]);
      expect(md).toMatch(/failed to parse/);
      expect(md).toMatch(/different skeletons/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('errors clearly when a target has no TypeScript files', () => {
    const root = makeTree({ 'readme.md': '# hi', 'only.d.ts': 'declare const x: 1;' });
    try {
      expect(() => measureTarget({ label: 'empty', root }, opts())).toThrow(/No \.ts or \.tsx files found/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('renderMarkdown', () => {
  it('prints a table and labels the dollar figure as an assumed rate', () => {
    const root = makeTree({ 'a.ts': 'x'.repeat(2000) });
    try {
      const result = measureTarget(
        { label: 'demo', root },
        { warmup: 1, runs: 5, skeletonFn: () => 'y'.repeat(400), now: (() => { let t = 0; return () => (t += 3); })(), countTokens: (s) => s.length },
      );
      const md = renderMarkdown([result]);
      expect(md.split('\n')[0]).toMatch(/^\| Target \| Files \| Lines \| Raw tokens \| Skeleton tokens \| Token reduction \| Input cost saved per query\*/);
      expect(md).toContain('| demo | 1 | 1 | 2,000 | 400 | 80.0% | $0.0040 |');
      expect(md).toContain('Assumed reference rate of $2.50 per 1M input tokens');
      expect(md).toContain('not a measured price');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('main', () => {
  it('exits 0 for --help, 2 for bad arguments, and 1 for a missing target', () => {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(main(['--help'])).toBe(0);
      expect(main(['--bogus'])).toBe(2);
      expect(main(['--targets', path.join(os.tmpdir(), 'skannr-no-such-dir-xyz')])).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toMatch(/Target not found/);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
