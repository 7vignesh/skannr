import {
  AlertTriangle,
  Code2,
  Database,
  FileSearch,
  Network,
  Plug,
  RefreshCw,
  Shield,
  Zap,
} from 'lucide-react'
import Reveal from './Reveal'

const features = [
  {
    icon: Network,
    title: 'Hybrid Retrieval',
    body: 'Lexical + structural + dependency-graph ranking. Finds architecturally central files, not just keyword matches.',
  },
  {
    icon: Zap,
    title: 'Fewer Tokens',
    body: 'Skeletons keep signatures and types and drop function bodies. On six measured queries the result used 72% to 97% fewer tokens than the whole module, 88% on average.',
  },
  {
    icon: AlertTriangle,
    title: 'Risk Analysis',
    body: 'Run "skannr risk" before pushing. Traverses the dependency graph, finds downstream affected files, flags untested code, and scores risk 0-10. Deterministic, with no API call.',
  },
  {
    icon: Shield,
    title: 'Guard — AI Code Review',
    body: 'Run "skannr guard" to review staged changes against team-defined rules. Symbol-level analysis with cross-file context. Auto-fix what\'s fixable, block what isn\'t. Installs as a pre-commit hook.',
  },
  {
    icon: Code2,
    title: 'Multi-Language AST',
    body: "TypeScript, JavaScript, Python, Go, Rust, and Java — all parsed via AST. No native build tools required. WASM-based tree-sitter runs everywhere npm does.",
  },
  {
    icon: Database,
    title: 'Smart Caching',
    body: 'MD5-based file hashing detects changes automatically. Repeated queries run in milliseconds. 24-hour TTL with manual controls.',
  },
  {
    icon: FileSearch,
    title: 'Ranked With Reasons',
    body: 'Every ranked file says why it matched: which query words it contains and whether its module name matches. You can see why a file made the list.',
  },
  {
    icon: Plug,
    title: 'MCP Server Built In',
    body: 'Runs as a Model Context Protocol server. Plug into Gemini CLI, Claude Code, Cursor, or any MCP-compatible tool.',
  },
  {
    icon: RefreshCw,
    title: 'Watch Mode',
    body: 'Use --watch on large repos you touch daily. Skannr debounces file changes and re-analyzes with a fresh run (cache bypassed per pass) so output stays current.',
  },
]

export default function Features() {
  return (
    <section id="features" className="py-24 px-5">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <h2 className="text-3xl md:text-5xl font-bold text-center tracking-tight">
            Everything you need. Nothing you don't.
          </h2>
        </Reveal>
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map(({ icon: Icon, title, body }, i) => (
            <Reveal key={title} delay={i * 70} className="h-full">
              <article className="group h-full rounded-xl border border-border bg-card p-6 transition-all duration-300 hover:-translate-y-1 hover:border-accent/40 hover:bg-card-hover hover:shadow-[0_0_36px_rgba(0,212,255,0.12)]">
                <Icon
                  size={24}
                  className="mb-4 text-accent transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3"
                />
                <h3 className="mb-2 text-xl font-semibold">{title}</h3>
                <p className="text-[#888]">{body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
