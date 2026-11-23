import { useEffect, useMemo, useState } from 'react'
import { useTypewriter } from '../hooks/useTypewriter'

function renderLine(line, showCursor) {
  const baseClass = line.trim().startsWith('↳') ? 'text-accent' : 'text-[#e8e8e8]'

  const parts = line.split('{ ... }')

  return (
    <span className={baseClass}>
      {parts.map((part, idx) => (
        <span key={`${part}-${idx}`}>
          {part}
          {idx < parts.length - 1 && <span className="text-[#777]">{'{ ... }'}</span>}
        </span>
      ))}
      {showCursor && <span className="animate-pulse text-white">|</span>}
    </span>
  )
}

export default function Hero() {
  const [start, setStart] = useState(false)

  // Real output of: skannr "retry link options" --modules packages/client --limit 3
  // run on trpc/trpc at 8405090, trimmed (second ranked file, first 18 lines of its skeleton).
  const lines = useMemo(
    () => [
      '$ skannr "retry link options" --modules packages/client --limit 3',
      '',
      '  ...',
      '  packages/client/src/links/retryLink.ts  [0.617]',
      '    ↳ keyword match: retry, link, options · module name matches query',
      '',
      '    /* Skeleton of retryLink.ts */',
      '',
      '    // packages/client/src/links/retryLink.ts:10-19',
      '    interface RetryLinkOptions<TInferrable extends InferrableClientTypes> {',
      '      /**',
      '       * The retry function',
      '       */',
      '      retry: (opts: RetryFnOptions<TInferrable>) => boolean;',
      '      /**',
      '       * The delay between retries in ms (defaults to 0)',
      '       */',
      '      retryDelayMs?: (attempt: number) => number;',
      '    }',
    ],
    []
  )

  useEffect(() => {
    const t = setTimeout(() => setStart(true), 800)
    return () => clearTimeout(t)
  }, [])

  const { displayed, done } = useTypewriter(start ? lines : [], 30, 400)

  return (
    <section
      className="relative px-5 pt-32 pb-24 min-h-screen flex flex-col items-center justify-center"
      style={{
        backgroundImage: 'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)',
        backgroundSize: '32px 32px',
      }}
    >
      <div
        className="inline-flex items-center gap-2 border border-white/10 rounded-full px-4 py-1 text-sm text-gray-400 mb-8 opacity-0 motion-safe:animate-fade-in-up motion-reduce:opacity-100 motion-reduce:translate-y-0 [animation-delay:0ms]"
      >
        <span className="w-2 h-2 rounded-full bg-green motion-safe:animate-pulse" />
        CLI + MCP · Watch mode · Open source
      </div>

      <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-center leading-tight opacity-0 motion-safe:animate-fade-in-up motion-reduce:opacity-100 motion-reduce:translate-y-0 [animation-delay:80ms]">
        Any repo. Any question.
        <br />
        <span className="text-accent">Without reading every file.</span>
      </h1>

      <p className="mt-6 max-w-xl text-center text-lg text-[#888] opacity-0 motion-safe:animate-fade-in-up motion-reduce:opacity-100 motion-reduce:translate-y-0 [animation-delay:180ms]">
        Skannr gives AI assistants a ranked, compressed view of a codebase, and reviews your changes
        before you push. Everyday commands run on your machine with no network connection.
      </p>

      <div className="flex flex-col sm:flex-row gap-4 mt-10 opacity-0 motion-safe:animate-fade-in-up motion-reduce:opacity-100 motion-reduce:translate-y-0 [animation-delay:280ms]">
        <a
          href="#install"
          className="bg-accent text-black font-semibold px-6 py-3 rounded-lg shadow-[0_0_24px_-4px_rgba(0,212,255,0.5)] transition-all duration-300 hover:opacity-95 hover:shadow-[0_0_32px_-2px_rgba(0,212,255,0.65)] hover:-translate-y-0.5 active:translate-y-0"
        >
          Get started
        </a>
        <a
          href="https://github.com/7vignesh/skannr"
          className="border border-white/20 px-6 py-3 rounded-lg transition-all duration-300 hover:border-accent/60 hover:text-accent hover:-translate-y-0.5 active:translate-y-0"
        >
          View on GitHub
        </a>
      </div>

      <div className="w-full max-w-3xl mx-auto mt-16 rounded-xl border border-border bg-card overflow-hidden opacity-0 shadow-[0_0_40px_-16px_rgba(0,212,255,0.12)] motion-safe:animate-scale-in motion-safe:[animation-delay:420ms] motion-reduce:opacity-100 motion-reduce:translate-y-0 transition-[box-shadow,border-color] duration-500 hover:border-accent/25 hover:shadow-[0_0_48px_-12px_rgba(0,212,255,0.2)]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-xs font-mono text-[#888]">bash</span>
        </div>
        <pre className="p-5 overflow-x-auto font-mono text-sm leading-7">
          {lines.map((_, idx) => {
            const current = displayed[idx] ?? ''
            const showCursor = !done && idx === displayed.length - 1
            return (
              <div key={`line-${idx}`} className="min-h-6">
                {renderLine(current, showCursor)}
              </div>
            )
          })}
        </pre>
      </div>
      <p className="mt-4 text-xs text-[#666]">
        Real output on trpc/trpc, trimmed.
      </p>
    </section>
  )
}
