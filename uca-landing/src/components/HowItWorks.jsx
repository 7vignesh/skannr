import Reveal from './Reveal'

const steps = [
  {
    title: 'Point it at any repo',
    code: 'npx skannr "how does auth work?"',
    desc: "No install needed. Works on repos you've never touched before. Auto-detects language and module structure from the folder layout.",
  },
  {
    title: 'Hybrid ranking finds the right files',
    desc: 'Three signals combined: lexical match (keyword relevance), structural analysis (export/import density), and dependency graph centrality. Finds architecturally important files - not just keyword matches.',
  },
  {
    title: 'Skeletons compress without losing meaning',
    desc: 'Function bodies stripped. Signatures, types, interfaces, and imports remain. The AI gets the architectural picture at a fraction of the token cost (88% fewer tokens on average in our benchmarks). Each result says why it matched.',
  },
  {
    title: 'Check risk before you push',
    code: 'npx skannr risk',
    desc: 'Analyzes your uncommitted changes, traverses the dependency graph to find downstream affected files, flags untested code, and gives you a 0-10 risk score. Deterministic, no API call.',
  },
  {
    title: 'AI code review on every commit',
    code: 'npx skannr guard',
    desc: 'Reviews staged changes against coding rules at the symbol level. Auto-detects your coding agent (Claude, Gemini, Kiro, Ollama) — no API key needed if you already use one. Install as a pre-commit hook with "skannr guard install".',
  },
  {
    title: 'Plug into any AI tool via MCP',
    code: 'npx -y skannr --mcp',
    desc: 'One config line gives Cursor, Claude Code, Gemini CLI, or any MCP tool access to codebase search, risk analysis, and guard review. Your assistant calls skannr automatically when you ask about code.',
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 px-5">
      <div className="max-w-5xl mx-auto">
        <Reveal>
          <h2 className="text-3xl md:text-5xl font-bold text-center tracking-tight">
            Simple to use. Sophisticated underneath.
          </h2>
        </Reveal>

        <div className="mt-14 overflow-hidden rounded-xl border border-border bg-card px-5 md:px-10">
          {steps.map((step, idx) => (
            <Reveal key={step.title} delay={idx * 100} className="w-full">
              <div
                className={`group grid gap-6 py-10 md:grid-cols-[120px,1fr] ${idx < steps.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <span className="font-mono text-7xl font-bold leading-none text-white/5 transition-colors duration-500 group-hover:text-accent/25">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="text-2xl font-semibold transition-colors duration-300 group-hover:text-white">
                    {step.title}
                  </h3>
                  {step.code && (
                    <code className="mt-4 block w-fit rounded-lg border border-border px-3 py-2 font-mono text-sm text-accent transition-all duration-300 group-hover:border-accent/30 group-hover:shadow-[0_0_20px_-8px_rgba(0,212,255,0.35)]">
                      {step.code}
                    </code>
                  )}
                  <p className="mt-4 text-[#888]">{step.desc}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
