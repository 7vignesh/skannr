import { Lock } from 'lucide-react'
import Reveal from './Reveal'

const rows = [
  {
    when: 'Asking a question, risk, report, cache, init',
    sent: 'Nothing. These make no network connection.',
  },
  {
    when: 'skannr guard',
    sent: 'The changed code, to the provider you pick: your claude, gemini or kiro session, a local ollama, or the Gemini or OpenAI API with your own key.',
  },
  {
    when: 'Guard scanners (optional)',
    sent: 'osv-scanner sends package names and versions to osv.dev. semgrep downloads its rules from semgrep.dev on first use. Neither sends your source.',
  },
  {
    when: 'Telemetry',
    sent: 'Which flags you used, an anonymous id, skannr and Node versions, your OS. Never code, questions, or paths. It switches on by itself 7 days after the first-run banner; run skannr --telemetry-off to stop it.',
  },
]

export default function Privacy() {
  return (
    <section id="privacy" className="py-24 px-5">
      <div className="max-w-5xl mx-auto">
        <Reveal>
          <div className="flex justify-center">
            <Lock size={28} className="text-accent" aria-hidden />
          </div>
          <h2 className="mt-4 text-3xl md:text-5xl font-bold text-center tracking-tight">
            What leaves your machine.
          </h2>
          <p className="mt-4 text-center text-[#888] max-w-2xl mx-auto">
            skannr runs locally. This is the complete list of what it can send, and when.
          </p>
        </Reveal>

        <Reveal delay={80}>
          <div className="mt-10 overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full text-left">
              <thead className="border-b border-white/5">
                <tr className="text-[#888] text-sm">
                  <th className="px-6 py-4 font-medium">When</th>
                  <th className="px-6 py-4 font-medium">What is sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ when, sent }) => (
                  <tr key={when} className="border-b border-white/5 last:border-b-0 align-top">
                    <td className="px-6 py-4 font-mono text-sm text-accent whitespace-nowrap">{when}</td>
                    <td className="px-6 py-4 text-[#d0d0d0]">{sent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal delay={160}>
          <p className="mt-6 text-center text-sm text-[#888]">
            Open source under the MIT license.{' '}
            <a
              href="https://github.com/7vignesh/skannr#privacy"
              className="text-accent hover:underline"
            >
              Details in the README
            </a>
            .
          </p>
        </Reveal>
      </div>
    </section>
  )
}
