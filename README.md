# Skannr

A CLI tool and MCP server that helps developers and AI assistants understand any codebase. Scans files, generates compressed structural skeletons, and ranks results using hybrid retrieval. Reduces token usage by 96.5% vs full file reads.

## Install

```bash
npm install -g skannr
```

Or use without installing:

```bash
npx skannr "how does auth work?"
```

## Usage

### Ask about any codebase

```bash
skannr "how does authentication work?"
skannr "database queries" -n 5
skannr "API endpoints" --json
skannr "class structure" --lang python
```

No config needed. Auto-detects language and module structure.

### Risk analysis

Check the downstream impact of your changes before pushing:

```bash
skannr risk
skannr risk --json
skannr risk -n 3
skannr risk --diff feature.patch
```

Walks the dependency graph, finds affected files, flags untested code, gives you a 0-10 score. No LLM, no API key, runs in under 2 seconds.

### Guard (AI code review)

Reviews staged changes against coding rules at the symbol level:

```bash
git add .
skannr guard
skannr guard --fix
skannr guard --fix --dry-run
skannr guard --pr-mode
skannr guard --base origin/develop
skannr guard --json
```

Auto-detects your coding agent (Claude, Gemini, Kiro, Ollama). No API key needed if you already have one installed. Works out of the box with built-in rules.

Install as a pre-commit hook:

```bash
skannr guard install
skannr guard uninstall
```

Custom rules (optional):

```json
// .skannr/rules.json
{
  "rules": [
    {
      "id": "no-mutations",
      "description": "Do not mutate function arguments",
      "severity": "high",
      "fixable": false,
      "category": "functional"
    }
  ]
}
```

### GitHub Action

Run guard on every pull request. Add a repository secret named `GEMINI_API_KEY` (or `OPENAI_API_KEY`), then create `.github/workflows/skannr.yml`:

```yaml
name: Skannr Guard
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # for the PR comment

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: 7vignesh/skannr@main
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

The action reviews the diff between the PR base branch and the PR head, writes the findings to the job summary, uploads the JSON report as the `skannr-guard-report` artifact, and posts or updates one PR comment. The job fails when guard reports blocking violations (a high or critical finding with at least 70% confidence).

| Input | Default | Description |
|---|---|---|
| `gemini-api-key` | | Gemini API key. Used when set. |
| `openai-api-key` | | OpenAI or OpenAI-compatible API key. Used when no Gemini key is set. |
| `openai-base-url` | `https://api.openai.com/v1` | Base URL for an OpenAI-compatible API. |
| `model` | provider default | Model name override. |
| `base` | PR base branch | Branch to diff against. |
| `fail-on-violations` | `true` | Fail the job when guard reports `fail`. |
| `comment` | `true` | Post or update a PR comment. Needs `pull-requests: write`. |
| `github-token` | `github.token` | Token used for the comment. |

Outputs: `status` (`pass`, `fail`, `skipped`, or `error`) and `report-path`.

Behavior to know:
- No API key: the action skips the review, adds a notice, and passes. Pull requests from forks do not receive secrets, so they are skipped.
- Tool errors (provider outage, bad key) produce a warning and do not fail the job. Only guard violations fail it.
- The action sends the PR diff to the provider you configure. Do not use `pull_request_target` with this action: it would run on untrusted fork code with your secrets.
- `@main` tracks the latest code. Pin to a commit SHA for stable behavior.

### Other commands

```bash
skannr report          # repo health summary (JSON)
skannr agent           # interactive exploration mode
skannr cache stats     # cache hit rate
skannr cache clear     # wipe cache
```

## Supported Languages

| Language | Support | Method |
|---|---|---|
| TypeScript / TSX | Full AST | ts-morph |
| JavaScript / JSX | Full AST | ts-morph |
| Python | Full AST | tree-sitter WASM |
| Go | Full AST | tree-sitter WASM |
| Rust | Full AST | tree-sitter WASM |
| Java | Full AST | tree-sitter WASM |
| Others | Basic | First 50 lines fallback |

No native build tools required. WASM grammars run everywhere npm runs.

## MCP Server

Exposes three tools: `scan_codebase`, `blast_radius`, `guard_review`.

One-time setup for your AI tool:

```json
{
  "mcpServers": {
    "skannr": {
      "command": "npx",
      "args": ["-y", "skannr", "--mcp"]
    }
  }
}
```

Works with Cursor, Claude Code, Gemini CLI, Kiro, VS Code Copilot, and any MCP-compatible tool.

After setup, just ask your assistant:
- "How does auth work in this repo?"
- "Review my staged changes"
- "What's the risk of my current diff?"

## Risk Score Formula

```
risk = 2.5 x (affected files / total files)
     + 2.5 x (avg centrality of affected files)
     + 3.5 x (% of affected files with no tests)
     + 1.5 x (max hop reached / max hops configured)
```

Deterministic. Same diff always produces the same score. CI-gateable:

```bash
RISK=$(skannr risk --json | jq '.riskScore')
if [ $(echo "$RISK > 7" | bc -l) -eq 1 ]; then exit 1; fi
```

## Guard Providers

Guard auto-detects in this order (no config needed):

1. `claude` CLI (uses your existing session)
2. `gemini` CLI (uses your existing session)
3. `kiro-cli` (uses your existing session)
4. `ollama` (local, no auth)
5. Gemini API (set `GEMINI_API_KEY`)
6. OpenAI API (set `OPENAI_API_KEY`)

Override with `SKANNR_GUARD_PROVIDER` env var or `.skannr/guard.json`.

## Config File (optional)

```json
// code-analyzer.config.json (project root)
{
  "modules": {
    "auth": ["src/auth", "lib/auth"],
    "api": ["src/api", "src/routes"]
  },
  "exclude": ["**/generated/**", "**/migrations/**"],
  "extensions": [".ts", ".js"],
  "defaultLimit": 10
}
```

## Performance

| Metric | Result |
|---|---|
| Token reduction vs full scan | 96.5% |
| Typical query time | 1-2 seconds |
| Risk analysis | under 2 seconds (no API call) |
| Guard review | 5-15 seconds (LLM round-trip) |
| Package size | 450KB compressed |

## Interactive Agent

```bash
skannr agent
```

Commands inside the agent:

```
/files             List retrieved files
/symbols <query>   Search for symbols
/symbol <id>       Get full implementation
/deps <file>       Show imports for a file
/refresh           Re-analyze with new context
/stats             Show mapping statistics
/exit              Quit
```

Requires `GEMINI_API_KEY` for the interactive agent mode.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions, technology choices, and the reasoning behind each one.

## License

MIT
