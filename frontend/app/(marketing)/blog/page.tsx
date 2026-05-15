import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Notes on small-business marketing, AI, and the work behind Maroa.',
  alternates: { canonical: '/blog' },
};

// When the blog goes live we'll source these from MDX in /content/blog or
// a CMS. For now it's a static stub so the footer link doesn't 404 and so
// the design lands before content fills in.
const POSTS: Array<{
  slug: string;
  title: string;
  excerpt: string;
  date: string;
  readingTime: string;
}> = [];

export default function BlogPage() {
  return (
    <section className="container pt-20 sm:pt-28 pb-32">
      <div className="max-w-3xl mx-auto text-center mb-16">
        <p className="text-eyebrow uppercase text-ink-400 mb-4">Blog</p>
        <h1 className="text-display-lg text-ink-700">Notes from the work.</h1>
        <p className="mt-6 text-xl text-ink-400 leading-relaxed">
          Small-business marketing, the AI tools we use, and the trade-offs we made building Maroa.
          One essay per month, written by the team, no sponsored content.
        </p>
      </div>

      {POSTS.length === 0 ? (
        <div className="max-w-2xl mx-auto rounded-3xl border border-ink-200/60 bg-white p-12 text-center">
          <h2 className="text-xl font-semibold text-ink-700 mb-3">No posts yet.</h2>
          <p className="text-ink-400 leading-relaxed mb-8">
            We&apos;re focused on shipping the product before we start writing about it. First essays
            land in Summer 2026. Subscribe for one email when they do.
          </p>
          <Button href="mailto:hello@maroa.ai?subject=Notify%20me%20when%20the%20blog%20launches" variant="primary" size="lg">
            Email me when posts go live
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="max-w-3xl mx-auto space-y-12">
          {POSTS.map((post) => (
            <article key={post.slug} className="border-b border-ink-200 pb-12">
              <p className="text-sm text-ink-400 mb-2">
                {post.date} · {post.readingTime}
              </p>
              <Link href={`/blog/${post.slug}`}>
                <h2 className="text-2xl font-semibold text-ink-700 mb-3 hover:text-accent-500 transition-colors">
                  {post.title}
                </h2>
              </Link>
              <p className="text-ink-700 leading-relaxed">{post.excerpt}</p>
              <Link
                href={`/blog/${post.slug}`}
                className="inline-flex items-center gap-1 mt-4 text-accent-500 hover:underline font-medium"
              >
                Read more <ArrowRight className="h-3 w-3" />
              </Link>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
