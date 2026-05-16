/**
 * AgentsWorking — thin "agents currently working" bridge band that sits
 * between the hero's single big mock and the feature grid. 12 named
 * agents drawn from CLAUDE.md §5, each rendered as a rounded-full pill
 * with a small pulsing accent dot.
 *
 * Pure server component — no client JS needed. The dot pulse is the
 * existing .agent-pulse CSS animation; each pill gets a different
 * `animationDelay` so the pulses don't blink in sync.
 *
 * On mobile (< sm) the row becomes a horizontal scroll-snap strip so
 * the band stays one line tall. Scrollbar hidden via inline style.
 */

const AGENTS = [
  'Content',
  'Ad Optimizer',
  'CRO',
  'AI-SEO',
  'Compliance',
  'Competitor Watch',
  'Pacing',
  'Voice Polish',
  'Email Lifecycle',
  'Decision Narrator',
  'Brand Voice',
  'Cold-Start',
] as const;

export function AgentsWorking() {
  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-eyebrow uppercase text-ink-400 text-center mb-4">
        Working right now
      </p>
      <div
        className="flex gap-2 overflow-x-auto sm:flex-wrap sm:justify-center sm:overflow-visible snap-x snap-mandatory pb-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
      >
        {AGENTS.map((name, i) => (
          <span
            key={name}
            className="snap-start inline-flex items-center gap-2 rounded-full border border-ink-200/60 dark:border-ink-700/60 bg-white/60 dark:bg-ink-900/40 backdrop-blur-sm px-3 py-1.5 text-xs text-ink-700 dark:text-ink-100 whitespace-nowrap flex-shrink-0"
          >
            <span
              aria-hidden="true"
              className="agent-pulse h-1.5 w-1.5 rounded-full bg-green-500"
              style={{ animationDelay: `${(i * 167) % 2000}ms` }}
            />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}
