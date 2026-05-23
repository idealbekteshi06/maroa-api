import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FeatureProof } from '@/components/marketing/feature-proof';

export const metadata: Metadata = {
  title: 'Features — every layer of an expert marketing team',
  description:
    'Industry awareness, channel-native formatting, compliance gates, brand-voice persistence, daily ad audits, reasoning traces, and client approvals.',
  alternates: { canonical: '/features' },
};

const SECTIONS = [
  {
    eyebrow: 'Reasoning trace',
    proof: 'reasoning-trace' as const,
    title: 'No black box. We show our work.',
    body:
      'Every output ships with the reasoning Maroa followed — framework, awareness stage, hook type, the past performance signal it leaned on, voice fit score, and the compliance gates it passed. Override any choice and re-run.',
    bullets: [
      'See exactly why we wrote each line',
      'Override any choice and re-run',
      'Audit log for regulated industries',
    ],
  },
  {
    eyebrow: 'Compliance by design',
    proof: 'compliance-refusal' as const,
    title: 'Hard-blocks what regulators forbid.',
    body:
      'Not warnings. Not "consider rephrasing." Maroa refuses to ship copy that violates FDA, FTC, FCA, SEC, ABA, or platform policy — and rewrites it into compliant copy automatically. Twenty industries covered with citation.',
    bullets: [
      'Healthcare, dental, supplements, weight-loss, cosmetics',
      'Financial advisory, mortgages, insurance, accountancy',
      'Alcohol, cannabis, tobacco, prescription pharma',
      'Legal, real estate, firearms, gambling, crypto',
    ],
  },
  {
    eyebrow: 'Ads on autopilot',
    proof: 'ad-audit-decision' as const,
    title: 'Daily audits. Pacing alerts. Real decisions.',
    body:
      'Every campaign gets audited each morning. Pacing alerts fire every 4 hours when spend or ROAS swings outside thresholds. Maroa proposes pause / scale / A-B test moves with expected upside, risk, and cost — one tap to apply.',
    bullets: [
      'Meta + Google + TikTok ads in one dashboard',
      'Learning-phase respect (no premature optimization)',
      'Anti-thrashing protection (no daily flip-flops)',
      'Weekly scorecard delivered Sunday night',
    ],
  },
  {
    eyebrow: 'Client approvals',
    proof: 'client-approval' as const,
    title: 'Magic-link approvals — no client login.',
    body:
      'Your clients approve from their phone. No account, no password, no app. The link expires, the approval is auditable, and you get a Slack ping when they tap green.',
    bullets: [
      'Email + SMS delivery',
      'Single-use, expiring tokens',
      'White-label sender + branding',
      'Full audit trail for retainer disputes',
    ],
  },
  {
    eyebrow: 'Auto-safe banding',
    proof: 'auto-safe-band' as const,
    title: 'Green ships. Yellow notifies. Red waits.',
    body:
      'Every decision is classified by risk before anything moves. Low-stakes, in-policy creative refresh? Green auto-publishes. Brand-sensitive copy or new audience? You tap to approve. Regulated, above-threshold, or first-time? Hard stop until human sign-off.',
    bullets: [
      'Risk-banded by industry + spend + audience novelty',
      'Configurable thresholds per workspace',
      'Yellow + red always require an action',
    ],
  },
  {
    eyebrow: 'Channel-native',
    proof: 'channel-format' as const,
    title: 'Reels are not LinkedIn. Email is not SMS.',
    body:
      '35 channel format modules with hook patterns, anti-patterns, retention rhythms, and locale-specific rules. The same idea ships as six different posts — each native to its surface.',
    bullets: [
      'Instagram, TikTok, LinkedIn, X, Threads, Facebook, YouTube',
      'Email cold/nurture/promo/retention sequences',
      'Meta + Google + TikTok ads (search, display, PMax)',
      'Long-form: landing pages, sales pages, SEO blogs',
    ],
  },
  {
    eyebrow: 'Brand voice',
    proof: 'voice-signature' as const,
    title: 'Stays in character across every channel.',
    body:
      'Your voice signature is measured and enforced. Formality, energy, humor, technicality, sentence rhythm, pronoun preference — all scored on every draft. If the model drifts, Maroa rewrites until it matches.',
    bullets: [
      'Voice signature vector with 10+ measurable attributes',
      'Auto-detect from your existing content (5 minutes)',
      'Override per channel if a brand needs different LinkedIn vs Instagram voice',
    ],
  },
  {
    eyebrow: 'Cultural calendar',
    proof: 'cultural-calendar' as const,
    title: 'Knows when not to post.',
    body:
      'Auto-pause around Yom Kippur in Israel, 9/11 in the US, election day in your country. Ramadan-aware in MENA. Knows Christmas in Italy isn’t Christmas in Japan. Eighty events across all major markets.',
    bullets: [
      'Region-specific tone shifts (somber events get respectful tone)',
      'Industry-specific pauses (alcohol pauses during Ramadan in MENA)',
      'Auto-pause before sensitive dates, auto-resume after',
    ],
  },
  {
    eyebrow: 'Global',
    proof: 'multi-locale' as const,
    title: 'Native fluency in 18 languages.',
    body:
      'Not translation. Native. An Albanian café gets Albanian content with local references — Rruga e Durrësit, byrek, zonja Drita. Italian retail doesn’t feel like Google-Translated English.',
    bullets: [
      'EN, ES, FR, DE, IT, PT, NL, SE, NO, DK, FI, PL, TR, AR, JA, KO, ZH, SQ',
      'Local CTAs (German verb-position, French formal/informal, etc.)',
      'Regional cultural awareness',
    ],
  },
];

export default function FeaturesPage() {
  return (
    <>
      <section className="container pt-20 sm:pt-28">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-eyebrow uppercase text-ink-400 mb-4">Features</p>
          <h1 className="text-display-lg text-ink-700 dark:text-ink-50">
            Every layer of an expert marketing team.
          </h1>
          <p className="mt-6 text-xl text-ink-400 max-w-2xl mx-auto leading-relaxed">
            Not &ldquo;AI marketing.&rdquo; A marketing operating system that codifies what every
            specialist knows — and applies all of it to every piece of content, for every client.
          </p>
        </div>
      </section>

      <section className="container mt-24 space-y-32">
        {SECTIONS.map((section, idx) => {
          const isReverse = idx % 2 === 1;
          return (
            <div
              key={section.title}
              className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center"
            >
              <div className={isReverse ? 'lg:order-2' : ''}>
                <p className="text-eyebrow uppercase text-ink-400 mb-3">{section.eyebrow}</p>
                <h2 className="text-display-md text-ink-700 dark:text-ink-50 mb-6">
                  {section.title}
                </h2>
                <p className="text-lg text-ink-400 leading-relaxed mb-6">{section.body}</p>
                <ul className="space-y-2">
                  {section.bullets.map((bullet) => (
                    <li
                      key={bullet}
                      className="flex items-start gap-3 text-ink-700 dark:text-ink-200"
                    >
                      <span className="mt-2.5 h-1 w-1 rounded-full bg-ink-400 flex-shrink-0" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={isReverse ? 'lg:order-1' : ''}>
                <div className="relative">
                  <div
                    className="absolute -inset-4 rounded-xl bg-gradient-to-br from-accent-100/40 to-transparent dark:from-accent-500/10 dark:to-transparent blur-xl"
                    aria-hidden="true"
                  />
                  <div className="relative">
                    <FeatureProof kind={section.proof} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="container mt-32">
        <div className="rounded-xl bg-ink-700 dark:bg-ink-800 text-white px-8 py-16 sm:px-16 sm:py-24 text-center">
          <h2 className="text-display-md text-white">See it work for your business.</h2>
          <p className="mt-6 text-xl text-ink-100/80 max-w-2xl mx-auto leading-relaxed">
            From $25/month. Monthly billing in USD. Cancel anytime.
          </p>
          <Button href="/signup" variant="accent" size="xl" className="mt-10">
            Get started
            <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      </section>
    </>
  );
}
