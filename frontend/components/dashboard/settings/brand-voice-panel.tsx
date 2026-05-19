import { Sparkles, MessageSquareQuote } from 'lucide-react';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/empty-state';
import type { BrandVoice } from '@/lib/api/business';

/**
 * components/dashboard/settings/brand-voice-panel.tsx
 * ---------------------------------------------------------------------------
 * Read-only view of the brand-voice anchor today. The "Edit" affordance
 * is deliberately absent in v1 — Maroa refines the voice automatically
 * from VOC + performance signals. Manual override comes in v2 once we
 * have a confident UX for "I'm overriding the model, not just adding
 * noise."
 * ---------------------------------------------------------------------------
 */

function Section({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty: string;
}) {
  return (
    <section className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle p-6">
      <h2 className="text-eyebrow uppercase text-ink-500 dark:text-ink-300 mb-3">{title}</h2>
      {children || (
        <p className="text-sm text-ink-500 dark:text-ink-300">{empty}</p>
      )}
    </section>
  );
}

function Pill({ text, tone }: { text: string; tone: 'use' | 'avoid' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-sm font-medium m-0.5',
        tone === 'use'
          ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300'
          : 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300',
      )}
    >
      {text}
    </span>
  );
}

export function BrandVoicePanel({ voice }: { voice: BrandVoice | null }) {
  if (!voice) {
    return (
      <EmptyState
        icon={Sparkles}
        title="No brand voice tuned yet."
        description="Once Maroa has shipped a few pieces and seen which ones land, your brand-voice anchor will fill in here."
      />
    );
  }

  return (
    <div className="space-y-5">
      <Section title="Tone" empty="Not tuned yet">
        {voice.tone ? (
          <p className="text-2xl text-ink-700 dark:text-ink-50 font-semibold tracking-tight">
            {voice.tone}
          </p>
        ) : null}
        {voice.derived_from ? (
          <p className="mt-3 text-xs text-ink-500 dark:text-ink-300">
            Derived from: {voice.derived_from}
          </p>
        ) : null}
        {typeof voice.confidence === 'number' ? (
          <p className="mt-1 text-xs text-ink-500 dark:text-ink-300">
            Confidence: {voice.confidence}%
          </p>
        ) : null}
      </Section>

      <Section title="Words to use" empty="None tuned yet.">
        {voice.do_use && voice.do_use.length > 0 ? (
          <div className="flex flex-wrap -m-0.5">
            {voice.do_use.map((w) => (
              <Pill key={w} text={w} tone="use" />
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="Words to avoid" empty="None tuned yet.">
        {voice.do_not_use && voice.do_not_use.length > 0 ? (
          <div className="flex flex-wrap -m-0.5">
            {voice.do_not_use.map((w) => (
              <Pill key={w} text={w} tone="avoid" />
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="Phrases your customers use" empty="No VOC harvested yet.">
        {voice.customer_phrases && voice.customer_phrases.length > 0 ? (
          <ol className="space-y-2">
            {voice.customer_phrases.map((p, i) => (
              <li
                key={`${i}-${p}`}
                className="flex items-start gap-2 text-sm text-ink-700 dark:text-ink-100"
              >
                <MessageSquareQuote
                  className="h-4 w-4 text-ink-400 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span className="leading-relaxed">“{p}”</span>
              </li>
            ))}
          </ol>
        ) : null}
      </Section>
    </div>
  );
}
