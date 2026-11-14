/**
 * Build symbol-level diff units from staged git changes.
 * Uses Skannr's existing parser to identify which symbols changed,
 * instead of working with raw file diffs.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { getAdapter } from '../languages/registry';
import { readFileContent } from '../scanner';
import type { Symbol } from '../languages/LanguageAdapter';
import type { SymbolDiffUnit } from './types';

/** Get the list of staged files (paths relative to root). */
export function getStagedFiles(root: string): string[] {
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      cwd: root,
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Get the diff text for a specific staged file. */
function getStagedDiff(root: string, file: string): string {
  try {
    return execSync(`git diff --cached -- "${file}"`, {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/** Get the old (HEAD) version of a file, or null if newly added. */
function getHeadContent(root: string, file: string): string | null {
  try {
    return execSync(`git show HEAD:"${file}"`, {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Extract changed line numbers from a unified diff. */
function extractChangedLines(diff: string): Set<number> {
  const lines = new Set<number>();
  let currentLine = 0;

  for (const line of diff.split('\n')) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch) {
      currentLine = parseInt(hunkMatch[1], 10);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.add(currentLine);
      currentLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deleted lines don't advance the new-file line counter
    } else {
      currentLine++;
    }
  }

  return lines;
}

/**
 * Determine which symbols in a file were affected by the staged changes.
 * Matches symbols whose line range overlaps any changed line.
 */
function findAffectedSymbols(
  symbols: Symbol[],
  changedLines: Set<number>,
  allSymbols: Symbol[],
): Symbol[] {
  if (changedLines.size === 0) return [];

  // Synthetic `export` markers all sit at line 1 and carry no real range.
  // Including them corrupts the next-symbol end-line estimate (a real symbol
  // sharing their line gets endLine = 1 - 1 = 0, an empty range), so a body
  // change to a top-of-file exported symbol would match nothing. Drop them.
  const real = allSymbols.filter((s) => s.kind !== 'export');

  // Build approximate end lines: each symbol extends until the next symbol starts
  const sorted = [...real].sort((a, b) => a.line - b.line);
  const affected: Symbol[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const sym = sorted[i];
    const startLine = sym.line;
    const endLine = i + 1 < sorted.length ? sorted[i + 1].line - 1 : startLine + 50;

    for (let line = startLine; line <= endLine; line++) {
      if (changedLines.has(line)) {
        affected.push(sym);
        break;
      }
    }
  }

  return affected;
}

/**
 * Build symbol-level diff units for all staged files in the project.
 * This is the primary input to the review runner.
 */
export function buildSymbolDiffs(root: string): SymbolDiffUnit[] {
  const stagedFiles = getStagedFiles(root);
  const units: SymbolDiffUnit[] = [];

  for (const relFile of stagedFiles) {
    const absPath = path.join(root, relFile);
    if (!fs.existsSync(absPath)) continue;

    const adapter = getAdapter(absPath);
    const newContent = readFileContent(absPath);
    if (!newContent) continue;

    const newSymbols = adapter.extractSymbols(newContent);
    const oldContent = getHeadContent(root, relFile);
    const oldSymbols = oldContent ? adapter.extractSymbols(oldContent) : [];

    const diff = getStagedDiff(root, relFile);
    const changedLines = extractChangedLines(diff);

    // Find symbols that overlap changed lines in the new version
    const affected = findAffectedSymbols(newSymbols, changedLines, newSymbols);

    // Determine change type for each affected symbol
    const oldSymbolNames = new Set(oldSymbols.map((s) => s.name));

    for (const sym of affected) {
      if (sym.kind === 'export') continue; // skip synthetic export markers

      const changeType = oldSymbolNames.has(sym.name) ? 'modified' : 'added';
      const oldSym = oldSymbols.find((s) => s.name === sym.name);

      units.push({
        file: relFile,
        symbol: sym.name,
        changeType,
        oldSignature: oldSym ? `${oldSym.kind} ${oldSym.name}` : undefined,
        newSignature: `${sym.kind} ${sym.name}`,
        callers: [],  // populated by call-context module
        callees: [],  // populated by call-context module
        diffText: diff,
      });
    }

    // Handle deleted symbols (in old but not in new)
    if (oldContent) {
      const newSymbolNames = new Set(newSymbols.map((s) => s.name));
      for (const oldSym of oldSymbols) {
        if (oldSym.kind === 'export') continue;
        if (!newSymbolNames.has(oldSym.name)) {
          units.push({
            file: relFile,
            symbol: oldSym.name,
            changeType: 'deleted',
            oldSignature: `${oldSym.kind} ${oldSym.name}`,
            callers: [],
            callees: [],
            diffText: diff,
          });
        }
      }
    }
  }

  return units;
}

/**
 * Build symbol diffs from a PR diff string (for --pr-mode).
 */
export function buildSymbolDiffsFromDiff(root: string, diffContent: string): SymbolDiffUnit[] {
  const parseDiff = require('parse-diff');
  const parsedFiles = parseDiff(diffContent);
  const units: SymbolDiffUnit[] = [];

  for (const file of parsedFiles) {
    const raw = file.to ?? file.from;
    if (!raw || raw === '/dev/null') continue;
    const relFile = raw.replace(/^[ab]\//, '');
    const absPath = path.join(root, relFile);
    if (!fs.existsSync(absPath)) continue;

    const adapter = getAdapter(absPath);
    const content = readFileContent(absPath);
    if (!content) continue;

    const symbols = adapter.extractSymbols(content);
    const changedLines = new Set<number>();

    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === 'add' || change.type === 'del') {
          const ln = (change as any).ln;
          if (typeof ln === 'number') changedLines.add(ln);
        }
      }
    }

    const affected = findAffectedSymbols(symbols, changedLines, symbols);

    for (const sym of affected) {
      if (sym.kind === 'export') continue;
      units.push({
        file: relFile,
        symbol: sym.name,
        changeType: 'modified',
        newSignature: `${sym.kind} ${sym.name}`,
        callers: [],
        callees: [],
        diffText: file.chunks.map((c: any) => c.content).join('\n'),
      });
    }
  }

  return units;
}
