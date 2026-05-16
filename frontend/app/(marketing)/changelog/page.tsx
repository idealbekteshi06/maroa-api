import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'What we shipped, week by week.',
  alternates: { canonical: '/changelog' },
};

type Entry = {
  date: string;
  title: string;
  tag: 'shipped' | 'fixed' | 'improved';
  body: string[];
};

const ENTRIES: Entry[] = [
  {
    date: '2026-05-16',
    title: 'Frontend foundation hardened',
    tag: 'shipped',
    body: [
      'Auth callback cookie persistence (sessions now survive page refresh).',
      'Middleware-level auth gate on dashboard routes.',
      'Legal pages: Privacy, Terms, DPA, Subprocessors, Contact.',
      'Mobile dashboard nav, branded 404 + error + loading screens, skip-to-content for a11y.',
    ],
  },
  {
    date: '2026-05-14',
    title: 'Marketing Graph + Decision Logs',
    tag: 'shipped',
    body: [
      'Migration 065 — typed graph of every marketing entity.',
      'Universal decision log for every agent action.',
      'War Room Feed API for per-workspace dashboard.',
      'Visual Production Compiler — Higgsfield JobSpec engine.',
      'Workspaces + multi-tenant foundation (migration 066).',
    ],
  },
  {
    date: '2026-05-13',
    title: 'Security + dependency audit',
    tag: 'fixed',
    body: [
      'Closed IDOR on 22 /api/* routes (added Bearer JWT + ownership check).',
      'Migrated 3 remaining Anthropic calls through the cost-tracked gateway.',
      'Dependency vulnerabilities: 1 high + 16 moderate → 0.',
      'env.js zod v4 path fix.',
    ],
  },
  {
    date: '2026-05-12',
    title: 'Wave 60 master pipeline',
    tag: 'shipped',
    body: [
      'Agency-grade content pipeline: stage router → specialist → methodology → channel → compliance.',
      '29 codified methodology modules across 6 categories.',
      '35 channel-native format modules.',
      '20 industry compliance rulesets (FDA / FTC / FCA / ABA / fair housing / etc).',
      '7 specialist mode dispatchers.',
    ],
  },
];

const TAG_STYLES: Record<Entry['tag'], string> = {
  shipped: 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-300',
  fixed: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  improved: 'bg-accent-50 text-accent-700 dark:bg-accent-500/10 dark:text-accent-300',
};

export default function ChangelogPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="container-prose">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Changelog</p>
        <h1 className="text-display-lg text-ink-700 dark:text-ink-50 mb-3">What&apos;s new</h1>
        <p className="text-ink-400 mb-16">Recent improvements to Maroa. Newest first.</p>

        <div className="space-y-16">
          {ENTRIES.map((e) => (
            <article
              key={`${e.date}-${e.title}`}
              className="border-l-2 border-ink-200 dark:border-ink-800 pl-8"
            >
              <div className="flex items-center gap-3 mb-3">
                <time className="text-sm font-mono text-ink-400">{e.date}</time>
                <span
                  className={`text-xs font-medium px-2.5 py-1 rounded-full uppercase tracking-wider ${TAG_STYLES[e.tag]}`}
                >
                  {e.tag}
                </span>
              </div>
              <h2 className="text-2xl font-semibold text-ink-700 dark:text-ink-50 mb-4">
                {e.title}
              </h2>
              <ul className="space-y-2 text-ink-700 dark:text-ink-200">
                {e.body.map((line) => (
                  <li key={line} className="flex items-start gap-3 leading-relaxed">
                    <span className="mt-2.5 h-1 w-1 rounded-full bg-ink-400 flex-shrink-0" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <p className="mt-20 text-sm text-ink-400">
          Want to be notified of new releases? Subscribe via the RSS feed (coming soon) or follow us on{' '}
          <a href="https://twitter.com/maroa" className="text-accent-500 hover:underline">Twitter</a>.
        </p>
      </div>
    </section>
  );
}
