/**
 * Accuracy evaluation: does a model answer architecture questions about skannr
 * as well from AST skeletons as from the full source?
 *
 * Each question in benchmarks/queries.json names the files that hold the
 * answer. The harness builds two contexts from exactly those files (the raw
 * source, and skannr's skeletons of the same files), asks the model the same
 * question with each, and scores the answers against the ground truth.
 *
 * Scoring is mechanical, not model-judged: an answer passes only if it names
 * every required file path, symbol and term. That checks that the answer
 * contains the right identifiers, not that its reasoning is right, so read the
 * stored answers before drawing conclusions.
 *
 * Usage:
 *   npm run bench:eval -- --dry-run          validate everything, no network
 *   OPENROUTER_API_KEY=... npm run bench:eval
 *   OPENAI_API_KEY=...     npm run bench:eval
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { buildSkeletonForFile } from '../src/skeletonizer';
import { countSourceTokens, normalizeEol } from './token-bench';

const REPO_ROOT = path.resolve(__dirname, '..');
const QUERIES_FILE = path.join(__dirname, 'queries.json');
const RESULTS_FILE = path.join(__dirname, 'results', 'accuracy-eval.json');

/** Per-prompt input budget. Below the 128k window of the default model, leaving room for the answer. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ANSWER_TOKENS = 700;

// ---------------------------------------------------------------------------
// Query file
// ---------------------------------------------------------------------------

/** Repo-relative, forward-slash path with no `..`. The harness reads these and sends them to a model. */
const repoRelativePath = z
  .string()
  .min(1)
  .refine(
    (p) => !path.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..'),
    'must be a repo-relative path with forward slashes and no ".."',
  );

const EvidenceSchema = z.object({ file: repoRelativePath, quote: z.string().min(1) }).strict();

export const CATEGORIES = ['entry-point-trace', 'exported-interface', 'stripping-rule', 'edge-case'] as const;

const QuerySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase words joined by hyphens'),
    category: z.enum(CATEGORIES),
    question: z.string().min(10),
    requires: z
      .object({
        files: z.array(repoRelativePath).min(1),
        symbols: z.array(z.string().min(1)),
        terms: z.array(z.string().min(1)),
      })
      .strict()
      .refine((r) => r.symbols.length + r.terms.length > 0, 'needs at least one symbol or term, or any answer naming the file would pass'),
    evidence: z.array(EvidenceSchema).min(1),
    groundTruth: z.string().min(1),
  })
  .strict();

export type Query = z.infer<typeof QuerySchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Validate the parsed JSON. Throws one readable message naming each bad query. */
export function parseQueries(raw: unknown, source: string): Query[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${source} must be a non-empty JSON array`);
  const queries: Query[] = [];
  const problems: string[] = [];
  raw.forEach((item, i) => {
    const parsed = QuerySchema.safeParse(item);
    const label = `Query ${i + 1}${typeof (item as { id?: unknown })?.id === 'string' ? ` (${(item as { id: string }).id})` : ''}`;
    if (parsed.success) {
      queries.push(parsed.data);
    } else {
      for (const issue of parsed.error.issues) problems.push(`${label}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  });
  const seen = new Set<string>();
  for (const q of queries) {
    if (seen.has(q.id)) problems.push(`Duplicate query id: ${q.id}`);
    seen.add(q.id);
  }
  if (problems.length > 0) throw new Error(`${source} is invalid:\n  ${problems.join('\n  ')}`);
  return queries;
}

export function loadQueries(file: string): Query[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot read queries file ${file}: ${err instanceof Error ? err.message : err}`);
  }
  return parseQueries(raw, path.basename(file));
}

/**
 * Check the ground truth against the repository: every file exists, every
 * evidence quote and every symbol and term really appears in the files the
 * question names. Returns a list of problems (empty when the set is sound).
 */
export function validateQueries(queries: Query[], root: string): string[] {
  const problems: string[] = [];
  const text = new Map<string, string | null>();
  const read = (rel: string): string | null => {
    if (!text.has(rel)) {
      try {
        text.set(rel, normalizeEol(fs.readFileSync(path.join(root, rel), 'utf-8')));
      } catch {
        text.set(rel, null);
      }
    }
    return text.get(rel) ?? null;
  };

  for (const q of queries) {
    const own = (msg: string): void => void problems.push(`${q.id}: ${msg}`);
    for (const f of q.requires.files) if (read(f) === null) own(`required file not found: ${f}`);
    const joined = q.requires.files.map((f) => read(f) ?? '').join('\n');
    for (const s of q.requires.symbols) if (!mentions(joined, s)) own(`symbol "${s}" does not appear in the required files`);
    for (const t of q.requires.terms) if (!mentions(joined, t)) own(`term "${t}" does not appear in the required files`);
    for (const e of q.evidence) {
      if (!q.requires.files.includes(e.file)) own(`evidence file ${e.file} is not listed in requires.files`);
      const body = read(e.file);
      if (body === null) own(`evidence file not found: ${e.file}`);
      else if (!body.includes(e.quote)) own(`evidence quote not found in ${e.file}: ${e.quote.slice(0, 70)}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Whole-token match. A word edge must not touch another word character, so
 * `runGuard` is not found inside `runGuardReview`, `50` is not found in `150`,
 * and `0.7` is not found in `0.75`. Tokens that start or end with punctuation
 * (such as `=>` or the trimmed-body placeholder) match as plain substrings on that side.
 */
export function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^\w/.test(token) ? '(?<!\\w)' : '';
  const after = /\w$/.test(token) ? '(?!\\w)' : '';
  return new RegExp(before + escaped + after).test(text);
}

export interface Score {
  pass: boolean;
  missing: { files: string[]; symbols: string[]; terms: string[] };
}

/** Pass only if the answer names every required file path, symbol and term. */
export function scoreAnswer(query: Query, answer: string): Score {
  const withSlashes = answer.split('\\').join('/');
  const missing = {
    files: query.requires.files.filter((f) => !mentions(withSlashes, f)),
    symbols: query.requires.symbols.filter((s) => !mentions(answer, s)),
    terms: query.requires.terms.filter((t) => !mentions(answer, t)),
  };
  return { pass: missing.files.length + missing.symbols.length + missing.terms.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Contexts and prompts
// ---------------------------------------------------------------------------

export type ContextKind = 'raw' | 'skeleton';
export interface Section {
  file: string;
  text: string;
}
export type SkeletonFn = (absoluteFile: string, root: string) => string;

/**
 * Remove the repository's absolute path from text. Skeleton type annotations
 * can embed it (`import("D:/work/skannr/src/x").Foo`), and it must not be sent
 * to a third party.
 */
export function redactRoot(text: string, root: string): string {
  const forms = new Set([root, root.split('\\').join('/')]);
  let out = text;
  for (const form of forms) {
    if (form.length < 2) continue;
    out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return out;
}

export function buildSections(kind: ContextKind, files: string[], root: string, skeletonFn: SkeletonFn): Section[] {
  return files.map((file) => {
    const abs = path.join(root, file);
    const text =
      kind === 'raw'
        ? normalizeEol(fs.readFileSync(abs, 'utf-8'))
        : redactRoot(normalizeEol(skeletonFn(abs, root)), root);
    return { file, text };
  });
}

export function renderContext(sections: Section[]): string {
  return sections.map((s) => `=== FILE: ${s.file} ===\n${s.text}`).join('\n\n');
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export const SYSTEM_PROMPT = [
  'You are answering questions about a TypeScript codebase. Use only the context provided.',
  'Refer to every source file by its repo-relative path exactly as it appears in the context headers (for example src/index.ts).',
  'Name functions, classes and interfaces exactly as written in the code.',
  'If the context does not contain what is needed to answer, say what is missing instead of guessing.',
  'Answer in at most six sentences.',
].join(' ');

export function buildMessages(question: string, context: string, kind: ContextKind): ChatMessage[] {
  const what =
    kind === 'raw'
      ? 'The full source of the relevant files.'
      : 'AST skeletons of the relevant files: declarations and signatures, with function bodies replaced by placeholders.';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Context (${what})\n\n${context}\n\nQuestion: ${question}` },
  ];
}

export function promptTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + countSourceTokens(m.content), 0);
}

/** Which required evidence lines appear in a context, checked per file and verbatim. */
export function evidencePresence(query: Query, sections: Section[]): { present: Evidence[]; missing: Evidence[] } {
  const present: Evidence[] = [];
  const missing: Evidence[] = [];
  for (const e of query.evidence) {
    const section = sections.find((s) => s.file === e.file);
    (section && section.text.includes(e.quote) ? present : missing).push(e);
  }
  return { present, missing };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface Provider {
  name: 'openrouter' | 'openai';
  apiKey: string;
  baseUrl: string;
  model: string;
}

type Env = Record<string, string | undefined>;

/** Plain http is allowed only for a local endpoint, so the key is never sent in the clear over a network. */
export function checkBaseUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `Invalid base URL: ${url}`;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return null;
  return `Refusing to send an API key to ${u.protocol}//${u.host}: use https, or http only for localhost.`;
}

/** OPENROUTER_API_KEY wins over OPENAI_API_KEY when both are set. Returns an error message if neither is. */
export function resolveProvider(env: Env, opts: { model?: string; baseUrl?: string } = {}): Provider | { error: string } {
  const openrouter = env.OPENROUTER_API_KEY?.trim();
  const openai = env.OPENAI_API_KEY?.trim();
  if (!openrouter && !openai) {
    return { error: 'No API key. Set OPENROUTER_API_KEY or OPENAI_API_KEY, or use --dry-run to validate without calling a model.' };
  }
  const provider: Provider = openrouter
    ? { name: 'openrouter', apiKey: openrouter, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o' }
    : { name: 'openai', apiKey: openai as string, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' };
  if (opts.model) provider.model = opts.model;
  if (opts.baseUrl) provider.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const problem = checkBaseUrl(provider.baseUrl);
  return problem ? { error: problem } : provider;
}

export type FetchFn = typeof fetch;

/** Replace the key wherever an error message echoes it. */
export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

export async function callChat(provider: Provider, messages: ChatMessage[], fetchFn: FetchFn = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, messages, temperature: 0, max_tokens: MAX_ANSWER_TOKENS }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(redactSecret(`Request failed: ${err instanceof Error ? err.message : err}`, provider.apiKey));
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(redactSecret(`HTTP ${response.status}: ${body.slice(0, 300)}`, provider.apiKey));
  }
  let json: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('The response was not valid JSON.');
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new Error('The response had no answer text.');
  return content;
}

// ---------------------------------------------------------------------------
// Running and reporting
// ---------------------------------------------------------------------------

export type Status = 'pass' | 'fail' | 'error';

export interface ContextResult {
  status: Status;
  promptTokens: number;
  answer?: string;
  error?: string;
  missing?: Score['missing'];
}

export type Outcome =
  | 'both-pass'
  | 'skeleton-lost-detail'
  | 'skeleton-fail-evidence-present'
  | 'skeleton-only-pass'
  | 'both-fail'
  | 'incomplete';

/**
 * Explain a pair of results. `skeleton-lost-detail` means the raw context passed,
 * the skeleton context failed, and some of the source lines the answer depends
 * on are not in the skeleton. It points at pruning but does not prove it: the
 * model may also have simply answered badly.
 */
export function classify(raw: Status, skeleton: Status, evidenceMissingFromSkeleton: number): Outcome {
  if (raw === 'error' || skeleton === 'error') return 'incomplete';
  if (raw === 'pass' && skeleton === 'pass') return 'both-pass';
  if (raw === 'pass') return evidenceMissingFromSkeleton > 0 ? 'skeleton-lost-detail' : 'skeleton-fail-evidence-present';
  if (skeleton === 'pass') return 'skeleton-only-pass';
  return 'both-fail';
}

export interface Prepared {
  query: Query;
  raw: { messages: ChatMessage[]; tokens: number };
  skeleton: { messages: ChatMessage[]; tokens: number };
  evidence: { presentInSkeleton: Evidence[]; missingFromSkeleton: Evidence[] };
}

/** Build both prompts for every query. Skeletons are built once per file. */
export function prepare(queries: Query[], root: string, skeletonFn: SkeletonFn): Prepared[] {
  const cache = new Map<string, string>();
  const cachedSkeleton: SkeletonFn = (abs, r) => {
    if (!cache.has(abs)) cache.set(abs, skeletonFn(abs, r));
    return cache.get(abs) as string;
  };
  return queries.map((query) => {
    const rawSections = buildSections('raw', query.requires.files, root, cachedSkeleton);
    const skelSections = buildSections('skeleton', query.requires.files, root, cachedSkeleton);
    const rawMessages = buildMessages(query.question, renderContext(rawSections), 'raw');
    const skelMessages = buildMessages(query.question, renderContext(skelSections), 'skeleton');
    const ev = evidencePresence(query, skelSections);
    return {
      query,
      raw: { messages: rawMessages, tokens: promptTokens(rawMessages) },
      skeleton: { messages: skelMessages, tokens: promptTokens(skelMessages) },
      evidence: { presentInSkeleton: ev.present, missingFromSkeleton: ev.missing },
    };
  });
}

/** Problems that make a run unsafe or meaningless: budget overruns and a leaked local path. */
export function checkPrompts(prepared: Prepared[], root: string, maxTokens: number): string[] {
  const problems: string[] = [];
  const forms = [root, root.split('\\').join('/')].filter((f) => f.length > 1);
  for (const p of prepared) {
    for (const kind of ['raw', 'skeleton'] as const) {
      const prompt = p[kind];
      if (prompt.tokens > maxTokens) problems.push(`${p.query.id}: ${kind} prompt is ${prompt.tokens} tokens, over the ${maxTokens} budget`);
      const text = prompt.messages.map((m) => m.content).join('\n').toLowerCase();
      if (forms.some((f) => text.includes(f.toLowerCase()))) problems.push(`${p.query.id}: ${kind} prompt contains the local repository path`);
    }
  }
  return problems;
}

export interface QuestionResult {
  id: string;
  category: Query['category'];
  question: string;
  raw: ContextResult;
  skeleton: ContextResult;
  evidenceLinesTotal: number;
  evidenceLinesInSkeleton: number;
  evidenceMissingFromSkeleton: string[];
  outcome: Outcome;
}

export type Ask = (messages: ChatMessage[]) => Promise<string>;

async function askAndScore(ask: Ask, query: Query, prompt: Prepared['raw']): Promise<ContextResult> {
  try {
    const answer = await ask(prompt.messages);
    const score = scoreAnswer(query, answer);
    return { status: score.pass ? 'pass' : 'fail', promptTokens: prompt.tokens, answer, missing: score.missing };
  } catch (err) {
    return { status: 'error', promptTokens: prompt.tokens, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Ask every question with both contexts, one request at a time. A failed request is recorded and the run continues. */
export async function runEval(prepared: Prepared[], ask: Ask, onProgress?: (line: string) => void): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];
  for (const p of prepared) {
    onProgress?.(`${p.query.id} ...`);
    const raw = await askAndScore(ask, p.query, p.raw);
    const skeleton = await askAndScore(ask, p.query, p.skeleton);
    results.push({
      id: p.query.id,
      category: p.query.category,
      question: p.query.question,
      raw,
      skeleton,
      evidenceLinesTotal: p.query.evidence.length,
      evidenceLinesInSkeleton: p.evidence.presentInSkeleton.length,
      evidenceMissingFromSkeleton: p.evidence.missingFromSkeleton.map((e) => `${e.file}: ${e.quote}`),
      outcome: classify(raw.status, skeleton.status, p.evidence.missingFromSkeleton.length),
    });
  }
  return results;
}

const nf = new Intl.NumberFormat('en-US');
const mark = (s: Status): string => (s === 'pass' ? 'pass' : s === 'fail' ? 'FAIL' : 'ERROR');

export function renderDryRun(prepared: Prepared[], maxTokens: number): string {
  const lines = [
    '| Question | Category | Raw prompt tokens | Skeleton prompt tokens | Source lines the answer cites that the skeleton keeps |',
    '|---|---|---:|---:|---:|',
  ];
  for (const p of prepared) {
    lines.push(
      `| ${p.query.id} | ${p.query.category} | ${nf.format(p.raw.tokens)} | ${nf.format(p.skeleton.tokens)} | ${p.evidence.presentInSkeleton.length} of ${p.query.evidence.length} |`,
    );
  }
  const kept = prepared.reduce((s, p) => s + p.evidence.presentInSkeleton.length, 0);
  const total = prepared.reduce((s, p) => s + p.query.evidence.length, 0);
  const noneKept = prepared.filter((p) => p.evidence.presentInSkeleton.length === 0).length;
  const largest = Math.max(...prepared.flatMap((p) => [p.raw.tokens, p.skeleton.tokens]));
  lines.push('');
  lines.push(`Questions: ${prepared.length}. Largest prompt: ${nf.format(largest)} tokens (budget ${nf.format(maxTokens)}).`);
  lines.push(`The skeleton keeps ${kept} of ${total} cited source lines verbatim; ${noneKept} question(s) cite no line the skeleton keeps.`);
  lines.push('A cited line missing from the skeleton does not mean the question cannot be answered from it (signatures and the placeholder text are kept). It marks where the answer depends on a function body.');
  lines.push('Dry run: no model was called, no answers were scored.');
  return lines.join('\n');
}

export function renderResults(results: QuestionResult[]): string {
  const lines = [
    '| Question | Category | Raw context | Skeleton context | Cited lines kept | Outcome |',
    '|---|---|---|---|---:|---|',
  ];
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.category} | ${mark(r.raw.status)} | ${mark(r.skeleton.status)} | ${r.evidenceLinesInSkeleton} of ${r.evidenceLinesTotal} | ${r.outcome} |`);
  }
  const count = (kind: 'raw' | 'skeleton', s: Status): number => results.filter((r) => r[kind].status === s).length;
  lines.push('');
  lines.push(`Raw context: ${count('raw', 'pass')} of ${results.length} pass (${count('raw', 'error')} errors). Skeleton context: ${count('skeleton', 'pass')} of ${results.length} pass (${count('skeleton', 'error')} errors).`);

  const lost = results.filter((r) => r.outcome === 'skeleton-lost-detail');
  if (lost.length > 0) {
    lines.push('');
    lines.push('Where the skeleton lacked source lines the answer depends on (raw passed, skeleton failed):');
    for (const r of lost) {
      lines.push(`- ${r.id}: the skeleton answer was missing ${describeMissing(r.skeleton.missing)}. Lines not in the skeleton:`);
      for (const m of r.evidenceMissingFromSkeleton) lines.push(`    ${m}`);
    }
  }
  const unexplained = results.filter((r) => r.outcome === 'skeleton-fail-evidence-present');
  if (unexplained.length > 0) {
    lines.push('');
    lines.push(`Skeleton failed although every cited line was present (model error or scoring limit): ${unexplained.map((r) => r.id).join(', ')}`);
  }
  const lucky = results.filter((r) => r.outcome === 'skeleton-only-pass');
  if (lucky.length > 0) lines.push(`Skeleton passed where raw failed (noise): ${lucky.map((r) => r.id).join(', ')}`);
  lines.push('');
  lines.push('Scoring is mechanical: an answer passes if it names every required file path, symbol and term. It does not check reasoning. Answers are stored in the results file.');
  return lines.join('\n');
}

function describeMissing(m: Score['missing'] | undefined): string {
  if (!m) return 'nothing recorded';
  const parts = [
    m.files.length ? `files ${m.files.join(', ')}` : '',
    m.symbols.length ? `symbols ${m.symbols.join(', ')}` : '',
    m.terms.length ? `terms ${m.terms.join(', ')}` : '',
  ].filter(Boolean);
  return parts.join('; ') || 'nothing';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface CliArgs {
  dryRun: boolean;
  help: boolean;
  model?: string;
  baseUrl?: string;
  maxContextTokens: number;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, help: false, maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--model') args.model = valueOf(++i, '--model');
    else if (a === '--base-url') args.baseUrl = valueOf(++i, '--base-url');
    else if (a === '--max-context-tokens') {
      const n = Number(valueOf(++i, '--max-context-tokens'));
      if (!Number.isInteger(n) || n < 1) throw new Error('--max-context-tokens must be a positive integer');
      args.maxContextTokens = n;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const USAGE =
  'Usage: npm run bench:eval -- [--dry-run] [--model <id>] [--base-url <url>] [--max-context-tokens <n>]\n' +
  '  --dry-run             validate the questions and build both prompts; no network, no key needed\n' +
  '  --model <id>          model to ask (default: openai/gpt-4o on OpenRouter, gpt-4o on OpenAI)\n' +
  '  --base-url <url>      any OpenAI-compatible endpoint; https, or http for localhost only\n' +
  'Needs OPENROUTER_API_KEY or OPENAI_API_KEY for a live run (OPENROUTER_API_KEY wins if both are set).\n' +
  'Exit codes: 0 done, 1 validation failed or a request failed, 2 bad arguments or no key.\n';

export interface Deps {
  env: Env;
  fetchFn: FetchFn;
  root: string;
  queriesFile: string;
  resultsFile: string;
  skeletonFn: SkeletonFn;
  out: (text: string) => void;
  err: (text: string) => void;
}

export async function main(argv: string[] = process.argv.slice(2), deps: Partial<Deps> = {}): Promise<number> {
  const d: Deps = {
    env: process.env,
    fetchFn: fetch,
    root: REPO_ROOT,
    queriesFile: QUERIES_FILE,
    resultsFile: RESULTS_FILE,
    skeletonFn: (abs, root) => buildSkeletonForFile(abs, root).skeleton,
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    ...deps,
  };

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    d.err(`${e instanceof Error ? e.message : e}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    d.out(USAGE);
    return 0;
  }

  let queries: Query[];
  try {
    queries = loadQueries(d.queriesFile);
  } catch (e) {
    d.err(`${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
  const invalid = validateQueries(queries, d.root);
  if (invalid.length > 0) {
    d.err(`The question set does not match the source:\n  ${invalid.join('\n  ')}\n`);
    return 1;
  }

  // Resolve the provider first so a missing key fails fast, before any skeleton is built.
  let provider: Provider | undefined;
  if (!args.dryRun) {
    const resolved = resolveProvider(d.env, { model: args.model, baseUrl: args.baseUrl });
    if ('error' in resolved) {
      d.err(`${resolved.error}\n`);
      return 2;
    }
    provider = resolved;
  }

  d.err(`Building prompts for ${queries.length} questions ...\n`);
  const prepared = prepare(queries, d.root, d.skeletonFn);
  const promptProblems = checkPrompts(prepared, d.root, args.maxContextTokens);
  if (promptProblems.length > 0) {
    d.err(`Prompt checks failed:\n  ${promptProblems.join('\n  ')}\n`);
    return 1;
  }

  if (args.dryRun || !provider) {
    d.out(renderDryRun(prepared, args.maxContextTokens) + '\n');
    return 0;
  }

  const inputTokens = prepared.reduce((s, p) => s + p.raw.tokens + p.skeleton.tokens, 0);
  d.err(
    `Sending ${prepared.length * 2} requests (about ${nf.format(inputTokens)} input tokens in total) to ${new URL(provider.baseUrl).host} with model ${provider.model}.\n`,
  );
  const ask: Ask = (messages) => callChat(provider as Provider, messages, d.fetchFn);
  const results = await runEval(prepared, ask, (line) => d.err(`  ${line}\n`));

  d.out(renderResults(results) + '\n');
  fs.mkdirSync(path.dirname(d.resultsFile), { recursive: true });
  fs.writeFileSync(
    d.resultsFile,
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        provider: provider.name,
        endpoint: new URL(provider.baseUrl).host,
        model: provider.model,
        temperature: 0,
        scoring: 'mechanical: the answer must name every required file path, symbol and term',
        results,
      },
      null,
      2,
    ) + '\n',
  );
  d.err(`Wrote ${path.relative(d.root, d.resultsFile).split(path.sep).join('/')}\n`);
  return results.some((r) => r.outcome === 'incomplete') ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => void (process.exitCode = code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
      process.exitCode = 1;
    },
  );
}
