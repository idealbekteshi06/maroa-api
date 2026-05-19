import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getBlogPost, getBlogPosts } from '../posts';

/**
 * app/(marketing)/blog/[slug]/page.tsx
 * ---------------------------------------------------------------------------
 * Single blog post route. Audit 2026-05-19 F4 scaffolding.
 *
 * Today this looks up a `BlogPost` by slug from the typed list and renders
 * the title + excerpt. When real posts ship, swap the body for MDX/Mdx
 * rendering — but the routing, metadata, and sitemap discovery are already
 * here so adding content is just appending to posts.ts + writing a body.
 *
 * Renders 404 for unknown slugs.
 * ---------------------------------------------------------------------------
 */

export async function generateStaticParams() {
  return getBlogPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) return { title: 'Post not found' };
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: `/blog/${slug}` },
    openGraph: {
      title: post.title,
      description: post.excerpt,
      type: 'article',
      publishedTime: post.date,
      authors: post.author ? [post.author] : undefined,
    },
    twitter: { card: 'summary_large_image', title: post.title, description: post.excerpt },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) notFound();

  return (
    <article className="container max-w-3xl pt-20 sm:pt-28 pb-32">
      <Link
        href="/blog"
        className="inline-flex items-center gap-2 text-ink-500 dark:text-ink-300 hover:text-ink-700 dark:hover:text-ink-100 mb-10"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All posts
      </Link>

      <header className="mb-10 space-y-4">
        <p className="text-eyebrow uppercase text-ink-500 dark:text-ink-300">
          {new Date(post.date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
          {' · '}
          {post.readingTime}
        </p>
        <h1 className="text-display-md text-ink-700 dark:text-ink-50 text-balance">
          {post.title}
        </h1>
        <p className="text-xl text-ink-700 dark:text-ink-200 leading-relaxed">{post.excerpt}</p>
      </header>

      {/* Body — placeholder until MDX rendering lands. The slot exists so
          authors can drop body content via a content collection without
          touching this file. */}
      <section className="prose-like text-ink-700 dark:text-ink-200 leading-relaxed space-y-5">
        <p>
          This essay is being prepared. The structure is in place so the
          permalink, OG card, and sitemap entry are all valid the moment
          the body is filled in.
        </p>
      </section>
    </article>
  );
}
