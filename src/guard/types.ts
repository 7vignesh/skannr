/**
 * Shared type definitions for the guard module.
 */

/** Severity levels for rules and violations. */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** A team-defined review rule. */
export interface GuardRule {
  id: string;
  description: string;
  severity: Severity;
  fixable: boolean;
  category: string;
}

/** A single symbol-level diff unit sent to the LLM for review. */
export interface SymbolDiffUnit {
  file: string;
  symbol: string;
  changeType: 'added' | 'modified' | 'deleted';
  oldSignature?: string;
  newSignature?: string;
  callers: string[];
  callees: string[];
  diffText: string;
}

/** Where a violation came from: the LLM reviewer or a deterministic scanner. */
export type ViolationSource = 'llm' | 'gitleaks' | 'semgrep' | 'osv-scanner';

/** A violation found by the review. */
export interface Violation {
  rule_id: string;
  file: string;
  symbol: string;
  line_start: number;
  line_end: number;
  severity: Severity;
  confidence: number;
  fixable: boolean;
  message: string;
  suggested_fix?: string;
  /** Verbatim line(s) from the file that the violation flags. Used to verify the finding. */
  evidence?: string;
  /** Set by the evidence verifier when the quote was found in the file. */
  evidence_verified?: boolean;
  /** Who produced the finding. Set by the runner, never taken from LLM output. */
  source?: ViolationSource;
}

/** Which deterministic scanners ran, and which were skipped and why. */
export interface ScannerReport {
  ran: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/** The structured response contract from the LLM. */
export interface ReviewResponse {
  violations: Violation[];
  status: 'pass' | 'fail';
  summary: string;
}

/** Result of a full guard run. */
export interface GuardResult {
  response: ReviewResponse;
  rulesUsed: GuardRule[];
  symbolsReviewed: number;
  durationMs: number;
  /** Present when scanners were attempted for this review. */
  scanners?: ScannerReport;
}

/** Guard configuration (provider, model, etc.). */
export interface GuardConfig {
  /** LLM provider: 'gemini' | 'openai' | 'claude-cli' | 'gemini-cli' | 'kiro-cli' | 'ollama' */
  provider: 'gemini' | 'openai' | 'claude-cli' | 'gemini-cli' | 'kiro-cli' | 'ollama';
  /** Model name (e.g. 'gemini-2.0-flash-exp', 'gpt-4o'). */
  model: string;
  /** API key (resolved from env if not set). Only needed for 'gemini' and 'openai' providers. */
  apiKey?: string;
  /** OpenAI-compatible base URL (for openai provider). */
  baseUrl?: string;
}
