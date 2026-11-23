import Navbar from './components/Navbar'
import Hero from './components/Hero'
import Problem from './components/Problem'
import TokenSavings from './components/TokenSavings'
import HowItWorks from './components/HowItWorks'
import Features from './components/Features'
import LanguageSupport from './components/LanguageSupport'
import Install from './components/Install'
import Privacy from './components/Privacy'
import CliReference from './components/CliReference'
import WorksWith from './components/WorksWith'
import AgentMode from './components/AgentMode'
import Footer from './components/Footer'

export default function App() {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-bg text-white font-sans">
      <div
        className="pointer-events-none fixed inset-0 -z-10"
        aria-hidden
      >
        <div
          className="absolute -left-[20%] top-[10%] h-[520px] w-[520px] rounded-full bg-accent/[0.07] blur-[120px] motion-safe:animate-drift"
        />
        <div
          className="absolute -right-[15%] top-[40%] h-[420px] w-[420px] rounded-full bg-purple/[0.08] blur-[100px] motion-safe:animate-drift motion-safe:[animation-delay:-7s] motion-safe:[animation-duration:28s]"
        />
        <div
          className="absolute bottom-0 left-1/3 h-[380px] w-[380px] rounded-full bg-green/[0.05] blur-[90px] motion-safe:animate-drift motion-safe:[animation-delay:-12s] motion-safe:[animation-duration:26s]"
        />
      </div>
      <Navbar />
      <Hero />
      <Problem />
      <TokenSavings />
      <HowItWorks />
      <Features />
      <LanguageSupport />
      <Install />
      <CliReference />
      <WorksWith />
      <AgentMode />
      <Privacy />
      <Footer />
    </div>
  )
}
