/**
 * Minimal SARIF 2.1.0 reader shared by all scanner adapters.
 */

import type { RawFinding } from './types';

/**
 * Turn a SARIF location URI into a repo-relative path with forward slashes.
 * Absolute paths outside `root` are returned unchanged and match no changed file.
 */
export function normalizeUri(uri: string, root: string): string {
  let p = uri;
  if (p.startsWith('file://')) {
    p = decodeURIComponent(p.slice('file://'.length));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  }
  p = p.replace(/\\/g, '/');

  const isAbsolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
  if (isAbsolute) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const windowsRoot = /^[A-Za-z]:/.test(r);
    const a = windowsRoot ? p.toLowerCase() : p;
    const b = windowsRoot ? r.toLowerCase() : r;
    if (!a.startsWith(b + '/')) return p;
    p = p.slice(r.length + 1);
  }
  return p.replace(/^\.\//, '');
}

interface SarifRule {
  id?: string;
  defaultConfiguration?: { level?: string };
  properties?: { 'security-severity'?: string | number; tags?: string[] };
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string; markdown?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number; endLine?: number };
    };
  }>;
}

interface SarifLog {
  runs?: Array<{ tool?: { driver?: { rules?: SarifRule[] } }; results?: SarifResult[] }>;
}

/** Parse SARIF text into findings. Throws on malformed JSON. */
export function parseSarif(text: string, root: string): RawFinding[] {
  const log = JSON.parse(text) as SarifLog;
  const findings: RawFinding[] = [];

  for (const run of log.runs ?? []) {
    const rules = new Map<string, SarifRule>();
    for (const rule of run.tool?.driver?.rules ?? []) {
      if (rule.id) rules.set(rule.id, rule);
    }

    for (const result of run.results ?? []) {
      const ruleId = result.ruleId ?? 'unknown';
      const rule = rules.get(ruleId);
      const loc = result.locations?.[0]?.physicalLocation;
      const startLine = loc?.region?.startLine ?? 1;
      const score = Number(rule?.properties?.['security-severity']);

      findings.push({
        ruleId,
        message: (result.message?.text ?? result.message?.markdown ?? ruleId).trim() || ruleId,
        file: loc?.artifactLocation?.uri ? normalizeUri(loc.artifactLocation.uri, root) : '',
        line: startLine,
        endLine: loc?.region?.endLine ?? startLine,
        level: result.level ?? rule?.defaultConfiguration?.level ?? 'warning',
        securityScore: Number.isFinite(score) ? score : undefined,
        tags: rule?.properties?.tags ?? [],
      });
    }
  }

  return findings;
}
