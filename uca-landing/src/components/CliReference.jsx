import Reveal from './Reveal'

const commands = [
  ['skannr demo', 'See a review on a throwaway repo with a planted bug (--sample skips the provider)'],
  ['skannr init', 'Connect skannr to the coding agents found in this project (--yes, --agent, --global)'],
  ['skannr "<question>"', 'Ask about the codebase (positional argument)'],
  ['skannr risk', 'Check downstream impact and risk of uncommitted changes'],
  ['skannr risk --diff <path>', 'Analyze a specific diff/patch file'],
  ['skannr risk -n <hops>', 'Set max traversal hops (default: 2)'],
  ['skannr risk --json', 'JSON output for CI pipelines'],
  ['skannr guard', 'Review staged changes against team-defined rules'],
  ['skannr guard --fix', 'Auto-fix fixable violations from current run'],
  ['skannr guard --pr-mode', 'Review full PR diff vs base branch'],
  ['skannr guard --base <ref>', 'Review the diff from a specific base ref'],
  ['skannr guard --no-scanners', 'Skip gitleaks, semgrep and osv-scanner'],
  ['skannr guard install', 'Install git pre-commit hook'],
  ['skannr report', 'Print repository health summary as JSON'],
  ['skannr agent', 'Interactive exploration mode'],
  ['skannr cache stats', 'Show cache hit/miss statistics'],
  ['skannr cache clear', 'Clear all cached analysis results'],
]

const flags = [
  ['--root <path>', 'Project root (default: current directory)'],
  ['-n, --limit <number>', 'Number of top files to return (default: 10)'],
  ['--json', 'Shortcut for --format json'],
  ['--format <fmt>', 'human | markdown | json (default: human)'],
  ['--lang <mode>', 'typescript | javascript | python | auto (default: auto)'],
  ['--modules <keys>', 'Comma-separated module keys (auto-discovered when omitted)'],
  ['--watch', 'Watch the tree and re-run analysis when files change'],
  ['--skip-cache', 'Skip cache and force a full analysis'],
  ['--with-mapping', 'Generate symbol mapping for on-demand retrieval'],
  ['--mcp', 'Run as Model Context Protocol stdio server'],
  ['--telemetry-on / --telemetry-off', 'Toggle anonymous flag-only telemetry'],
]

export default function CliReference() {
  return (
    <section className="py-24 px-5">
      <div className="max-w-5xl mx-auto">
        <Reveal>
          <h2 className="text-3xl md:text-5xl font-bold text-center tracking-tight">Commands & options.</h2>
        </Reveal>

        <Reveal delay={80}>
          <h3 className="mt-12 mb-4 text-xl font-semibold text-white/80">Commands</h3>
          <div className="overflow-hidden rounded-xl border border-border bg-card transition-colors duration-300 hover:border-white/10">
            <table className="w-full text-left">
              <thead className="border-b border-white/5">
                <tr className="text-[#888] text-sm">
                  <th className="px-6 py-4 font-medium">Command</th>
                  <th className="px-6 py-4 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {commands.map(([cmd, description]) => (
                  <tr
                    key={cmd}
                    className="border-b border-white/5 transition-colors duration-200 last:border-b-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-6 py-4 font-mono text-accent">{cmd}</td>
                    <td className="px-6 py-4 text-[#d0d0d0]">{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal delay={160}>
          <h3 className="mt-10 mb-4 text-xl font-semibold text-white/80">Options</h3>
          <div className="overflow-hidden rounded-xl border border-border bg-card transition-colors duration-300 hover:border-white/10">
            <table className="w-full text-left">
              <thead className="border-b border-white/5">
                <tr className="text-[#888] text-sm">
                  <th className="px-6 py-4 font-medium">Flag</th>
                  <th className="px-6 py-4 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {flags.map(([flag, description]) => (
                  <tr
                    key={flag}
                    className="border-b border-white/5 transition-colors duration-200 last:border-b-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-6 py-4 font-mono text-accent">{flag}</td>
                    <td className="px-6 py-4 text-[#d0d0d0]">{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
