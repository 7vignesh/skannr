/**
 * LLM provider abstraction for guard reviews.
 * Supports Gemini (existing dep) and OpenAI-compatible APIs.
 * Enforces structured JSON output — never parses free text.
 */

import { ReviewResponseSchema } from './schema';
import type { GuardConfig, GuardRule, ReviewResponse, SymbolDiffUnit } from './types';

/** Maximum number of retry attempts when LLM returns invalid JSON. */
const MAX_RETRIES = 1;

/**
 * Build the system prompt for the guard review.
 */
function buildSystemPrompt(rules: GuardRule[]): string {
  const rulesText = rules
    .map((r) => `- [${r.id}] (${r.severity}, fixable=${r.fixable}): ${r.description}`)
    .join('\n');

  return [
    'You are a code review tool. Review the provided symbol-level diffs against the rules below.',
    'For each violation found, output a structured JSON object matching the exact schema.',
    '',
    'Rules:',
    rulesText,
    '',
    'Response format (strict JSON, no text before or after):',
    '{',
    '  "violations": [{ "rule_id": "...", "file": "...", "symbol": "...", "line_start": N, "line_end": N, "severity": "...", "confidence": 0.0-1.0, "fixable": bool, "message": "...", "suggested_fix": "...", "evidence": "..." }],',
    '  "status": "pass" | "fail",',
    '  "summary": "..."',
    '}',
    '',
    'IMPORTANT:',
    '- Only flag violations for rules listed above.',
    '- The "fixable" field MUST match the rule definition — do not override it.',
    '- "confidence" reflects how certain you are this is a real violation (0.0-1.0).',
    '- "suggested_fix" is required only when fixable=true.',
    '- "evidence" MUST be the exact line(s) from the changed code that the violation refers to, copied verbatim. Do not paraphrase. A finding with no matching line in the file will be discarded.',
    '- If no violations found, return status "pass" with an empty violations array.',
    '- Return ONLY the JSON object. No markdown, no explanation, no preamble.',
  ].join('\n');
}

/**
 * Build the user prompt with symbol diff units.
 */
function buildUserPrompt(units: SymbolDiffUnit[]): string {
  const parts: string[] = ['Review these symbol-level changes:\n'];

  for (const unit of units) {
    parts.push(`--- ${unit.file} :: ${unit.symbol} (${unit.changeType}) ---`);
    if (unit.oldSignature) parts.push(`Old: ${unit.oldSignature}`);
    if (unit.newSignature) parts.push(`New: ${unit.newSignature}`);
    if (unit.callers.length > 0) parts.push(`Callers: ${unit.callers.join(', ')}`);
    if (unit.callees.length > 0) parts.push(`Callees: ${unit.callees.join(', ')}`);
    parts.push('');
    // Include a trimmed diff (first 100 lines to avoid token explosion)
    const diffLines = unit.diffText.split('\n').slice(0, 100);
    parts.push(diffLines.join('\n'));
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Extract JSON from a response that might have text before/after.
 * This handles the exact failure mode from gga: providers prepending
 * acknowledgment text before the actual JSON response.
 */
function extractJson(text: string): string {
  // Try to find a JSON object in the response
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found in response');
  }
  return text.slice(firstBrace, lastBrace + 1);
}

/**
 * Call a CLI-based provider (claude, gemini, kiro).
 * These use the user's existing authenticated session — no API key needed.
 */
async function callCli(
  command: string,
  fullPrompt: string,
): Promise<string> {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  // Write prompt to a temp file (avoids ARG_MAX limits on large diffs)
  const tmpFile = path.join(os.tmpdir(), `skannr-guard-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, fullPrompt, 'utf-8');

  try {
    let result: string;

    switch (command) {
      case 'claude-cli':
        // Claude CLI accepts prompt via stdin pipe with --print flag
        result = execSync(`cat "${tmpFile}" | claude --print`, {
          encoding: 'utf-8',
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        break;

      case 'gemini-cli':
        // Gemini CLI accepts prompt via -p flag
        result = execSync(`gemini -p "$(cat "${tmpFile}")"`, {
          encoding: 'utf-8',
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        break;

      case 'kiro-cli':
        // Kiro CLI accepts prompt via stdin in non-interactive mode
        result = execSync(`cat "${tmpFile}" | kiro-cli chat --no-interactive "Review and respond with JSON only."`, {
          encoding: 'utf-8',
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        break;

      default:
        throw new Error(`Unknown CLI provider: ${command}`);
    }

    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Call Ollama local inference.
 */
async function callOllama(
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const url = `${baseUrl}/api/chat`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'llama3',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      format: 'json',
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  return data.message?.content ?? '';
}

/**
 * Call Gemini API with structured output enforcement.
 */
async function callGemini(
  config: GuardConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');

  if (!config.apiKey) {
    throw new Error('No API key. Set GEMINI_API_KEY or SKANNR_GUARD_API_KEY.');
  }

  const genAI = new GoogleGenerativeAI(config.apiKey);
  const model = genAI.getGenerativeModel({
    model: config.model,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
  });

  return result.response.text();
}

/**
 * Call OpenAI-compatible API with structured output enforcement.
 */
async function callOpenAI(
  config: GuardConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const url = `${baseUrl}/chat/completions`;

  if (!config.apiKey) {
    throw new Error('No API key. Set OPENAI_API_KEY or SKANNR_GUARD_API_KEY.');
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Run the LLM review and return a validated response.
 * Retries once on validation failure with a correction prompt.
 */
export async function runLlmReview(
  config: GuardConfig,
  rules: GuardRule[],
  units: SymbolDiffUnit[],
): Promise<ReviewResponse> {
  const systemPrompt = buildSystemPrompt(rules);
  const userPrompt = buildUserPrompt(units);

  let lastError: string | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const prompt = attempt === 0
      ? userPrompt
      : `${userPrompt}\n\n[RETRY: Your last response didn't match the required schema. Error: ${lastError}. Return ONLY valid JSON matching the schema.]`;

    let rawResponse: string;
    try {
      switch (config.provider) {
        case 'openai':
          rawResponse = await callOpenAI(config, systemPrompt, prompt);
          break;
        case 'gemini':
          rawResponse = await callGemini(config, systemPrompt, prompt);
          break;
        case 'ollama':
          rawResponse = await callOllama(config.model, systemPrompt, prompt);
          break;
        case 'claude-cli':
        case 'gemini-cli':
        case 'kiro-cli':
          rawResponse = await callCli(config.provider, systemPrompt + '\n\n' + prompt);
          break;
        default:
          throw new Error(`Unsupported provider: ${config.provider}`);
      }
    } catch (err) {
      throw new Error(
        `Provider call failed (${config.provider}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Extract and validate JSON
    try {
      const jsonStr = extractJson(rawResponse);
      const parsed = JSON.parse(jsonStr);
      const result = ReviewResponseSchema.safeParse(parsed);

      if (result.success) {
        // Enforce: fixable field must match the rule definition
        for (const violation of result.data.violations) {
          const rule = rules.find((r) => r.id === violation.rule_id);
          if (rule) {
            violation.fixable = rule.fixable;
          }
        }
        return result.data;
      }

      lastError = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // All retries exhausted
  throw new Error(`LLM response failed schema validation after ${MAX_RETRIES + 1} attempts: ${lastError}`);
}
