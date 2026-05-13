import type { Metadata } from 'next';
import { ArrowRight, Sparkles, Shield, Zap, BarChart3, Globe2, Brain, Calendar, Layers, FileCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Features — every layer of an expert marketing team',
  description:
    'Industry awareness, channel-native formatting, compliance gates, brand-voice persistence, daily ad audits, and full reasoning traces.',
  alternates: { canonical: '/features' },
};

const SECTIONS = [
  {
    eyebrow: 'Industry intelligence',
    icon: Sparkles,
    title: 'Knows your industry before you write a word.',
    body:
      'Maroa is pre-trained on award-winning campaigns and proven patterns across 50+ verticals. The first post for your dental clinic doesn’t read like a generic AI-blog template — it reads like a dental clinic that knows what to say.',
    bullets: [
      '29 codified copywriting frameworks (Schwartz, Ogilvy, Sugarman, Hormozi, more)',
      '50+ industry verticals with peer fallback',
      '49 regional markets with cultural calendar awareness',
    ],
  },
  {
    eyebrow: 'Channel-native',
    icon: Zap,
    title: 'Reels are not LinkedIn. Email is not SMS.',
    body:
      '35 channel format modules with hook patterns, anti-patterns, retention rhythms, and locale-specific rules. The same idea ships as 6 different posts — each native to its surface.',
    bullets: [
      'Instagram, TikTok, LinkedIn, X, Threads, Facebook, YouTube',
      'Email cold/nurture/promo/retention sequences',
      'Meta ads, Google ads, TikTok ads (search + display + PMax)',
      'Long-form: landing pages, sales pages, blog SEO',
    ],
  },
  {
    eyebrow: 'Compliance by design',
    icon: Shield,
    title: 'Hard-blocks what regulators forbid.',
    body:
      'Not warnings. Not "consider rephrasing." Maroa REFUSES to ship copy that violates FDA, FTC, FCA, SEC, ABA, or platform policy. Twenty industries covered with citation.',
    bullets: [
      'Healthcare, dental, supplements, weight-loss, cosmetics',
      'Financial advisory, mortgages, insurance, accountancy',
      'Alcohol, cannabis, tobacco, prescription pharma',
      'Legal, real estate, firearms, gambling, crypto',
    ],
  },
  {
    eyebrow: 'Brand voice',
    icon: Brain,
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
    eyebrow: 'Ads on autopilot',
    icon: BarChart3,
    title: 'Daily audits. Pacing alerts. One-click apply.',
    body:
      'Every campaign gets audited each morning. Pacing alerts fire every 4 hours when spend or ROAS swings outside thresholds. Maroa proposes pause / scale / A-B test moves you approve with one tap.',
    bullets: [
      'Meta + Google + TikTok ads in one dashboard',
      'Learning-phase respect (no premature optimization)',
      'Anti-thrashing protection (no daily flip-flops)',
      'Weekly scorecard delivered Sunday night',
    ],
  },
  {
    eyebrow: 'Voice of Customer',
    icon: Layers,
    title: 'Mines what your customers actually say.',
    body:
      'Google reviews, Yelp, support emails, social comments. Maroa extracts verbatim phrases real customers use — never invents quotes — and feeds them into your content so it sounds like your customer base, not a chatbot.',
    bullets: [
      'Refuses to invent testimonials (hard rule)',
      'Multi-source: Google + Yelp + Trustpilot + manual paste',
      'Competitor mention tracking',
    ],
  },
  {
    eyebrow: 'Cultural calendar',
    icon: Calendar,
    title: 'Knows when not to post.',
    body:
      'Auto-pause around Yom Kippur in Israel, 9/11 in the US, election day in your country. Ramadan-aware in MENA. Knows Christmas in Italy isn’t Christmas in Japan. Eighty events across all major markets.',
    bullets: [
      'Region-specific tone shifts (somber events get respectful tone)',
      'Industry-specific pauses (alcohol marketing pauses during Ramadan in MENA)',
      'Auto-pause before sensitive dates, auto-resume after',
    ],
  },
  {
    eyebrow: 'Reasoning trace',
    icon: FileCheck,
    title: 'No black box. We show our work.',
    body:
      'Every output ships with a reasoning trace: which framework, which awareness stage, which corpus examples influenced it, which compliance gates it passed, voice fit score, manipulation-risk score.',
    bullets: [
      'See exactly why we wrote each line',
      'Override any choice and re-run',
      'Audit log for regulated industries',
    ],
  },
  {
    eyebrow: 'Global',
    icon: Globe2,
    title: 'Native fluency in 18 languages.',
    body:
      'Not translation. Native. Albanian café gets Albanian content with local references — Rruga e Durrësit, byrek, zonja Drita. Italian retail doesn’t feel like Google-Translated English.',
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
          <h1 className="text-display-lg text-ink-700">
            Every layer of an expert marketing team.
          </h1>
          <p className="mt-6 text-xl text-ink-400 max-w-2xl mx-auto leading-relaxed">
            Not "AI marketing." A marketing system that codifies what every specialist knows — and applies all of it to every piece of content.
          </p>
        </div>
      </section>

      <section className="container mt-24 space-y-32">
        {SECTIONS.map((section, idx) => {
          const isReverse = idx % 2 === 1;
          return (
            <div
              key={section.title}
              className={`grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center ${isReverse ? '' : ''}`}
            >
              <div className={`${isReverse ? 'lg:order-2' : ''}`}>
                <p className="text-eyebrow uppercase text-ink-400 mb-3">{section.eyebrow}</p>
                <h2 className="text-display-md text-ink-700 mb-6">{section.title}</h2>
                <p className="text-lg text-ink-400 leading-relaxed mb-6">{section.body}</p>
                <ul className="space-y-2">
                  {section.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-start gap-3 text-ink-700">
                      <span className="mt-2.5 h-1 w-1 rounded-full bg-ink-400 flex-shrink-0" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className={`${isReverse ? 'lg:order-1' : ''}`}>
                <div className="aspect-square rounded-3xl bg-gradient-to-br from-ink-100 to-ink-50 border border-ink-200/60 flex items-center justify-center">
                  <section.icon className="h-20 w-20 text-ink-300" aria-hidden="true" strokeWidth={1.5} />
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="container mt-32">
        <div className="rounded-3xl bg-ink-700 text-white px-8 py-16 sm:px-16 sm:py-24 text-center">
          <h2 className="text-display-md text-white">See it work for your business.</h2>
          <p className="mt-6 text-xl text-ink-100/80 max-w-2xl mx-auto leading-relaxed">
            Seven days free. No credit card. Cancel anytime.
          </p>
          <Button href="/signup" variant="accent" size="xl" className="mt-10">
            Start free
            <ArrowRight className="h-5 w-5" />
          </Button>
        </div>
      </section>
    </>
  );
}
