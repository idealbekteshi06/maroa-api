/**
 * app/(marketing)/blog/posts.ts
 * ---------------------------------------------------------------------------
 * Source-of-truth for blog posts. Audit 2026-05-19 F4 scaffold.
 *
 * Add a post by appending an entry below and creating a sibling file
 * `app/(marketing)/blog/[slug]/page.tsx` (or moving to MDX when content
 * volume grows past a few posts).
 *
 * Both the listing page and `app/sitemap.ts` import from this file so the
 * sitemap discovers new posts without any extra wiring.
 * ---------------------------------------------------------------------------
 */

export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  date: string; // ISO date — YYYY-MM-DD
  readingTime: string; // e.g., '6 min read'
  author?: string;
  ogImageAlt?: string;
}

export const BLOG_POSTS: BlogPost[] = [
  // Placeholder structure — populate as essays publish. The page renders an
  // empty-state CTA when this is [].
  // {
  //   slug: 'reasoning-trace-explained',
  //   title: 'Reasoning trace: why every AI marketing output should show its work',
  //   excerpt:
  //     'When AI ships a campaign decision, "trust me" is not enough. Here\'s how Maroa makes every decision auditable in 30 seconds.',
  //   date: '2026-06-15',
  //   readingTime: '6 min read',
  //   author: 'Maroa team',
  // },
];

export function getBlogPosts(): BlogPost[] {
  return [...BLOG_POSTS].sort((a, b) => b.date.localeCompare(a.date));
}

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
