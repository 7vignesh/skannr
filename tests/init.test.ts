/**
 * Tests for `skannr init`: MCP merge, agent detection, planning, and apply.
 * All filesystem work happens in an injected temp home/root, never the real home.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  mergeMcpConfig,
  resolvePath,
  detectAgents,
  planInit,
  applyInit,
  runInit,
  AGENTS,
  SKANNR_MCP_ENTRY,
} from '../src/init';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('mergeMcpConfig', () => {
  const entry = { command: SKANNR_MCP_ENTRY.command, args: [...SKANNR_MCP_ENTRY.args] };

  it('adds skannr to an empty/undefined config', () => {
    const { config, changed } = mergeMcpConfig(undefined);
    expect(changed).toBe(true);
    expect((config.mcpServers as any).skannr).toEqual(entry);
  });

  it('preserves other servers', () => {
    const existing = { mcpServers: { other: { command: 'foo', args: ['bar'] } } };
    const { config, changed } = mergeMcpConfig(existing);
    expect(changed).toBe(true);
    const servers = config.mcpServers as any;
    expect(servers.other).toEqual({ command: 'foo', args: ['bar'] });
    expect(servers.skannr).toEqual(entry);
  });

  it('is idempotent when skannr already present and identical', () => {
    const existing = { mcpServers: { skannr: entry } };
    const { changed } = mergeMcpConfig(existing);
    expect(changed).toBe(false);
  });

  it('updates skannr when the existing entry differs', () => {
    const existing = { mcpServers: { skannr: { command: 'old', args: [] } } };
    const { config, changed } = mergeMcpConfig(existing);
    expect(changed).toBe(true);
    expect((config.mcpServers as any).skannr).toEqual(entry);
  });

  it('handles a non-object (malformed) input by starting fresh', () => {
    const { config, changed } = mergeMcpConfig('not an object');
    expect(changed).toBe(true);
    expect((config.mcpServers as any).skannr).toEqual(entry);
  });

  it('preserves top-level keys other than mcpServers', () => {
    const existing = { someSetting: 42, mcpServers: {} };
    const { config } = mergeMcpConfig(existing);
    expect(config.someSetting).toBe(42);
  });

  it('writes VS Code format under "servers" with type stdio', () => {
    const existing = { servers: { other: { type: 'stdio', command: 'foo' } }, inputs: [] };
    const { config, changed } = mergeMcpConfig(existing, 'servers');
    expect(changed).toBe(true);
    expect(config.mcpServers).toBeUndefined();
    expect(config.inputs).toEqual([]);
    const servers = config.servers as any;
    expect(servers.other).toEqual({ type: 'stdio', command: 'foo' });
    expect(servers.skannr).toEqual({ type: 'stdio', ...entry });
    expect(mergeMcpConfig(config, 'servers').changed).toBe(false);
  });
});

describe('resolvePath', () => {
  it('resolves ~ to home', () => {
    expect(resolvePath('~', '/home/u', '/proj')).toBe('/home/u');
  });
  it('resolves ~/x against home', () => {
    expect(resolvePath('~/.claude', '/home/u', '/proj')).toBe(path.join('/home/u', '.claude'));
  });
  it('resolves relative paths against root', () => {
    expect(resolvePath('.mcp.json', '/home/u', '/proj')).toBe(path.join('/proj', '.mcp.json'));
  });
});

describe('detectAgents', () => {
  it('detects an agent when its home dir exists', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      const detected = detectAgents(home, root);
      expect(detected.map((a) => a.key)).toContain('claude-code');
      expect(detected.map((a) => a.key)).not.toContain('cursor');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects an agent by a project-local marker', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      fs.mkdirSync(path.join(root, '.vscode'));
      const detected = detectAgents(home, root);
      expect(detected.map((a) => a.key)).toContain('vscode-copilot');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns nothing when no markers exist', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      expect(detectAgents(home, root)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('planInit + applyInit', () => {
  it('plans and writes project-local MCP config + rules, is idempotent on re-run', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      const claude = AGENTS.find((a) => a.key === 'claude-code')!;

      const plan1 = planInit([claude], home, root);
      // mcp + rules (no .git, so no hook)
      expect(plan1.map((p) => p.kind).sort()).toEqual(['mcp', 'rules']);

      const results1 = applyInit(plan1, root);
      expect(results1.every((r) => r.status === 'written')).toBe(true);

      // MCP file written with skannr entry
      const mcpPath = path.join(root, '.mcp.json');
      const written = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      expect(written.mcpServers.skannr).toEqual({
        command: SKANNR_MCP_ENTRY.command,
        args: [...SKANNR_MCP_ENTRY.args],
      });

      // Rules file scaffolded
      expect(fs.existsSync(path.join(root, '.skannr', 'rules.json'))).toBe(true);

      // Re-plan: rules already exists, so only mcp remains; applying is unchanged
      const plan2 = planInit([claude], home, root);
      expect(plan2.map((p) => p.kind)).toEqual(['mcp']);
      const results2 = applyInit(plan2, root);
      expect(results2[0].status).toBe('unchanged');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes gemini-cli project-local by default and home-level with --global', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      const gemini = AGENTS.find((a) => a.key === 'gemini-cli')!;
      const expected = { command: SKANNR_MCP_ENTRY.command, args: [...SKANNR_MCP_ENTRY.args] };

      applyInit(planInit([gemini], home, root, { scaffoldRules: false }), root);
      const local = JSON.parse(fs.readFileSync(path.join(root, '.gemini', 'settings.json'), 'utf-8'));
      expect(local.mcpServers.skannr).toEqual(expected);
      expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);

      const results = applyInit(planInit([gemini], home, root, { scaffoldRules: false, global: true }), root);
      expect(results[0].status).toBe('written');
      const global = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf-8'));
      expect(global.mcpServers.skannr).toEqual(expected);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes .vscode/mcp.json in VS Code format and skips VS Code with --global', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      const vscode = AGENTS.find((a) => a.key === 'vscode-copilot')!;

      applyInit(planInit([vscode], home, root, { scaffoldRules: false }), root);
      const cfg = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'mcp.json'), 'utf-8'));
      expect(cfg.servers.skannr).toEqual({
        type: 'stdio',
        command: SKANNR_MCP_ENTRY.command,
        args: [...SKANNR_MCP_ENTRY.args],
      });
      expect(cfg.mcpServers).toBeUndefined();

      const globalPlan = planInit([vscode], home, root, { scaffoldRules: false, global: true });
      expect(globalPlan.map((p) => p.kind)).toEqual(['skip']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('default scope never writes outside the project root', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      // all agents, project-local scope
      const plan = planInit(AGENTS, home, root, { scaffoldRules: false });
      const results = applyInit(plan, root);
      // nothing written under home
      for (const r of results) {
        if (r.status === 'written') {
          expect(r.entry.target.startsWith(root)).toBe(true);
        }
      }
      // home has no skannr artifacts
      const homeEntries = fs.readdirSync(home);
      expect(homeEntries).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a malformed existing MCP config instead of clobbering it', () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      const mcpPath = path.join(root, '.mcp.json');
      fs.writeFileSync(mcpPath, '{ not valid json', 'utf-8');
      const claude = AGENTS.find((a) => a.key === 'claude-code')!;
      const results = applyInit(planInit([claude], home, root, { scaffoldRules: false }), root);
      expect(results[0].status).toBe('skipped');
      // original content untouched
      expect(fs.readFileSync(mcpPath, 'utf-8')).toBe('{ not valid json');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runInit', () => {
  it('aborts without writing when confirm returns false', async () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      const code = await runInit({ root, home }, async () => false);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes when --yes skips confirm', async () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      fs.mkdirSync(path.join(home, '.claude'));
      const confirm = jest.fn();
      const code = await runInit({ root, home, yes: true }, confirm as any);
      expect(code).toBe(0);
      expect(confirm).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('errors on an unknown --agent', async () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      const code = await runInit({ root, home, agent: 'nope' }, async () => true);
      expect(code).toBe(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports nothing to do when no agents detected and none forced', async () => {
    const home = tmpDir('skannr-home-');
    const root = tmpDir('skannr-root-');
    try {
      const code = await runInit({ root, home }, async () => true);
      expect(code).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
