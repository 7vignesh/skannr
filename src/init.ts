/**
 * `skannr init` - one-command onboarding.
 *
 * Detects installed coding agents, merges the skannr MCP server into their
 * config, installs the guard pre-commit hook, and optionally scaffolds a
 * default rules file. Pure helpers (detection, MCP merge, planning) are
 * separated from the filesystem actions so they can be tested in isolation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installHook } from './guard/hook-installer';

/** The MCP server entry skannr adds to each agent's config. */
export const SKANNR_MCP_ENTRY = {
  command: 'npx',
  args: ['-y', 'skannr', '--mcp'],
} as const;

/** A coding agent that skannr can configure. */
export interface AgentDef {
  /** Stable key used by `--agent <name>`. */
  key: string;
  /** Human-readable label for prompts. */
  label: string;
  /**
   * Candidate directories/files that indicate the agent is installed.
   * Paths starting with `~` resolve against home; others against the project root.
   */
  detectPaths: string[];
  /**
   * Project-local MCP config path (relative to root). Written by default.
   * Undefined when the agent has no project-local config.
   */
  projectConfigPath?: string;
  /**
   * Home-level MCP config path (`~`-relative). Written only with `--global`.
   * Undefined when the agent has no global config.
   */
  globalConfigPath?: string;
  /** Top-level key that holds the servers. VS Code uses `servers`. Default `mcpServers`. */
  serversKey?: ServersKey;
}

/** Top-level key an MCP config file uses for its server map. */
export type ServersKey = 'mcpServers' | 'servers';

/** The skannr server entry for a config format. VS Code's format requires `type`. */
export function mcpEntryFor(serversKey: ServersKey): Record<string, unknown> {
  const entry = { command: SKANNR_MCP_ENTRY.command, args: [...SKANNR_MCP_ENTRY.args] };
  return serversKey === 'servers' ? { type: 'stdio', ...entry } : entry;
}

/** Built-in agent definitions. Order controls prompt/plan ordering. */
export const AGENTS: AgentDef[] = [
  {
    key: 'claude-code',
    label: 'Claude Code',
    detectPaths: ['~/.claude', '.mcp.json'],
    projectConfigPath: '.mcp.json',
    globalConfigPath: '~/.claude.json',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    detectPaths: ['~/.cursor', '.cursor'],
    projectConfigPath: '.cursor/mcp.json',
    globalConfigPath: '~/.cursor/mcp.json',
  },
  {
    key: 'kiro',
    label: 'Kiro',
    detectPaths: ['~/.kiro', '.kiro'],
    projectConfigPath: '.kiro/settings/mcp.json',
    globalConfigPath: '~/.kiro/settings/mcp.json',
  },
  {
    key: 'vscode-copilot',
    label: 'VS Code Copilot',
    detectPaths: ['.vscode'],
    projectConfigPath: '.vscode/mcp.json',
    serversKey: 'servers',
  },
  {
    key: 'gemini-cli',
    label: 'Gemini CLI',
    detectPaths: ['~/.gemini', '.gemini'],
    projectConfigPath: '.gemini/settings.json',
    globalConfigPath: '~/.gemini/settings.json',
  },
];

/** Resolve a `~`-prefixed or root-relative path to an absolute path. */
export function resolvePath(p: string, home: string, root: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home, p.slice(2));
  }
  return path.join(root, p);
}

/** Return the agents whose detect paths exist. */
export function detectAgents(home: string, root: string): AgentDef[] {
  return AGENTS.filter((agent) =>
    agent.detectPaths.some((p) => fs.existsSync(resolvePath(p, home, root))),
  );
}

/**
 * Merge the skannr MCP entry into an existing MCP config object.
 * Pure: never touches the filesystem. Preserves other servers and keys.
 * Returns `{ config, changed }`. `changed` is false when skannr is already present and identical.
 */
export function mergeMcpConfig(
  existing: unknown,
  serversKey: ServersKey = 'mcpServers',
): { config: Record<string, unknown>; changed: boolean } {
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const rawServers = base[serversKey];
  const servers: Record<string, unknown> =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};

  const current = servers.skannr;
  const next = mcpEntryFor(serversKey);

  if (current && JSON.stringify(current) === JSON.stringify(next)) {
    return { config: base, changed: false };
  }

  servers.skannr = next;
  base[serversKey] = servers;
  return { config: base, changed: true };
}

/** A single action the init plan will perform. */
export interface PlanEntry {
  kind: 'mcp' | 'hook' | 'rules' | 'skip';
  /** Absolute target path (or agent key for `skip`). */
  target: string;
  /** What will happen, for the confirm prompt. */
  description: string;
  /** For `mcp` entries: the top-level servers key of the target file. */
  serversKey?: ServersKey;
}

/** Default rules written when scaffolding `.skannr/rules.json`. */
const DEFAULT_RULES_FILE = {
  rules: [
    {
      id: 'no-hardcoded-secrets',
      description:
        'Do not hardcode API keys, passwords, tokens, or connection strings. Use environment variables.',
      severity: 'critical',
      fixable: false,
      category: 'security',
    },
    {
      id: 'no-console-log',
      description: 'Remove console.log statements before committing; use a proper logger.',
      severity: 'medium',
      fixable: true,
      category: 'code-quality',
    },
  ],
};

/**
 * Build the plan: which MCP configs to touch, whether to install the hook,
 * and whether to scaffold rules. Does not write anything.
 *
 * By default only project-local MCP configs are written. With `global: true`,
 * home-level configs are written instead. Agents that lack the chosen config
 * kind produce a `skip` entry so the user sees why.
 */
export function planInit(
  agents: AgentDef[],
  home: string,
  root: string,
  opts: { scaffoldRules?: boolean; global?: boolean } = {},
): PlanEntry[] {
  const { scaffoldRules = true, global = false } = opts;
  const plan: PlanEntry[] = [];

  for (const agent of agents) {
    const relPath = global ? agent.globalConfigPath : agent.projectConfigPath;
    if (!relPath) {
      plan.push({
        kind: 'skip',
        target: agent.key,
        description: `Skip ${agent.label}: no ${global ? 'global' : 'project-local'} MCP config (use ${global ? '(drop --global)' : '--global'})`,
      });
      continue;
    }
    const target = resolvePath(relPath, home, root);
    const exists = fs.existsSync(target);
    plan.push({
      kind: 'mcp',
      target,
      description: `${exists ? 'Update' : 'Create'} ${agent.label} MCP config: add skannr server`,
      serversKey: agent.serversKey ?? 'mcpServers',
    });
  }

  if (fs.existsSync(path.join(root, '.git'))) {
    plan.push({
      kind: 'hook',
      target: path.join(root, '.git', 'hooks', 'pre-commit'),
      description: 'Install guard pre-commit hook',
    });
  }

  if (scaffoldRules) {
    const rulesPath = path.join(root, '.skannr', 'rules.json');
    if (!fs.existsSync(rulesPath)) {
      plan.push({
        kind: 'rules',
        target: rulesPath,
        description: 'Scaffold default rules at .skannr/rules.json',
      });
    }
  }

  return plan;
}

/** Result of applying one plan entry. */
export interface ApplyResult {
  entry: PlanEntry;
  status: 'written' | 'unchanged' | 'skipped';
  message: string;
}

/** Write the skannr MCP entry into a config file, merging with existing content. */
function applyMcp(target: string, serversKey: ServersKey): ApplyResult {
  const entry: PlanEntry = {
    kind: 'mcp',
    target,
    description: '',
    serversKey,
  };

  let existing: unknown;
  if (fs.existsSync(target)) {
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf-8'));
    } catch {
      return {
        entry,
        status: 'skipped',
        message: `Skipped ${target}: existing file is not valid JSON (leave it to fix manually)`,
      };
    }
  }

  const { config, changed } = mergeMcpConfig(existing, serversKey);
  if (!changed) {
    return { entry, status: 'unchanged', message: `Already configured: ${target}` };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { entry, status: 'written', message: `Wrote ${target}` };
}

/** Execute a plan. `root` is needed for the hook install. */
export function applyInit(plan: PlanEntry[], root: string): ApplyResult[] {
  const results: ApplyResult[] = [];

  for (const entry of plan) {
    if (entry.kind === 'skip') {
      results.push({ entry, status: 'skipped', message: entry.description });
    } else if (entry.kind === 'mcp') {
      results.push(applyMcp(entry.target, entry.serversKey ?? 'mcpServers'));
    } else if (entry.kind === 'hook') {
      const { installed, message } = installHook(root);
      results.push({
        entry,
        status: installed ? (message === 'Hook already installed.' ? 'unchanged' : 'written') : 'skipped',
        message,
      });
    } else {
      // rules
      if (fs.existsSync(entry.target)) {
        results.push({ entry, status: 'unchanged', message: `Already exists: ${entry.target}` });
      } else {
        fs.mkdirSync(path.dirname(entry.target), { recursive: true });
        fs.writeFileSync(entry.target, JSON.stringify(DEFAULT_RULES_FILE, null, 2) + '\n', 'utf-8');
        results.push({ entry, status: 'written', message: `Wrote ${entry.target}` });
      }
    }
  }

  return results;
}

export interface InitOptions {
  root: string;
  /** Skip the confirm prompt. */
  yes?: boolean;
  /** Restrict to a single agent by key. */
  agent?: string;
  /** Override home dir (for tests). */
  home?: string;
  /** Skip rules scaffolding. */
  noRules?: boolean;
  /** Write home-level configs instead of project-local ones. */
  global?: boolean;
}

/**
 * Run the full init flow for the CLI: detect, plan, confirm, apply.
 * Returns an exit code. Prompting is delegated to `confirm` so tests can skip it.
 */
export async function runInit(
  options: InitOptions,
  confirm: (plan: PlanEntry[]) => Promise<boolean>,
): Promise<number> {
  const root = path.resolve(options.root);
  const home = options.home ?? os.homedir();

  let agents = detectAgents(home, root);
  if (options.agent) {
    const match = AGENTS.find((a) => a.key === options.agent);
    if (!match) {
      process.stderr.write(
        `Unknown agent "${options.agent}". Valid: ${AGENTS.map((a) => a.key).join(', ')}\n`,
      );
      return 2;
    }
    agents = [match];
  }

  if (agents.length === 0) {
    process.stdout.write(
      'No supported coding agents detected. Use --agent <name> to configure one explicitly.\n' +
        `Valid agents: ${AGENTS.map((a) => a.key).join(', ')}\n`,
    );
    return 0;
  }

  const plan = planInit(agents, home, root, {
    scaffoldRules: !options.noRules,
    global: options.global,
  });
  const actionable = plan.filter((p) => p.kind !== 'skip');
  if (actionable.length === 0) {
    for (const p of plan) process.stdout.write(`  ! ${p.description}\n`);
    process.stdout.write('\nNothing to configure for the selected scope.\n');
    return 0;
  }

  if (!options.yes) {
    const ok = await confirm(plan);
    if (!ok) {
      process.stdout.write('Aborted. No changes made.\n');
      return 0;
    }
  }

  const results = applyInit(plan, root);
  for (const r of results) {
    const mark = r.status === 'written' ? '+' : r.status === 'unchanged' ? '=' : '!';
    process.stdout.write(`  ${mark} ${r.message}\n`);
  }
  process.stdout.write('\nDone. Say to your agent: "review my staged changes with skannr".\n');
  return 0;
}
