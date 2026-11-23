import { useState } from 'react'
import Reveal from './Reveal'

const tabs = ['CLI Install', 'npx', 'MCP Server', 'GitHub Action']

const snippets = {
  'CLI Install': `npm install -g skannr

# Ask about any codebase
skannr "how does auth work?"

# Limit results, JSON output
skannr "database queries" -n 5 --json

# Check risk before pushing
skannr risk

# Review staged code against team rules
skannr guard
skannr guard --fix
skannr guard install    # pre-commit hook

# Try it on a throwaway repo, or wire up your agents
skannr demo
skannr init

# Interactive agent mode
skannr agent`,
  npx: `# Run without installing
npx skannr "how does this work?"

# Risk check (no install needed)
npx skannr risk

# Guard review
npx skannr guard --json

# Health report
npx skannr report

# Cache management
npx skannr cache stats`,
  'GitHub Action': `# .github/workflows/skannr.yml
name: Skannr Guard
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: 7vignesh/skannr@main
        with:
          gemini-api-key: \${{ secrets.GEMINI_API_KEY }}`,
  'MCP Server': `{
  "mcpServers": {
    "skannr": {
      "command": "npx",
      "args": ["-y", "skannr", "--mcp"]
    }
  }
}`,
}

export default function Install() {
  const [active, setActive] = useState('CLI Install')
  const [copied, setCopied] = useState(false)

  const doCopy = async () => {
    await navigator.clipboard.writeText(snippets[active])
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section id="install" className="py-24 px-5">
      <div className="max-w-5xl mx-auto">
        <Reveal>
          <h2 className="text-3xl md:text-5xl font-bold text-center tracking-tight">Up in 30 seconds.</h2>
        </Reveal>

        <div className="mt-10 flex flex-wrap justify-center gap-2">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActive(tab)}
              className={`rounded-lg border px-4 py-2 text-sm transition-all duration-300 ${
                active === tab
                  ? 'border-accent bg-accent/10 text-accent shadow-[0_0_24px_-8px_rgba(0,212,255,0.35)]'
                  : 'border-white/10 text-[#888] hover:border-white/25 hover:text-white'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div
          key={active}
          className="mt-8 overflow-hidden rounded-xl border border-border bg-card motion-safe:animate-fade-in motion-reduce:animate-none"
        >
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
            <div className="flex gap-2">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            </div>
            <button
              onClick={doCopy}
              className="rounded-md border border-white/15 px-3 py-1 text-sm transition-all duration-300 hover:border-accent hover:text-accent hover:shadow-[0_0_16px_-4px_rgba(0,212,255,0.4)] active:scale-95"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-sm text-[#e8e8e8]">{snippets[active]}</pre>
        </div>

        {active === 'MCP Server' && (
          <p className="mt-4 text-sm text-[#888]">
            Or run skannr init to write this for the agents it finds in your project. By hand, add it to
            .cursor/mcp.json, .mcp.json (Claude Code), or your agent's MCP config.
          </p>
        )}

        {active === 'GitHub Action' && (
          <p className="mt-4 text-sm text-[#888]">
            Add GEMINI_API_KEY (or OPENAI_API_KEY) as a repository secret. Without a key the action skips the review and passes.
          </p>
        )}

        <p className="mt-4 text-sm text-[#888]">
          init, demo and the action are on main and arrive in the next npm release. The published 0.2.4 does not have them yet.
        </p>
      </div>
    </section>
  )
}
