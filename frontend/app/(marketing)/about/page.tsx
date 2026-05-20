import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'About — the AI marketing OS',
  description:
    'Maroa is the marketing operating system for freelancers, agencies, and businesses that want a marketing team without hiring one.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="container-prose">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">About</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50 mb-8">
          A marketing team you don&apos;t have to hire.
        </h1>

        <div className="prose prose-lg max-w-none text-ink-700 dark:text-ink-100 leading-relaxed space-y-6">
          <p className="text-xl text-ink-400">
            For most businesses, marketing means one of two bad options: hire someone you can&apos;t
            really afford, or buy AI tools you have to babysit. Freelancers and agencies have the
            same problem at scale — every new client multiplies the work, not the margin.
          </p>

          <p>
            Maroa is the third option. A marketing operating system that <em>does</em> the work — content
            strategy, ad creative, daily audits, CRO, AI-search visibility, reporting — and surfaces
            every decision before it spends money. You stay in control. The work just happens.
          </p>

          <p>
            We built Maroa for four audiences with one engine: solo business owners on autopilot,
            freelancers managing 5–20 clients, agencies running 50, and enterprise teams that need
            brand governance + audit logs. Same daily decisions, different surfaces.
          </p>

          <h2 className="text-display-md text-ink-700 dark:text-ink-50 mt-16 mb-6">What we believe</h2>

          <h3 className="text-xl font-semibold text-ink-700 dark:text-ink-50 mt-10 mb-3">
            Customer money is the only signal that matters.
          </h3>
          <p>
            We don&apos;t talk about &ldquo;awards.&rdquo; We don&apos;t talk about &ldquo;cutting edge.&rdquo;
            We talk about whether the ad you ran this week made more money than the one you ran last week.
            Maroa is built to make that loop tighter and faster — for one business or fifty.
          </p>

          <h3 className="text-xl font-semibold text-ink-700 dark:text-ink-50 mt-10 mb-3">
            Compliance is a feature, not a footnote.
          </h3>
          <p>
            Healthcare brands shouldn&apos;t accidentally claim cures. Financial advisors shouldn&apos;t
            accidentally guarantee returns. Maroa enforces 20 industry rulesets as hard refusals, not
            warnings — because a $50,000 FTC fine is a worse day than a rewrite. Agencies running clients
            in regulated industries lean on this every day.
          </p>

          <h3 className="text-xl font-semibold text-ink-700 dark:text-ink-50 mt-10 mb-3">
            Local matters.
          </h3>
          <p>
            We treat 18 languages as first-class. We treat 49 regional markets as first-class. A Tirana
            café gets Albanian copy that reads like Tirana — not Google-Translated English with the word
            &ldquo;cozy&rdquo; in it. An agency serving clients in Mexico, Poland, and Japan gets each one
            native, not translated.
          </p>

          <h3 className="text-xl font-semibold text-ink-700 dark:text-ink-50 mt-10 mb-3">
            No black boxes.
          </h3>
          <p>
            Every piece of content Maroa produces comes with a reasoning trace. Which framework. Which
            audience stage. Which corpus examples influenced it. Which compliance gates it passed. You can
            override any choice and re-run. Your clients can see it too, when you want them to.
            We owe you that transparency.
          </p>

          <h2 className="text-display-md text-ink-700 dark:text-ink-50 mt-16 mb-6">Why I built this</h2>

          <div className="not-prose grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-6 sm:gap-8 items-start mt-6 mb-10">
            {/* Photo placeholder — swap in /public/founder.jpg when ready. */}
            <div className="aspect-square w-full max-w-[180px] rounded-2xl bg-gradient-to-br from-ink-100 to-ink-200 dark:from-ink-800 dark:to-ink-900 border border-ink-200/60 dark:border-ink-700/60 flex items-center justify-center overflow-hidden">
              <span className="text-3xl font-semibold text-ink-400 dark:text-ink-500" aria-hidden="true">
                IB
              </span>
            </div>
            <div className="space-y-3 text-ink-700 dark:text-ink-100 leading-relaxed">
              <p>
                I&apos;m Ideal Bekteshi. I&apos;ve spent the last decade watching small businesses pay agencies
                $3,000 a month for what amounts to a content calendar and a few boosted posts — work
                that gets quietly delegated to a junior coordinator with a Canva login. The owners
                couldn&apos;t tell whether it was working, and most of the time, it wasn&apos;t.
              </p>
              <p>
                Maroa is what I wish those owners had: a marketing team that explains itself, costs a
                rounding error of an agency retainer, refuses to push compliance-risky claims, and gets
                better the more it learns about your specific business. No dashboards full of vanity
                metrics. No 40-slide quarterly reviews. Just decisions, shipped, with reasoning you can
                read.
              </p>
              <p>
                If you&apos;re running a café in Tirana, a dental clinic in Boston, or a 30-client agency
                in Manila — I&apos;d love to hear from you. I read every email at{' '}
                <a href="mailto:ideal@maroa.ai" className="text-accent-500 hover:underline">
                  ideal@maroa.ai
                </a>
                .
              </p>
            </div>
          </div>

          <h2 className="text-display-md text-ink-700 dark:text-ink-50 mt-16 mb-6">Where we are</h2>
          <p>
            Maroa is built by a small, focused team in Tirana, learning fast from early customers across
            the US, EU, and MENA. If you run a business, freelance, or run an agency and want to talk to
            the people building this, email us at{' '}
            <a href="mailto:hello@maroa.ai" className="text-accent-500 hover:underline">
              hello@maroa.ai
            </a>
            .
          </p>
        </div>

        <div className="mt-16 pt-16 border-t border-ink-200 dark:border-ink-800">
          <Button href="/signup" variant="primary" size="lg">
            Get started
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}
