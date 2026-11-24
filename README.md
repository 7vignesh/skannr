# Skannr

A CLI tool and MCP server that helps developers and AI assistants understand any codebase. Scans files, generates compressed structural skeletons, and ranks results using hybrid retrieval. On six queries against NestJS, TypeORM and tRPC, the skeletons it returned used 72% to 97% fewer tokens than the whole module (88% on average). See [Benchmarks](./docs/BENCHMARKS.md) for the method and the limits.

## Install

```bash
npm install -g skannr
```

Or use without installing:

```bash
npx skannr "how does auth work?"
```

## Quick start

```bash
npx skannr demo     # see a review on a throwaway repo with a planted bug (no setup)
npx skannr init     # connect skannr to the coding agents it finds in this project
```

`demo` builds a temporary git repo with a hardcoded secret, runs guard on it, and deletes the repo. If no review provider is available it prints a labelled sample instead. Use `--sample` to skip the provider call.

`init` finds Claude Code, Cursor, Kiro, VS Code Copilot and Gemini CLI by their config folders, lists exactly what it will write, and asks once. It adds the skannr MCP server to each agent's **project-local** config, installs the guard pre-commit hook, and creates `.skannr/rules.json` if there is none. It never touches your home directory unless you pass `--global`.

```bash
skannr init --yes              # no prompt
skannr init --agent cursor     # one agent only
skannr init --global           # write home-level configs instead
skannr init --no-rules         # do not create .skannr/rules.json
```

Existing config is merged, not replaced, and running `init` twice changes nothing.

> `init` and `demo` are on `main` but not in the published 0.2.4 package yet. Until the next release, run them from a checkout (`npm install && npm run build && node dist/cli.js init`).

## Benchmarks

`npm run bench:tokens` measures what skannr's skeletonizer does to whole directories of TypeScript. For each target it lists the `.ts` and `.tsx` files once (skipping `node_modules`, `dist`, `.git`, `.next` and `*.d.ts`), counts the tokens of the raw source and of the skeleton skannr builds for the same files with the `o200k_base` tokenizer, and times building every skeleton (one warmup pass, then the median of five timed passes).

| Target | Files | Lines | Raw tokens | Skeleton tokens | Token reduction | Input cost saved per query* | Median skeleton time (ms) | Per file (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| skannr `src/guard` (small) | 18 | 2,217 | 18,375 | 5,950 | 67.6% | $0.0311 | 2,015 | 112 |
| skannr `src` (medium) | 48 | 9,144 | 69,284 | 20,346 | 70.6% | $0.1223 | 5,601 | 117 |
| trpc/trpc `packages/server/src` @8405090 (large) | 110 | 18,679 | 127,823 | 50,879 | 60.2% | $0.1924 | 10,221 | 93 |

\* Assumed reference rate of $2.50 per 1M input tokens, applied to the measured token counts. It is not a measured price.

Tokens: o200k_base (gpt-tokenizer). Time: median of the timed runs for building every skeleton in the target, including reading the files.

Measured at skannr commit `c5a0edb` on Windows x64, 11th Gen Intel Core i5-1135G7 @ 2.40GHz (8 threads), 16 GB RAM, Node v22.21.1, `gpt-tokenizer` 4.1.2. The large target is tRPC at commit `8405090`, cloned by the script into `benchmarks/.fixtures/`. Every timed run is in [`benchmarks/results/token-bench.json`](./benchmarks/results/token-bench.json). To reproduce, run `npm install && npm run bench:tokens` (the first run clones tRPC); `--targets dirA,dirB` measures your own directories.

How to read it:

- **Token counts are exact for `o200k_base`** and were identical in all three runs. Other models tokenize differently.
- **Times are not stable on this machine.** I ran the same code three times. Median skeleton time for skannr `src/guard` (small): 2,036, 2,290, 2,015 ms. For skannr `src` (medium): 18,346, 16,571, 5,601 ms. For trpc/trpc `packages/server/src` @8405090 (large): 32,699, 9,848, 10,221 ms. The table above is the third and last run, not a selection; it was the fastest of the three for two of the three targets. The first run called the script with `npx tsx`, the others with `npm run bench:tokens`. When I checked after the second run the laptop was on battery (34%) with several other programs open, and I did not control for that, so treat the times as rough.
- **The dollar column is an assumption applied to measured tokens.** It is what the token difference would cost at the stated reference rate if you sent the whole directory raw instead of as skeletons. No model was called.
- **This is a different measurement from [Performance](#performance).** The table compresses every file in a directory and does no ranking. The `skannr benchmark` command (see [docs/BENCHMARKS.md](./docs/BENCHMARKS.md)) asks a question and returns the 10 best-matching files as skeletons, so its reduction against the whole module also includes the effect of leaving files out. Neither replaces the other.
- **Only TypeScript was measured**, on three directories, on one machine.

Whether a model answers as well from skeletons as from the full source is not measured here. `npm run bench:eval` asks a model eight questions about this repository once with the raw source and once with skeletons, and scores the answers. It needs `OPENROUTER_API_KEY` or `OPENAI_API_KEY` and **has not been run**, so there are no accuracy results and none of the figures above say anything about answer quality. `npm run bench:eval -- --dry-run` validates the questions and builds the prompts without calling a model.

When raw files are the better choice:

- You need to know what a function does, not what it is called. Skeletons replace function and method bodies, and most variable initializers, with a placeholder, so logic, error handling and exact constants are gone.
- You need exact types. In this repository's own skeletons some parameters come out as `any` where the source has a named type (`analyzeProject`'s `options` is one).
- The files are small. Each skeleton adds a header and a comment with source line numbers per declaration, so little is saved, and in one scenario of the ranking benchmark the skeletons were larger than the raw files (see [docs/BENCHMARKS.md](./docs/BENCHMARKS.md)).
- Skeleton building is not free: the times above are seconds to tens of seconds for the directories measured. Repeated queries are served from a cache (see [Performance](#performance)).

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

Walks the dependency graph, finds affected files, flags untested code, gives you a 0-10 score. No LLM, no API key. About 1.4 seconds on a 66-file repo; see [Performance](#performance) for large repos.

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

### Security scanners

Guard also runs three deterministic scanners on the same change. They are optional: a scanner that is not installed is skipped, shown in the output, and never fails the review.

| Scanner | Finds | Scope |
|---|---|---|
| [gitleaks](https://github.com/gitleaks/gitleaks) | hardcoded secrets | the staged diff, or every commit in `base..HEAD` with `--base`/`--pr-mode`, so a secret added and then deleted on the same branch is still reported |
| [semgrep](https://semgrep.dev) | insecure code patterns (`p/default` rules) | the changed files, only on lines the change added |
| [osv-scanner](https://github.com/google/osv-scanner) | known vulnerabilities in changed lockfiles | only vulnerabilities the change introduces, not ones already at the base |

Install whichever you want on your `PATH`; skannr finds them by name. semgrep needs Python (`pip install semgrep`) and has no native Windows build, so on Windows run it under WSL. Findings appear in the same list as LLM findings, tagged by rule (`gitleaks:aws-access-token`), and the JSON output includes each violation's `source` and a `scanners` report of what ran and what was skipped.

A secret or a critical vulnerability fails the review on its own, even when the LLM provider is down. Use `skannr guard --no-scanners` to skip them.

Privacy: gitleaks and osv-scanner read your files locally. osv-scanner sends package names and versions to osv.dev. semgrep downloads its rules from semgrep.dev on first use and runs with metrics off. None of them send your source code.

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
- The scanners are not installed on the runner, so the action runs the LLM review only. Add install steps for gitleaks, semgrep, and osv-scanner before the action to enable them.
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

Measured on Windows x64 (i5-1135G7, 16 GB), Node 22, cold cache. Full method and per-scenario numbers in [docs/BENCHMARKS.md](./docs/BENCHMARKS.md).

| Metric | Result |
|---|---|
| Token reduction vs the whole module | 87.7% mean, 72.1% to 96.6% (6 queries, 3 repos) |
| Token reduction vs the same top 10 files unskeletonized | 42.7% mean, -4.3% to 70.7% |
| Query, 52 to 105 files, cold | 7 to 14 seconds |
| Query, 294 to 496 files, cold | 64 to 77 seconds |
| Query, repeated (cache hit) | about 0.1 seconds |
| Query on this repo (66 files), cold / warm | about 2.0 / 0.6 seconds |
| `skannr risk`, one file changed, 2,277-file repo | 20 to 24 seconds |
| `skannr risk`, one file changed, this repo | about 1.4 seconds |
| Peak memory, one query | about 280 to 290 MB |
| Guard review | depends on the provider (an LLM round trip) |
| Package size (0.2.4) | 453 KB packed, 2.8 MB unpacked |

Cold queries on large modules are slow. This is tracked in [#16](https://github.com/7vignesh/skannr/issues/16). Timings on this machine varied by several times between identical runs (see [Benchmarks](#benchmarks)), so read the times in this table as rough. This table measures ranked queries; [Benchmarks](#benchmarks) measures skeleton building on whole directories.

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

## Privacy

skannr runs on your machine. These commands make **no network connection**: asking a question, `risk`, `report`, `cache`, `init`. I checked this by recording every socket and DNS lookup the CLI makes.

What can leave your machine:

| When | What is sent | To |
|---|---|---|
| `skannr guard` | the changed code, with caller and callee names | the provider you chose: your `claude`, `gemini` or `kiro-cli` session, a local `ollama`, or the Gemini or OpenAI API with your key |
| `skannr agent` | the retrieved skeletons and your questions | the Gemini API, with your key |
| guard scanners | osv-scanner sends package names and versions; semgrep downloads its rules on first use | osv.dev, semgrep.dev |
| telemetry, see below | which flags you used, an anonymous id, skannr and Node versions, OS | `skannr-telemetry.vercel.app` |

Telemetry never includes code, questions, or file paths. It only fires for questions asked with `skannr "<question>"`, and only when enabled. **It is enabled automatically 7 days after the first-run banner unless you turn it off.** The banner says so. Run `skannr --telemetry-off` to disable it for good, or `--telemetry-on` to enable it at once. This default is being reviewed in [#17](https://github.com/7vignesh/skannr/issues/17).

## License

MIT
