/**
 * Zod schemas for rules file validation and LLM response contract enforcement.
 * These ensure we never parse free text — all LLM output is validated against
 * a strict schema before being used.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Rules file schema
// ---------------------------------------------------------------------------

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const RuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  severity: SeveritySchema,
  fixable: z.boolean(),
  category: z.string().min(1),
});

export const RulesFileSchema = z.object({
  rules: z.array(RuleSchema).min(1),
});

// ---------------------------------------------------------------------------
// Violation / LLM response schema
// ---------------------------------------------------------------------------

export const ViolationSchema = z.object({
  rule_id: z.string().min(1),
  file: z.string().min(1),
  symbol: z.string(),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  fixable: z.boolean(),
  message: z.string().min(1),
  suggested_fix: z.string().optional(),
  evidence: z.string().optional(),
  evidence_verified: z.boolean().optional(),
});

export const ReviewResponseSchema = z.object({
  violations: z.array(ViolationSchema),
  status: z.enum(['pass', 'fail']),
  summary: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Guard config schema (optional .skannr/guard.json)
// ---------------------------------------------------------------------------

export const GuardConfigSchema = z.object({
  provider: z.enum(['gemini', 'openai', 'claude-cli', 'gemini-cli', 'kiro-cli', 'ollama']).default('auto' as any),
  model: z.string().default(''),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});
