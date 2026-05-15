import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://maroa.ai';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Maroa — Marketing that knows your industry on day one',
    template: '%s · Maroa',
  },
  description:
    'AI marketing for small businesses. Write, schedule, and run ads that match your industry from your very first post — no blank-page guesswork.',
  applicationName: 'Maroa',
  keywords: [
    'AI marketing',
    'small business marketing',
    'social media automation',
    'ad copywriting',
    'content scheduling',
    'Meta ads',
    'Google ads',
  ],
  authors: [{ name: 'Maroa' }],
  creator: 'Maroa',
  publisher: 'Maroa',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  openGraph: {
    type: 'website',
    siteName: 'Maroa',
    title: 'Maroa — Marketing that knows your industry on day one',
    description:
      'AI marketing for small businesses. Write, schedule, and run ads that match your industry from your very first post.',
    url: SITE_URL,
    locale: 'en_US',
    // OG image generated dynamically by app/opengraph-image.tsx —
    // Next auto-injects the og:image meta tags.
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Maroa — Marketing that knows your industry on day one',
    description: 'AI marketing for small businesses.',
    // Twitter image also picked up from app/opengraph-image.tsx.
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  // Icons generated dynamically by app/icon.tsx + app/apple-icon.tsx.
  // Next auto-injects the <link rel="icon"> + <link rel="apple-touch-icon">.
  manifest: '/manifest.json',
  alternates: {
    canonical: SITE_URL,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0b' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-white">
      <head>
        {/* JSON-LD Organization schema — SEO */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: 'Maroa',
              url: SITE_URL,
              // Use the dynamically-generated apple-icon (180×180) as the
              // schema.org logo — Google Knowledge Panel friendly size.
              logo: `${SITE_URL}/apple-icon`,
              sameAs: [
                'https://twitter.com/maroa',
                'https://www.linkedin.com/company/maroa',
              ],
            }),
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        {/* Skip-to-content link for keyboard + screen-reader users.
            Hidden until focused, then pops to top-left with a focus ring. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-full focus:bg-ink-700 focus:text-white focus:shadow-lifted focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
