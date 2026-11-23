Skannr: Architecture and Design Decisions

Overview

Skannr is a CLI tool, MCP server, and library that helps developers and AI assistants understand codebases without reading every file. It scans a project, generates compressed structural skeletons of the most relevant files, and returns them ranked by relevance to a natural language question. On six benchmark queries the returned skeletons used 72% to 97% fewer tokens than the whole module (see docs/BENCHMARKS.md).

The tool also includes risk analysis (quantifying the downstream impact of a code change) and guard (AI code review against team rules with auto-fix capability).

Core Problem

AI coding assistants are limited by context windows. A typical repo has thousands of files. You cannot paste them all. The assistant sees only what you show it, and guesses the rest.

Existing approaches either dump full files (expensive, noisy) or do keyword search (misses architecturally central files that do not mention the search term directly). Neither approach understands the structural relationships between files.

Skannr solves this by combining three ranking signals with structural compression, so the AI gets the right files in the right format at minimal token cost.

System Architecture

The pipeline is linear and stateless. Each stage takes input from the previous stage and produces output for the next. There is no shared mutable state.

Input (question + root path)
  > File Scanner (discovers all source files)
  > Ranker (scores files by relevance using hybrid retrieval)
  > Skeletonizer (strips function bodies, keeps signatures and types)
  > Formatter (outputs human text, markdown, or JSON)

Each stage is a separate module. They communicate through typed interfaces, not through side effects.

File Layout

src/
  cli.ts              Command registration (Commander.js, subcommands)
  index.ts            Library entry point, orchestrates the pipeline
  scanner.ts          File discovery with gitignore awareness
  ranker.ts           Basic keyword relevance scoring
  ranker-enhanced.ts  Hybrid ranking with dependency graph analysis
  skeletonizer.ts     Routes files to the correct language adapter
  formatter.ts        Output formatting (human, markdown, JSON)
  blast-radius.ts     Risk analysis (diff parsing, graph traversal, scoring)
  guard/              AI code review module (schema, provider, fix applier)
  languages/          Language adapters (TypeScript via ts-morph, others via WASM)
  mcp-server.ts       MCP tool registration for AI assistant integration
  types.ts            Shared type definitions

Design Decisions

1. Hybrid Retrieval over Pure Keyword Search

Decision: Score files using three signals combined, not just keyword matching.

The three signals:
  Lexical: keyword frequency in file path and content, with synonym expansion
  Structural: export density, import relevance, symbol count
  Dependency graph: how many other files import this file (centrality)

Why: A file named utils.ts might contain the most architecturally important auth logic but never mention the word "auth" in its filename. Pure keyword search misses it. Dependency centrality catches it because everything imports it.

The weights are: lexical 50%, structural 20%, enhanced score 30%, with a dependency boost of 15% blended in. These were tuned empirically against large TypeScript monorepos.

2. AST Skeleton Generation over Summarization

Decision: Generate skeletons by stripping function bodies from the AST, not by asking an LLM to summarize.

Why:
  Deterministic (same input always produces same output)
  Fast (milliseconds, not seconds)
  Free (no API call)
  Lossless for architecture (all types, signatures, imports, class hierarchies preserved)
  Only lossy for implementation details (function bodies replaced with a placeholder)

The TypeScript adapter uses ts-morph (a TypeScript compiler API wrapper) which gives perfect AST access. For Python, Go, Rust, and Java, the tool uses web-tree-sitter (WASM compiled grammars) which gives equivalent structural parsing without requiring native C++ compilation.

3. WASM over Native Tree-sitter

Decision: Ship tree-sitter grammars as WASM files instead of native bindings.

Why: Native tree-sitter requires a C++ compiler (Visual Studio on Windows, Xcode on Mac). Most JavaScript developers do not have these installed. The npm install would fail for the majority of users.

WASM grammars are platform-independent. They run everywhere Node.js runs. The tradeoff is slightly slower parsing (roughly 2x), but since we only parse files the ranker already selected as relevant (typically 5-10 files), end-to-end times are in docs/BENCHMARKS.md.

The WASM files add 2MB to the package. This is acceptable because it eliminates a class of installation failures entirely.

4. File-level Dependency Graph (not Symbol-level)

Decision: Track dependencies at file granularity (file A imports file B) not at symbol granularity (function X calls function Y).

Why: Symbol-level call graphs require type resolution, which in turn requires a full project compilation context. TypeScript's type checker can do this but only for TS/JS. Python, Go, Rust, and Java would each need their own type resolver. The engineering cost is disproportionate to the accuracy gain for the primary use case (ranking files by relevance).

File-level import graphs are trivially extractable from any language via regex or AST import node detection. They provide sufficient signal for ranking and risk analysis.

This is documented as a stated limitation. Symbol-level resolution is planned for a future version.

5. Deterministic Risk Scoring over LLM-based Assessment

Decision: Compute risk as a weighted formula with named constants, not by asking an LLM "how risky is this."

The formula:
  risk = 2.5 * (affected files / total files)
       + 2.5 * (average centrality of affected files)
       + 3.5 * (fraction of affected files with no test coverage)
       + 1.5 * (max hop depth reached / max hops configured)

Why:
  Deterministic: same diff always produces same score
  No API call: runs locally (about 1.4 seconds on a 66-file repo, about 20 seconds on a 2,277-file repo)
  CI-gateable: you can block merges on a number, not on an LLM's mood
  Transparent: the formula is visible, the weights are named constants, the inputs are shown
  Reproducible: another developer running the same command gets the same result

The untested ratio has the highest weight (3.5 out of 10) because untested downstream code is the strongest signal that a merge is risky. This weighting was a deliberate choice: the number that should most influence whether someone trusts a merge is whether the things it might break have tests.

6. Guard: Structured JSON Contract over Text Parsing

Decision: Enforce schema-validated JSON responses from the LLM. Never parse free text looking for status keywords.

Why: This is a direct response to a known failure mode. Other tools in this space parse LLM responses as raw text, looking for a specific line (like "STATUS: PASSED") at a fixed position. This breaks when providers prepend acknowledgment text ("Sure! Here's my analysis:") before the actual response.

Skannr Guard uses:
  Gemini API's responseMimeType: 'application/json' (forces JSON output)
  OpenAI's response_format: { type: 'json_object' } (same)
  Zod schema validation on every response before using it
  A JSON extraction fallback that finds the first { to last } regardless of surrounding text
  One retry with an explicit correction prompt on validation failure

The violation object has a fixed schema. The fixable field is set by the rule definition, not by the LLM. This prevents the LLM from deciding on its own what it can auto-fix.

7. Guard: CLI Auto-detection over Mandatory API Keys

Decision: If the user has Claude Code, Gemini CLI, Kiro, or Ollama installed, use it directly. Do not require a separate API key.

Detection priority:
  1. claude CLI (uses existing Claude Code authenticated session)
  2. gemini CLI (uses existing Gemini authenticated session)
  3. kiro-cli (uses existing Kiro session)
  4. ollama (local, no auth needed)
  5. Gemini API (needs GEMINI_API_KEY)
  6. OpenAI API (needs OPENAI_API_KEY)

Why: The biggest friction in AI-powered dev tools is API key setup. If someone already has a coding agent installed and authenticated, they should not need to configure anything else. The tool should use what is already there.

This mirrors how GGA (gentleman-guardian-angel) works: it shells out to existing CLI tools rather than making its own API calls. The difference is that Skannr Guard also supports direct API calls as a fallback for users who do not have any CLI tool installed.

8. Subcommands over Flags

Decision: Structure the CLI as subcommands (skannr risk, skannr guard, skannr agent) rather than a single command with 20+ flags.

Why: The original CLI had --question, --root, --report, --cache-clear, --cache-stats, --diff, --watch, --mcp, --telemetry-on, --telemetry-off all on one command. Users had to read --help every time to find which flags go together.

Subcommands group related functionality. Each subcommand has only the flags relevant to it. The most common operation (asking a question) takes a bare positional argument:

  skannr "how does auth work?"

No flag needed. The tool should be typeable from memory after seeing it once.

Backward compatibility: all old flags still work. The new commands are aliases, not replacements.

9. Built-in Default Rules over Mandatory Configuration

Decision: Guard works without any rules file. Built-in defaults cover universal best practices.

Default rules: no-any-type, no-console-log, error-handling, no-hardcoded-secrets, function-complexity, unused-imports.

Why: Every extra file a tool requires before it works is friction that prevents adoption. If the user has to create .skannr/rules.json before they can try the tool, most will not try it.

The custom rules file is optional. When present, it overrides defaults. Teams that need domain-specific rules can add them. Everyone else gets reasonable defaults out of the box.

10. MCP as the Integration Layer

Decision: Expose all features as MCP tools (scan_codebase, blast_radius, guard_review) over stdio.

Why: MCP (Model Context Protocol) is the emerging standard for giving AI assistants access to external tools. One protocol works with Cursor, Claude Code, Gemini CLI, VS Code Copilot, and any future MCP-compatible tool.

The alternative would be building separate plugins for each editor. MCP avoids that entirely. One implementation, every tool.

The MCP server and CLI share the same internal functions. There is no code duplication between the two surfaces.

Technology Choices

TypeScript: The project itself is written in TypeScript. This aligns with the primary audience (JavaScript/TypeScript developers) and allows dogfooding the TypeScript adapter on the project itself.

Commander.js: CLI framework. Mature, well-typed, supports subcommands and positional arguments. Already a standard choice in the Node.js ecosystem.

ts-morph: TypeScript/JavaScript AST access. Wraps the TypeScript compiler API with a cleaner interface. Gives perfect type information, symbol extraction, and skeleton generation for TS/JS files.

web-tree-sitter: Multi-language parsing via WASM. No native compilation. Supports 40+ languages via grammar files. We bundle Python, Go, Rust, Java (2MB total).

parse-diff: Unified diff parsing. Small focused library, well-maintained, has types. Used by blast-radius to extract changed files and line ranges from git diffs.

zod: Schema validation for Guard's rules file and LLM response contract. Runtime type checking that integrates with TypeScript's type system.

@modelcontextprotocol/sdk: Official MCP SDK. Handles the stdio transport protocol so we only implement tool logic.

@google/generative-ai: Gemini SDK for Guard's direct API calls and the interactive agent mode.

What is Not Included (and Why)

No vector embeddings: Skannr does not use embeddings or a vector store. The hybrid ranking (lexical + structural + graph centrality) is sufficient for finding relevant files. Embeddings would add a model dependency, increase latency, and require a build step to generate the index.

No persistent index: Each run scans fresh. The cache is keyed by file hash (MD5) and invalidates automatically when files change. A persistent index would be faster for repeated queries on unchanged codebases, but adds complexity around invalidation and stale results.

No UI: Skannr is a CLI tool and MCP server. There is no web dashboard or VS Code extension. The landing page is marketing only. The tool's value is in the terminal and in the AI assistant context window.

No custom language grammars: Adding a new language means adding one config entry (which AST node types represent functions, classes, imports) and one WASM grammar file. We do not write custom parsers per language.

Testing Approach

Jest with ts-jest. Tests are in a flat tests/ directory, named *.test.ts.

Test patterns:
  Temp directories with real files (not mocks of the filesystem)
  beforeEach creates fixtures, afterEach cleans up
  WASM dependencies mocked in tests to avoid loading .wasm files in CI
  Integration tests run git commands in real temp repos

Coverage areas:
  Schema validation (valid input accepted, invalid input rejected)
  Graph traversal (correct hop distances, cycle handling, max-hop limits)
  Risk scoring (known input/output pairs)
  Fix scoping (never touches non-fixable violations)
  Hook installation (append-safe, idempotent, clean uninstall)

Performance Characteristics

Query, cold cache: 7 to 14 seconds for 52 to 105 files, 64 to 77 seconds for 294 to 496 files; about 0.1 seconds on a repeat (docs/BENCHMARKS.md)
Risk analysis: about 1.4 seconds on a 66-file repo, 20 to 24 seconds on a 2,277-file repo (no API call)
Guard review: depends on the provider (an LLM round trip)
Package size: 453KB compressed, 2.8MB unpacked (0.2.4)
Memory: peak about 280 to 290MB for one query
No background processes: runs, outputs, exits
