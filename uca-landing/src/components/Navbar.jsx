import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { useScrollNav } from '../hooks/useScrollNav'

const links = [
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Features', href: '#features' },
  { label: 'Install', href: '#install' },
  { label: 'Works with', href: '#works-with' },
  { label: 'Privacy', href: '#privacy' },
]

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const scrolled = useScrollNav(60)

  return (
    <nav
      className={`fixed top-0 z-50 w-full transition-all duration-300 ${
        scrolled ? 'backdrop-blur-md bg-black/60 border-b border-white/5' : ''
      }`}
    >
      <div className="mx-auto max-w-6xl px-5 py-4">
        <div className="flex items-center justify-between">
          <a
            href="#"
            className="inline-flex items-center gap-2 transition-transform duration-300 hover:scale-[1.03] motion-reduce:hover:scale-100"
          >
            <span className="font-mono text-lg font-bold text-accent">skannr</span>
            <span className="h-2 w-2 rounded-full bg-green motion-safe:animate-pulse" />
          </a>

          <div className="hidden md:flex items-center gap-7">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="group relative py-1 text-sm text-[#888] transition-colors hover:text-white"
              >
                {link.label}
                <span className="absolute bottom-0 left-0 h-[2px] w-0 bg-accent transition-all duration-300 ease-out group-hover:w-full" />
              </a>
            ))}
            <a
              href="https://github.com/7vignesh/code-analyzer"
              className="border border-white/20 text-sm px-4 py-1.5 rounded-lg transition-all duration-300 hover:border-accent hover:text-accent hover:shadow-[0_0_20px_-6px_rgba(0,212,255,0.45)] hover:-translate-y-px"
            >
              GitHub
            </a>
          </div>

          <button
            className="md:hidden text-white/80 hover:text-accent transition-colors"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        {open && (
          <div className="mt-4 md:hidden rounded-xl border border-border bg-card p-4">
            <div className="flex flex-col gap-3">
              {links.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="text-sm text-[#888] hover:text-white transition-colors"
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                </a>
              ))}
              <a
                href="https://github.com/7vignesh/code-analyzer"
                className="mt-1 w-fit border border-white/20 text-sm px-4 py-1.5 rounded-lg hover:border-accent hover:text-accent transition-all"
                onClick={() => setOpen(false)}
              >
                GitHub
              </a>
            </div>
          </div>
        )}
      </div>
    </nav>
  )
}
