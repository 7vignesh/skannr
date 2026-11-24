/**
 * Tests for the accuracy harness. No network: the model is a stub, and fetch is
 * a fake. The real queries.json is checked against the real source, so a
 * refactor that moves a symbol makes this suite fail instead of silently
 * leaving the ground truth wrong.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildMessages,
  buildSections,
  callChat,
  checkBaseUrl,
  checkPrompts,
  classify,
  evidencePresence,
  loadQueries,
  main,
  mentions,
  parseArgs,
  parseQueries,
  prepare,
  redactRoot,
  redactSecret,
  renderContext,
  renderDryRun,
  renderResults,
  resolveProvider,
  runEval,
  scoreAnswer,
  validateQueries,
  type ChatMessage,
  type Provider,
  type Query,
} from '../benchmarks/accuracy-eval';

const REPO_ROOT = path.resolve(__dirname, '..');

function query(over: Partial<Query> = {}): Query {
  return {
    id: 'sample-question',
    category: 'edge-case',
    question: 'What does the function do when it fails?',
    requires: { files: ['src/a.ts'], symbols: ['runGuard'], terms: ['0.7'] },
    evidence: [{ file: 'src/a.ts', quote: 'const limit = 0.7;' }],
    groundTruth: 'It returns early.',
    ...over,
  };
}

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-ae-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

describe('the committed queries.json', () => {
  const queries = loadQueries(path.join(REPO_ROOT, 'benchmarks', 'queries.json'));

  it('has 8 valid questions across the four required kinds', () => {
    expect(queries).toHaveLength(8);
    expect(new Set(queries.map((q) => q.category))).toEqual(
      new Set(['entry-point-trace', 'exported-interface', 'stripping-rule', 'edge-case']),
    );
    expect(new Set(queries.map((q) => q.id)).size).toBe(8);
  });

  it('matches the current source: every file, quote, symbol and term exists', () => {
    expect(validateQueries(queries, REPO_ROOT)).toEqual([]);
  });

  it('only names files that the harness would read from inside the repo', () => {
    for (const q of queries) for (const f of q.requires.files) expect(f).toMatch(/^[\w./-]+$/);
  });
});

describe('parseQueries', () => {
  it('rejects a non-array and an empty array', () => {
    expect(() => parseQueries({}, 'q.json')).toThrow(/non-empty JSON array/);
    expect(() => parseQueries([], 'q.json')).toThrow(/non-empty JSON array/);
  });

  it('names the query and the field that is wrong', () => {
    const bad = [query(), { ...query({ id: 'second-one' }), category: 'nonsense' }];
    expect(() => parseQueries(bad, 'q.json')).toThrow(/Query 2 \(second-one\): category/);
  });

  it('rejects unknown fields, duplicate ids and a question with nothing to check', () => {
    expect(() => parseQueries([{ ...query(), extra: 1 }], 'q.json')).toThrow(/unrecognized/i);
    expect(() => parseQueries([query(), query()], 'q.json')).toThrow(/Duplicate query id: sample-question/);
    expect(() => parseQueries([query({ requires: { files: ['src/a.ts'], symbols: [], terms: [] } })], 'q.json')).toThrow(
      /at least one symbol or term/,
    );
  });

  it('rejects paths that could read outside the repository', () => {
    for (const bad of ['../secret.ts', '/etc/passwd', 'C:/Windows/x.ts', 'src\\a.ts', 'src/../../x.ts']) {
      expect(() => parseQueries([query({ requires: { files: [bad], symbols: ['x'], terms: [] } })], 'q.json')).toThrow(/repo-relative/);
    }
  });

  it('loadQueries reports unreadable and malformed files', () => {
    expect(() => loadQueries(path.join(os.tmpdir(), 'skannr-no-queries.json'))).toThrow(/Cannot read queries file/);
    const root = tree({ 'q.json': '{ not json' });
    try {
      expect(() => loadQueries(path.join(root, 'q.json'))).toThrow(/Cannot read queries file/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('validateQueries', () => {
  const root = tree({ 'src/a.ts': 'export function runGuard() {}\nconst limit = 0.7;\r\n' });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts ground truth that matches the source, including across CRLF', () => {
    expect(validateQueries([query()], root)).toEqual([]);
  });

  it('catches a fabricated quote, a missing symbol, a missing term and a missing file', () => {
    const problems = validateQueries(
      [
        query({ id: 'fake-quote', evidence: [{ file: 'src/a.ts', quote: 'const limit = 0.9;' }] }),
        query({ id: 'fake-symbol', requires: { files: ['src/a.ts'], symbols: ['ghostFunction'], terms: [] } }),
        query({ id: 'fake-term', requires: { files: ['src/a.ts'], symbols: ['runGuard'], terms: ['99'] } }),
        query({ id: 'no-file', requires: { files: ['src/gone.ts'], symbols: ['x'], terms: [] }, evidence: [{ file: 'src/gone.ts', quote: 'x' }] }),
      ],
      root,
    );
    expect(problems.join('\n')).toMatch(/fake-quote: evidence quote not found/);
    expect(problems.join('\n')).toMatch(/fake-symbol: symbol "ghostFunction"/);
    expect(problems.join('\n')).toMatch(/fake-term: term "99"/);
    expect(problems.join('\n')).toMatch(/no-file: required file not found: src\/gone\.ts/);
  });

  it('requires evidence to come from a file the question lists', () => {
    const problems = validateQueries([query({ evidence: [{ file: 'src/b.ts', quote: 'x' }] })], root);
    expect(problems.join('\n')).toMatch(/not listed in requires\.files/);
  });
});

describe('mentions and scoreAnswer', () => {
  it('matches whole identifiers, not fragments of longer ones', () => {
    expect(mentions('it calls runGuard() next', 'runGuard')).toBe(true);
    expect(mentions('it calls runGuardReview next', 'runGuard')).toBe(false);
    expect(mentions('at most 150 chars', '50')).toBe(false);
    expect(mentions('shorter than 50 chars', '50')).toBe(true);
    expect(mentions('confidence >= 0.75', '0.7')).toBe(false);
    expect(mentions('confidence >= 0.7 and', '0.7')).toBe(true);
  });

  it('matches tokens that start or end with punctuation as plain substrings', () => {
    expect(mentions("no '{' and no '=>' allowed", '=>')).toBe(true);
    expect(mentions('uses /* trimmed */ placeholders', '/* trimmed */')).toBe(true);
    expect(mentions('uses trimmed placeholders', '/* trimmed */')).toBe(false);
  });

  it('treats regex characters in a token literally', () => {
    expect(mentions('version 1x2', '1.2')).toBe(false);
    expect(mentions('version 1.2', '1.2')).toBe(true);
  });

  it('passes only when every file, symbol and term is named', () => {
    const q = query();
    expect(scoreAnswer(q, 'In src/a.ts, runGuard stops at 0.7.').pass).toBe(true);
    const partial = scoreAnswer(q, 'runGuard stops at 0.7.');
    expect(partial.pass).toBe(false);
    expect(partial.missing).toEqual({ files: ['src/a.ts'], symbols: [], terms: [] });
    expect(scoreAnswer(q, 'src/a.ts has runGuard.').missing.terms).toEqual(['0.7']);
  });

  it('accepts Windows separators in a file path', () => {
    expect(scoreAnswer(query(), 'See src\\a.ts: runGuard, 0.7').pass).toBe(true);
  });

  it('is not fooled by a file path that only contains the required one as a suffix of a word', () => {
    expect(scoreAnswer(query(), 'See mysrc/a.ts: runGuard, 0.7').pass).toBe(false);
  });
});

describe('contexts and prompts', () => {
  const root = tree({ 'src/a.ts': 'export function runGuard() {\r\n  return 1;\r\n}\r\n', 'src/b.ts': 'export const b = 2;\n' });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('builds raw sections from the source with LF line endings, and skeleton sections from the skeleton function', () => {
    const raw = buildSections('raw', ['src/a.ts'], root, () => 'IGNORED');
    expect(raw[0].text).toBe('export function runGuard() {\n  return 1;\n}\n');
    const skel = buildSections('skeleton', ['src/a.ts', 'src/b.ts'], root, (abs) => `SK(${path.basename(abs)})`);
    expect(skel.map((s) => s.text)).toEqual(['SK(a.ts)', 'SK(b.ts)']);
  });

  it('removes the local repository path from skeletons, in both slash styles and any case', () => {
    const forward = root.split('\\').join('/');
    const text = `import("${forward}/src/x").Foo and ${root}\\src\\y and ${forward.toUpperCase()}/z`;
    const cleaned = redactRoot(text, root);
    expect(cleaned.toLowerCase()).not.toContain(forward.toLowerCase());
    expect(cleaned).toContain('import("/src/x").Foo');
  });

  it('labels each file in the rendered context and says what kind of context it is', () => {
    const ctx = renderContext([{ file: 'src/a.ts', text: 'A' }, { file: 'src/b.ts', text: 'B' }]);
    expect(ctx).toBe('=== FILE: src/a.ts ===\nA\n\n=== FILE: src/b.ts ===\nB');
    const raw = buildMessages('Q?', ctx, 'raw');
    const skel = buildMessages('Q?', ctx, 'skeleton');
    expect(raw[0].role).toBe('system');
    expect(raw[1].content).toContain('full source');
    expect(skel[1].content).toContain('skeletons');
    expect(raw[1].content.endsWith('Question: Q?')).toBe(true);
  });

  it('checks which cited lines a context keeps, per file and verbatim', () => {
    const q = query({
      evidence: [
        { file: 'src/a.ts', quote: 'const limit = 0.7;' },
        { file: 'src/a.ts', quote: 'return 1;' },
        { file: 'src/b.ts', quote: 'const limit = 0.7;' },
      ],
    });
    const sections = [{ file: 'src/a.ts', text: 'const limit = 0.7;' }];
    const found = evidencePresence(q, sections);
    expect(found.present).toHaveLength(1);
    expect(found.missing.map((e) => e.quote)).toEqual(['return 1;', 'const limit = 0.7;']);
  });

  it('prepares both prompts per question, builds each skeleton once, and reports the cited lines the skeleton keeps', () => {
    const calls: string[] = [];
    const q = query({
      requires: { files: ['src/a.ts'], symbols: ['runGuard'], terms: [] },
      evidence: [{ file: 'src/a.ts', quote: 'export function runGuard() {' }, { file: 'src/a.ts', quote: 'return 1;' }],
    });
    const prepared = prepare([q, { ...q, id: 'second-question' }], root, (abs) => {
      calls.push(abs);
      return 'export function runGuard() {\n  /* trimmed */\n}';
    });
    expect(calls).toHaveLength(1);
    expect(prepared).toHaveLength(2);
    expect(prepared[0].evidence.presentInSkeleton.map((e) => e.quote)).toEqual(['export function runGuard() {']);
    expect(prepared[0].evidence.missingFromSkeleton.map((e) => e.quote)).toEqual(['return 1;']);
    expect(prepared[0].raw.tokens).toBeGreaterThan(0);
  });

  it('flags a prompt over the token budget and a prompt that carries the local path', () => {
    const q = query({ requires: { files: ['src/a.ts'], symbols: ['runGuard'], terms: [] }, evidence: [{ file: 'src/a.ts', quote: 'return 1;' }] });
    const ok = prepare([q], root, () => 'tiny');
    expect(checkPrompts(ok, root, 100_000)).toEqual([]);
    expect(checkPrompts(ok, root, 5).join('\n')).toMatch(/over the 5 budget/);
    // buildSections redacts a skeleton, so a skeleton function that embeds the path is cleaned.
    const leaky = prepare([q], root, () => `import("${root.split('\\').join('/')}/src/x")`);
    expect(checkPrompts(leaky, root, 100_000)).toEqual([]);
    // checkPrompts is the second line of defence: a prompt that still carries the path is reported.
    const forced = { ...ok[0], raw: { ...ok[0].raw, messages: [{ role: 'user', content: `path ${root}` } as ChatMessage] } };
    expect(checkPrompts([forced], root, 100_000).join('\n')).toMatch(/contains the local repository path/);
  });
});

describe('provider selection and request safety', () => {
  it('prefers OpenRouter, falls back to OpenAI, and errors with no key', () => {
    const both = resolveProvider({ OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' }) as Provider;
    expect(both.name).toBe('openrouter');
    expect(both.model).toBe('openai/gpt-4o');
    const oa = resolveProvider({ OPENAI_API_KEY: 'oa-key' }) as Provider;
    expect(oa.name).toBe('openai');
    expect(oa.baseUrl).toBe('https://api.openai.com/v1');
    expect('error' in resolveProvider({})).toBe(true);
    expect('error' in resolveProvider({ OPENAI_API_KEY: '   ' })).toBe(true);
  });

  it('lets --model and --base-url override, and strips trailing slashes', () => {
    const p = resolveProvider({ OPENAI_API_KEY: 'k' }, { model: 'gpt-x', baseUrl: 'http://localhost:11434/v1/' }) as Provider;
    expect(p.model).toBe('gpt-x');
    expect(p.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('refuses to send a key over plain http to a remote host, or to a malformed URL', () => {
    expect(checkBaseUrl('https://example.com/v1')).toBeNull();
    expect(checkBaseUrl('http://localhost:8080/v1')).toBeNull();
    expect(checkBaseUrl('http://127.0.0.1:8080')).toBeNull();
    expect(checkBaseUrl('http://example.com/v1')).toMatch(/Refusing to send an API key/);
    expect(checkBaseUrl('ftp://example.com')).toMatch(/Refusing/);
    expect(checkBaseUrl('not a url')).toMatch(/Invalid base URL/);
    const r = resolveProvider({ OPENAI_API_KEY: 'k' }, { baseUrl: 'http://evil.example/v1' });
    expect('error' in r && r.error).toMatch(/Refusing/);
  });

  it('removes the key from error text', () => {
    expect(redactSecret('bad key sk-123 and sk-123', 'sk-123')).toBe('bad key [redacted] and [redacted]');
    expect(redactSecret('nothing', '')).toBe('nothing');
  });
});

describe('callChat', () => {
  const provider: Provider = { name: 'openai', apiKey: 'sk-secret-key', baseUrl: 'https://api.example.test/v1', model: 'm' };
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
  const reply = (status: number, body: string): typeof fetch =>
    (async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }) as unknown as Response) as typeof fetch;

  it('posts the model, messages and zero temperature with a bearer key, and returns the text', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'the answer' } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await callChat(provider, messages, fetchFn)).toBe('the answer');
    expect(seen!.url).toBe('https://api.example.test/v1/chat/completions');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-secret-key');
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toMatchObject({ model: 'm', temperature: 0, messages });
  });

  it('turns an HTTP error into a message that never contains the key', async () => {
    const echo = reply(401, 'Incorrect API key provided: sk-secret-key');
    const err = await callChat(provider, messages, echo).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 401/);
    expect(String(err)).not.toContain('sk-secret-key');
    expect(String(err)).toContain('[redacted]');
  });

  it('rejects an unreadable body and a missing answer', async () => {
    await expect(callChat(provider, messages, reply(200, 'not json'))).rejects.toThrow(/not valid JSON/);
    await expect(callChat(provider, messages, reply(200, JSON.stringify({ choices: [] })))).rejects.toThrow(/no answer text/);
    await expect(callChat(provider, messages, reply(200, JSON.stringify({ choices: [{ message: { content: '  ' } }] })))).rejects.toThrow(/no answer text/);
  });

  it('wraps a network failure without leaking the key', async () => {
    const boom = (async () => {
      throw new Error('connect failed for Bearer sk-secret-key');
    }) as unknown as typeof fetch;
    const err = await callChat(provider, messages, boom).catch((e: Error) => e);
    expect(String(err)).toMatch(/Request failed/);
    expect(String(err)).not.toContain('sk-secret-key');
  });
});

describe('classify', () => {
  it('names each combination, and only blames pruning when a cited line is missing from the skeleton', () => {
    expect(classify('pass', 'pass', 0)).toBe('both-pass');
    expect(classify('pass', 'fail', 2)).toBe('skeleton-lost-detail');
    expect(classify('pass', 'fail', 0)).toBe('skeleton-fail-evidence-present');
    expect(classify('fail', 'pass', 1)).toBe('skeleton-only-pass');
    expect(classify('fail', 'fail', 1)).toBe('both-fail');
    expect(classify('error', 'pass', 0)).toBe('incomplete');
    expect(classify('pass', 'error', 0)).toBe('incomplete');
  });
});

describe('runEval and renderResults', () => {
  const root = tree({ 'src/a.ts': 'export function runGuard() {\n  const limit = 0.7;\n}\n' });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const q = query({ evidence: [{ file: 'src/a.ts', quote: 'const limit = 0.7;' }] });
  const skeletonFn = () => 'export function runGuard() {\n  /* trimmed */\n}';

  it('asks each question once per context, scores each answer, and records a skeleton that lost the detail', async () => {
    const prepared = prepare([q], root, skeletonFn);
    const asked: string[] = [];
    const ask = async (messages: ChatMessage[]): Promise<string> => {
      asked.push(messages[1].content.includes('full source') ? 'raw' : 'skeleton');
      return messages[1].content.includes('const limit = 0.7;') ? 'src/a.ts: runGuard uses 0.7' : 'src/a.ts: runGuard has a limit';
    };
    const results = await runEval(prepared, ask);
    expect(asked).toEqual(['raw', 'skeleton']);
    expect(results[0].raw.status).toBe('pass');
    expect(results[0].skeleton.status).toBe('fail');
    expect(results[0].skeleton.missing?.terms).toEqual(['0.7']);
    expect(results[0].outcome).toBe('skeleton-lost-detail');
    expect(results[0].evidenceMissingFromSkeleton).toEqual(['src/a.ts: const limit = 0.7;']);
    const text = renderResults(results);
    expect(text).toMatch(/\| sample-question \| edge-case \| pass \| FAIL \| 0 of 1 \| skeleton-lost-detail \|/);
    expect(text).toMatch(/Where the skeleton lacked source lines/);
    expect(text).toMatch(/missing terms 0\.7/);
    expect(text).toMatch(/Scoring is mechanical/);
  });

  it('records a failed request as an error, keeps going, and marks the question incomplete', async () => {
    const prepared = prepare([q, { ...q, id: 'second-question' }], root, skeletonFn);
    let n = 0;
    const ask = async (): Promise<string> => {
      if (n++ === 0) throw new Error('rate limited');
      return 'src/a.ts runGuard 0.7';
    };
    const results = await runEval(prepared, ask);
    expect(results).toHaveLength(2);
    expect(results[0].raw).toMatchObject({ status: 'error', error: 'rate limited' });
    expect(results[0].outcome).toBe('incomplete');
    expect(results[1].outcome).toBe('both-pass');
    expect(renderResults(results)).toMatch(/\(1 errors\)/);
  });

  it('reports the dry-run table without scoring anything', () => {
    const text = renderDryRun(prepare([q], root, skeletonFn), 100_000);
    expect(text).toMatch(/\| sample-question \| edge-case \|/);
    expect(text).toMatch(/Dry run: no model was called, no answers were scored\./);
    expect(text).toMatch(/keeps 0 of 1 cited source lines/);
  });
});

describe('parseArgs', () => {
  it('parses flags and applies defaults', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, help: false, maxContextTokens: 100_000 });
    expect(parseArgs(['--dry-run', '--model', 'm', '--base-url', 'https://x.test', '--max-context-tokens', '5000'])).toEqual({
      dryRun: true,
      help: false,
      model: 'm',
      baseUrl: 'https://x.test',
      maxContextTokens: 5000,
    });
  });

  it('rejects missing values, bad numbers and unknown flags', () => {
    expect(() => parseArgs(['--model'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--model', '--dry-run'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--max-context-tokens', 'abc'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--max-context-tokens', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});

describe('main', () => {
  function harness(over: Partial<Parameters<typeof main>[1]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const fetchFn = jest.fn();
    const skeletonFn = jest.fn(() => 'export function x() {\n  /* trimmed */\n}');
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skannr-ae-res-'));
    const deps = {
      env: {},
      fetchFn: fetchFn as unknown as typeof fetch,
      skeletonFn,
      resultsFile: path.join(resultsDir, 'accuracy-eval.json'),
      out: (t: string) => void out.push(t),
      err: (t: string) => void err.push(t),
      ...over,
    };
    return { deps, out, err, fetchFn, skeletonFn, resultsDir, text: () => out.join('') + err.join('') };
  }

  it('--dry-run succeeds with no key, builds prompts, and makes no network call even when a key is set', async () => {
    const h = harness({ env: { OPENROUTER_API_KEY: 'or-secret-123' } });
    try {
      expect(await main(['--dry-run'], h.deps)).toBe(0);
      expect(h.fetchFn).not.toHaveBeenCalled();
      expect(h.skeletonFn).toHaveBeenCalled();
      expect(h.out.join('')).toMatch(/Dry run: no model was called/);
      expect(h.out.join('')).toContain('entry-skeleton-call');
      expect(fs.existsSync(h.deps.resultsFile)).toBe(false);
      expect(h.text()).not.toContain('or-secret-123');
    } finally {
      fs.rmSync(h.resultsDir, { recursive: true, force: true });
    }
  });

  it('without a key and without --dry-run it exits 2 before building anything or calling out', async () => {
    const h = harness();
    try {
      expect(await main([], h.deps)).toBe(2);
      expect(h.err.join('')).toMatch(/No API key/);
      expect(h.fetchFn).not.toHaveBeenCalled();
      expect(h.skeletonFn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(h.resultsDir, { recursive: true, force: true });
    }
  });

  it('exits 2 for bad arguments and 0 for --help', async () => {
    const h = harness();
    try {
      expect(await main(['--bogus'], h.deps)).toBe(2);
      expect(await main(['--help'], h.deps)).toBe(0);
      expect(h.out.join('')).toMatch(/Usage: npm run bench:eval/);
    } finally {
      fs.rmSync(h.resultsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 and names the query when queries.json is malformed or no longer matches the source', async () => {
    const dir = tree({
      'bad-schema.json': JSON.stringify([{ id: 'broken-one', category: 'nope' }]),
      'stale.json': JSON.stringify([
        query({
          id: 'stale-one',
          requires: { files: ['src/index.ts'], symbols: ['neverExisted'], terms: [] },
          evidence: [{ file: 'src/index.ts', quote: 'no such line anywhere' }],
        }),
      ]),
    });
    const h = harness();
    try {
      expect(await main(['--dry-run'], { ...h.deps, queriesFile: path.join(dir, 'bad-schema.json') })).toBe(1);
      expect(h.err.join('')).toMatch(/Query 1 \(broken-one\)/);
      expect(await main(['--dry-run'], { ...h.deps, queriesFile: path.join(dir, 'stale.json') })).toBe(1);
      expect(h.err.join('')).toMatch(/stale-one: symbol "neverExisted"/);
      expect(h.err.join('')).toMatch(/does not match the source/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(h.resultsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when a prompt is over the token budget', async () => {
    const h = harness();
    try {
      expect(await main(['--dry-run', '--max-context-tokens', '10'], h.deps)).toBe(1);
      expect(h.err.join('')).toMatch(/over the 10 budget/);
    } finally {
      fs.rmSync(h.resultsDir, { recursive: true, force: true });
    }
  });

  it('runs live against a fake endpoint, writes the results file, and never prints or stores the key', async () => {
    const key = 'sk-live-secret-abcdef';
    const answer = JSON.stringify({ choices: [{ message: { content: 'I do not know.' } }] });
    const h = harness({ env: { OPENAI_API_KEY: key } });
    h.fetchFn.mockImplementation(async () => ({ ok: true, status: 200, text: async () => answer }));
    try {
      const code = await main([], h.deps);
      expect(h.fetchFn).toHaveBeenCalledTimes(16);
      expect(code).toBe(0);
      const saved = fs.readFileSync(h.deps.resultsFile, 'utf-8');
      const json = JSON.parse(saved);
      expect(json.provider).toBe('openai');
      expect(json.endpoint).toBe('api.openai.com');
      expect(json.temperature).toBe(0);
      expect(json.results).toHaveLength(8);
      expect(json.results.every((r: { raw: { status: string } }) => r.raw.status === 'fail')).toBe(true);
      expect(saved).not.toContain(key);
      expect(h.text()).not.toContain(key);
      const sent = h.fetchFn.mock.calls.map((c) => String(c[1].body)).join('');
      expect(sent).not.toContain(REPO_ROOT.split('\\').join('/'));
    } finally {
      fs.rmSync(h.resultsDir, { recursive: true, force: true });
    }
  });

  it('exits 1 after a failed request but still writes the questions that completed', async () => {
    const h = harness({ env: { OPENAI_API_KEY: 'sk-key-xyz' } });
    h.fetchFn.mockImplementation(async () => ({ ok: false, status: 429, text: async () => 'rate limit for sk-key-xyz' }));
    try {
      expect(await main([], h.deps)).toBe(1);
      const saved = fs.readFileSync(h.deps.resultsFile, 'utf-8');
      expect(JSON.parse(saved).results[0].raw.status).toBe('error');
      expect(saved).not.toContain('sk-key-xyz');
    } finally {
      fs.rmSync(h.resultsDir, { recursive: true, force: true });
    }
  });
});
