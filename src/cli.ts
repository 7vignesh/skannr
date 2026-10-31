#!/usr/bin/env node

/**
 * CLI entry point for skannr.
 *
 * Simplified command surface:
 *   skannr "how does auth work?"        → ask a question (positional)
 *   skannr risk                         → impact of working tree changes
 *   skannr risk --json                  → JSON output for CI
 *   skannr report                       → repo health report
 *   skannr agent                        → interactive agent mode
 *   skannr cache stats | clear          → cache management
 *
 * All legacy flags (--question, --root, blast-radius, etc.) remain supported.
 */

import { Command, InvalidArgumentError } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeProject, getCacheManager } from './index';
import {
  formatHuman,
  formatJson,
  formatMarkdown,
  withCliMetrics,
} from './formatter';
import { loadConfig } from './config';
import { discoverModules, scanFiles } from './scanner';
import { detectRepoLanguages } from './languages/registry';
import {
  askTelemetryConsent,
  setTelemetryExplicit,
  track,
} from './telemetry';

const VERSION = '0.1.4';

const VALID_LANGS = ['typescript', 'javascript', 'python', 'auto'] as const;
type Lang = (typeof VALID_LANGS)[number];

function resolveExtensionsForLanguage(lang: Lang): string[] | undefined {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return ['.ts', '.tsx', '.js', '.jsx'];
    case 'python':
      return ['.py', '.pyi'];
    case 'auto':
    default:
      return undefined;
  }
}

function printNoFilesError(): void {
  console.error(
    [
      '',
      '  ✗ No files found to analyze.',
      '',
      '  Possible causes:',
      '    · --root points to an empty or non-existent directory',
      '    · All files are excluded by .gitignore or default excludes',
      '    · --lang filter is too restrictive for this repo',
      '',
      '  Try: skannr "your question" --root /path/to/repo',
      '       skannr "your question" --lang auto',
      '',
    ].join('\n'),
  );
}

function assertRootExists(absoluteRoot: string): void {
  if (!fs.existsSync(absoluteRoot)) {
    console.error('');
    console.error(`  ✗ Directory does not exist: ${absoluteRoot}`);
    console.error('');
    console.error('  Check --root points to a valid project path.');
    console.error('');
    process.exit(1);
  }
  if (!fs.statSync(absoluteRoot).isDirectory()) {
    console.error('');
    console.error(`  ✗ Not a directory: ${absoluteRoot}`);
    console.error('');
    process.exit(1);
  }
}

function resolveLangFlag(raw: string | undefined): Lang {
  const value = (raw ?? 'auto').toLowerCase();
  if (!VALID_LANGS.includes(value as Lang)) {
    const display = raw === undefined || raw === '' ? '(empty)' : raw;
    console.error('');
    console.error(
      `  ✗ Invalid --lang "${display}". Valid values: ${VALID_LANGS.join(', ')}`,
    );
    console.error('');
    process.exit(1);
  }
  return value as Lang;
}

function resolveFormatFlag(raw: string | undefined, jsonShortcut?: boolean): 'human' | 'markdown' | 'json' {
  if (jsonShortcut) return 'json';
  const fmt = (raw ?? 'human').toLowerCase();
  if (fmt === 'json' || fmt === 'markdown' || fmt === 'human') {
    return fmt;
  }
  const display = raw === undefined || raw === '' ? '(empty)' : raw;
  console.error('');
  console.error(
    `  ✗ Invalid --format "${display}". Use human, markdown, or json.`,
  );
  console.error('');
  process.exit(1);
}

function runReport(root: string, lang: Lang): void {
  const absoluteRoot = path.resolve(root);
  assertRootExists(absoluteRoot);
  const config = loadConfig(absoluteRoot);
  const moduleKeys =
    config.modules ? Object.keys(config.modules) : discoverModules(absoluteRoot);
  const extensions = resolveExtensionsForLanguage(lang) ?? config.extensions;
  const files = scanFiles(absoluteRoot, {
    extensions,
    exclude: config.exclude,
    moduleKeys,
    moduleDefinitions: config.modules,
  });
  const languages = detectRepoLanguages(absoluteRoot);
  const report = {
    type: 'report' as const,
    version: VERSION,
    root: absoluteRoot,
    scannedFileCount: files.length,
    moduleKeys,
    languages,
    extensions: extensions ?? 'auto (from repo)',
  };
  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------
// Build CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('skannr')
  .description(
    [
      'Analyze any codebase. Ask questions. Get ranked, compressed file skeletons.',
      '',
      'Usage:',
      '  skannr "how does auth work?"       Ask about the codebase',
      '  skannr risk                         Check impact of current changes',
      '  skannr report                       Repo health summary',
      '  skannr agent                        Interactive exploration',
    ].join('\n'),
  )
  .version(VERSION)
  .enablePositionalOptions()
  .argument('[question]', 'natural language question about the codebase')
  .option('--root <path>', 'project root directory', process.cwd())
  .option('--question <text>', 'question (alternative to positional argument)')
  .option(
    '-n, --limit <number>',
    'number of top files to return',
    (value: string) => {
      const n = parseInt(value, 10);
      if (Number.isNaN(n) || n < 1) {
        throw new InvalidArgumentError('must be a positive number');
      }
      return n;
    },
  )
  .option('--with-mapping', 'generate symbol mapping for on-demand retrieval')
  .option('--mapping-output <path>', 'custom path for mapping file (implies --with-mapping)')
  .option('--modules <keys>', 'comma-separated module keys (auto-discovered when omitted)')
  .option(
    '--lang <mode>',
    'language filter: typescript | javascript | python | auto (default: auto)',
  )
  .option('--skip-cache', 'skip cache and force full analysis')
  .option('--cache-clear', 'clear all cached analysis results')
  .option('--cache-stats', 'show cache statistics')
  .option('--report', 'print repository health report (JSON)')
  .option(
    '--format <format>',
    'output format: human, markdown, or json',
    'human',
  )
  .option('--json', 'shortcut for --format json')
  .option('--watch', 'watch for file changes and re-analyze automatically')
  .option('--telemetry-on', 'enable anonymous usage telemetry (flags only)')
  .option('--telemetry-off', 'disable anonymous usage telemetry')
  .option('--mcp', 'run as Model Context Protocol stdio server');

// ---------------------------------------------------------------------------
// Root command action (question flow)
// ---------------------------------------------------------------------------
program.action(async (
  questionArg: string | undefined,
  opts: {
    root: string;
    question?: string;
    limit?: number;
    withMapping?: boolean;
    mappingOutput?: string;
    modules?: string;
    lang?: string;
    skipCache?: boolean;
    cacheClear?: boolean;
    cacheStats?: boolean;
    report?: boolean;
    format?: string;
    json?: boolean;
    watch?: boolean;
    telemetryOn?: boolean;
    telemetryOff?: boolean;
    mcp?: boolean;
  },
) => {
  try {
    // MCP mode
    if (opts.mcp || process.argv.includes('--mcp')) {
      const { startMcpServer } = await import('./mcp-server');
      await startMcpServer();
      return;
    }

    // Telemetry toggles
    if (opts.telemetryOn) {
      setTelemetryExplicit(true);
      console.log('Telemetry enabled. Thank you!');
      process.exit(0);
    }
    if (opts.telemetryOff) {
      setTelemetryExplicit(false);
      console.log('Telemetry disabled.');
      process.exit(0);
    }

    // Legacy cache flags
    if (opts.cacheClear) {
      const cacheManager = getCacheManager();
      cacheManager.clear();
      console.log('Cache cleared.');
      process.exit(0);
    }
    if (opts.cacheStats) {
      const cacheManager = getCacheManager();
      const stats = cacheManager.getStats();
      console.log('\n  Cache Statistics:');
      console.log(`    Hits: ${stats.hits}`);
      console.log(`    Misses: ${stats.misses}`);
      console.log(`    Hit Rate: ${stats.hitRate}%`);
      console.log(`    Size: ${(stats.cacheSize / 1024).toFixed(2)} KB`);
      console.log(`    Dir: ${cacheManager.getCacheDir()}\n`);
      process.exit(0);
    }

    const lang = resolveLangFlag(opts.lang);

    // Legacy --report flag
    if (opts.report) {
      runReport(opts.root, lang);
      process.exit(0);
    }

    // Resolve question: positional arg takes precedence over --question flag
    const question = (questionArg || opts.question || '').trim();
    if (!question) {
      program.outputHelp();
      process.exit(0);
    }

    const absoluteRoot = path.resolve(opts.root);
    assertRootExists(absoluteRoot);

    await askTelemetryConsent();

    const config = loadConfig(absoluteRoot);
    const moduleKeysFromCli = opts.modules
      ? opts.modules.split(',').map((k) => k.trim()).filter(Boolean)
      : undefined;
    const moduleKeys =
      moduleKeysFromCli && moduleKeysFromCli.length > 0
        ? moduleKeysFromCli
        : config.modules
          ? Object.keys(config.modules)
          : discoverModules(absoluteRoot);

    const limitProvided = opts.limit !== undefined;
    const limit = limitProvided ? opts.limit! : (config.defaultLimit ?? 10);

    const generateMapping = Boolean(opts.withMapping || opts.mappingOutput);
    const mappingOutputPath = opts.mappingOutput;

    const langExtensions = resolveExtensionsForLanguage(lang);
    const extensions = langExtensions ?? config.extensions;

    const outputFormat = resolveFormatFlag(opts.format, opts.json);

    const analyzeOptions = {
      root: absoluteRoot,
      question,
      limit,
      generateMapping,
      mappingOutputPath,
      moduleKeys,
      moduleDefinitions: config.modules,
      lang,
      exclude: config.exclude,
      extensions,
    };

    if (opts.watch) {
      const { watchAndAnalyze } = await import('./watcher');
      let watchTelemetrySent = false;
      try {
        await watchAndAnalyze(analyzeOptions, (raw, elapsedMs) => {
          const result = withCliMetrics(raw, elapsedMs);
          const formatted =
            outputFormat === 'json'
              ? formatJson(result)
              : outputFormat === 'markdown'
                ? formatMarkdown(result)
                : formatHuman(result);
          process.stdout.write(formatted + (formatted.endsWith('\n') ? '' : '\n'));
          if (!watchTelemetrySent) {
            watchTelemetrySent = true;
            track('analyze', buildTelemetryFlags(opts, outputFormat, lang, limit));
          }
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'NO_FILES') {
          printNoFilesError();
          process.exit(1);
        }
        throw error;
      }
      return;
    }

    const started = Date.now();
    const rawResult = await analyzeProject({
      ...analyzeOptions,
      skipCache: opts.skipCache,
    });

    if (rawResult.files.length === 0) {
      printNoFilesError();
      process.exit(1);
    }

    const result = withCliMetrics(rawResult, Date.now() - started);

    const formatted =
      outputFormat === 'json'
        ? formatJson(result)
        : outputFormat === 'markdown'
          ? formatMarkdown(result)
          : formatHuman(result);

    process.stdout.write(formatted + (formatted.endsWith('\n') ? '' : '\n'));
    track('analyze', buildTelemetryFlags(opts, outputFormat, lang, limit));
  } catch (error) {
    console.error(
      'Error analyzing project:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// Subcommand: risk
// ---------------------------------------------------------------------------
async function runRisk(cmdOpts: { root: string; diff?: string; hops?: number; json?: boolean }): Promise<void> {
  try {
    const { computeBlastRadius, formatBlastRadiusText, formatBlastRadiusJson } =
      await import('./blast-radius');

    const absoluteRoot = path.resolve(cmdOpts.root);
    assertRootExists(absoluteRoot);

    const result = computeBlastRadius({
      root: absoluteRoot,
      diffPath: cmdOpts.diff,
      hops: cmdOpts.hops ?? 2,
    });

    const output = cmdOpts.json
      ? formatBlastRadiusJson(result)
      : formatBlastRadiusText(result);

    process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
  } catch (error) {
    console.error(
      'Error computing risk:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

function riskOptions(cmd: Command): Command {
  return cmd
    .option('--root <path>', 'project root directory', process.cwd())
    .option('--diff <path>', 'path to a diff file (default: working tree vs HEAD)')
    .option('-n, --hops <n>', 'max traversal hops (default: 2)', (v: string) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) {
        throw new InvalidArgumentError('must be a positive integer');
      }
      return n;
    })
    .option('--json', 'output as JSON instead of plain text');
}

riskOptions(program.command('risk').description('Check downstream impact and risk of your current changes'))
  .action(runRisk);

// Backward compat alias
riskOptions(program.command('blast-radius').description('Alias for "risk"'))
  .action(runRisk);

// ---------------------------------------------------------------------------
// Subcommand: report
// ---------------------------------------------------------------------------
program
  .command('report')
  .description('Print repository health summary (JSON)')
  .option('--root <path>', 'project root directory', process.cwd())
  .option('--lang <mode>', 'language filter', 'auto')
  .action((cmdOpts: { root: string; lang?: string }) => {
    const lang = resolveLangFlag(cmdOpts.lang);
    runReport(cmdOpts.root, lang);
  });

// ---------------------------------------------------------------------------
// Subcommand: agent
// ---------------------------------------------------------------------------
program
  .command('agent')
  .description('Interactive exploration mode')
  .option('--root <path>', 'project root directory', process.cwd())
  .action(async (cmdOpts: { root: string }) => {
    process.argv = ['node', 'skannr-agent', '--root', cmdOpts.root];
    await import('./agent-cli');
  });

// ---------------------------------------------------------------------------
// Subcommand: cache
// ---------------------------------------------------------------------------
const cacheCommand = program
  .command('cache')
  .description('Manage analysis cache');

cacheCommand
  .command('clear')
  .description('Clear all cached analysis results')
  .action(() => {
    const cacheManager = getCacheManager();
    cacheManager.clear();
    console.log('Cache cleared.');
  });

cacheCommand
  .command('stats')
  .description('Show cache statistics')
  .action(() => {
    const cacheManager = getCacheManager();
    const stats = cacheManager.getStats();
    console.log('\n  Cache Statistics:');
    console.log(`    Hits: ${stats.hits}`);
    console.log(`    Misses: ${stats.misses}`);
    console.log(`    Hit Rate: ${stats.hitRate}%`);
    console.log(`    Size: ${(stats.cacheSize / 1024).toFixed(2)} KB`);
    console.log(`    Dir: ${cacheManager.getCacheDir()}\n`);
  });

// ---------------------------------------------------------------------------
// Subcommand: init
// ---------------------------------------------------------------------------
program
  .command('init')
  .description('Detect coding agents and wire up skannr (MCP server + guard hook)')
  .option('--root <path>', 'project root directory', process.cwd())
  .option('--yes', 'skip the confirmation prompt')
  .option('--agent <name>', 'configure a single agent (claude-code, cursor, kiro, vscode-copilot, gemini-cli)')
  .option('--global', 'write home-level agent configs instead of project-local')
  .option('--no-rules', 'do not scaffold a default .skannr/rules.json')
  .action(async (cmdOpts: { root: string; yes?: boolean; agent?: string; rules?: boolean; global?: boolean }) => {
    const { runInit } = await import('./init');
    const confirm = async (plan: Array<{ description: string }>): Promise<boolean> => {
      process.stdout.write('\n  skannr init will:\n');
      for (const p of plan) process.stdout.write(`    - ${p.description}\n`);
      process.stdout.write('\n  Proceed? [y/N] ');
      const answer = await new Promise<string>((resolve) => {
        process.stdin.resume();
        // Closed stdin (non-interactive run without --yes) counts as "no".
        process.stdin.once('end', () => resolve(''));
        process.stdin.once('data', (d) => {
          process.stdin.pause();
          resolve(d.toString().trim().toLowerCase());
        });
      });
      return answer === 'y' || answer === 'yes';
    };
    const code = await runInit(
      {
        root: cmdOpts.root,
        yes: cmdOpts.yes,
        agent: cmdOpts.agent,
        noRules: cmdOpts.rules === false,
        global: cmdOpts.global,
      },
      confirm,
    );
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// Subcommand: guard
// ---------------------------------------------------------------------------
const guardCommand = program
  .command('guard')
  .description('Review staged changes against team-defined rules')
  .option('--root <path>', 'project root directory', process.cwd())
  .option('--fix', 'apply auto-fixes for fixable violations')
  .option('--dry-run', 'show what --fix would change without writing')
  .option('--pr-mode', 'review full PR diff vs base branch')
  .option('--diff-only', 'skip cross-file context (faster, cheaper)')
  .option('--no-cache', 'ignore symbol cache')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: {
    root: string;
    fix?: boolean;
    dryRun?: boolean;
    prMode?: boolean;
    diffOnly?: boolean;
    noCache?: boolean;
    json?: boolean;
  }) => {
    try {
      const { runGuard, formatGuardText, formatGuardJson } = await import('./guard/index');
      const { result, exitCode } = await runGuard({
        root: cmdOpts.root,
        fix: cmdOpts.fix,
        dryRun: cmdOpts.dryRun,
        prMode: cmdOpts.prMode,
        diffOnly: cmdOpts.diffOnly,
        noCache: cmdOpts.noCache,
        json: cmdOpts.json,
      });

      const output = cmdOpts.json
        ? formatGuardJson(result)
        : formatGuardText(result);

      process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
      process.exit(exitCode);
    } catch (error) {
      console.error(
        'Error running guard:',
        error instanceof Error ? error.message : error,
      );
      process.exit(2);
    }
  });

guardCommand
  .command('install')
  .description('Install git pre-commit hook')
  .option('--root <path>', 'project root directory', process.cwd())
  .action(async (cmdOpts: { root: string }) => {
    const { installHook } = await import('./guard/index');
    const { installed, message } = installHook(path.resolve(cmdOpts.root));
    console.log(message);
    process.exit(installed ? 0 : 1);
  });

guardCommand
  .command('uninstall')
  .description('Remove git pre-commit hook')
  .option('--root <path>', 'project root directory', process.cwd())
  .action(async (cmdOpts: { root: string }) => {
    const { uninstallHook } = await import('./guard/index');
    const { removed, message } = uninstallHook(path.resolve(cmdOpts.root));
    console.log(message);
    process.exit(removed ? 0 : 1);
  });

guardCommand
  .command('config')
  .description('Show loaded rules and provider config')
  .option('--root <path>', 'project root directory', process.cwd())
  .action(async (cmdOpts: { root: string }) => {
    const { loadRules, loadGuardConfig } = await import('./guard/index');
    const root = path.resolve(cmdOpts.root);
    try {
      const rules = loadRules(root);
      const config = loadGuardConfig(root);
      console.log('\n  Guard Config:');
      console.log(`    Provider: ${config.provider}`);
      console.log(`    Model: ${config.model}`);
      console.log(`    API Key: ${config.apiKey ? '***' + config.apiKey.slice(-4) : 'not set'}`);
      console.log(`\n  Rules (${rules.length}):`);
      for (const r of rules) {
        console.log(`    [${r.id}] ${r.severity} | fixable=${r.fixable} | ${r.description}`);
      }
      console.log('');
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  });

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
program.addHelpText(
  'after',
  `
Examples:
  skannr init                              Detect agents + wire up skannr
  skannr "how does auth work?"             Ask about the codebase
  skannr "database queries" -n 5           Limit to 5 results
  skannr "endpoints" --json                JSON output
  skannr "class structure" --lang python   Force language

  skannr risk                              Impact of uncommitted changes
  skannr risk --diff feature.patch         Impact of a patch file
  skannr risk -n 3 --json                  3 hops, JSON for CI

  skannr guard                             Review staged changes against rules
  skannr guard --fix                       Auto-fix fixable violations
  skannr guard --pr-mode --json            Review PR diff, JSON output
  skannr guard install                     Install pre-commit hook

  skannr report                            Repo health summary
  skannr agent                             Interactive mode
  skannr cache stats                       Cache hit rate
  skannr cache clear                       Wipe cache

MCP: npx -y skannr --mcp
`,
);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parse(process.argv);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildTelemetryFlags(
  o: Record<string, unknown>,
  outputFormat: 'human' | 'markdown' | 'json',
  lang: Lang,
  limit: number,
): Record<string, boolean | string | number> {
  return {
    hasModules: Boolean(o.modules),
    hasWatch: Boolean(o.watch),
    hasReport: Boolean(o.report),
    hasMapping: Boolean(o.withMapping || o.mappingOutput),
    skipCache: Boolean(o.skipCache),
    format: outputFormat,
    lang,
    limit,
  };
}
