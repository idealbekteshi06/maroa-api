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
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Maroa — Marketing that knows your industry on day one',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Maroa — Marketing that knows your industry on day one',
    description: 'AI marketing for small businesses.',
    images: ['/og-image.png'],
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
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
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
              logo: `${SITE_URL}/logo.png`,
              sameAs: [
                'https://twitter.com/maroa',
                'https://www.linkedin.com/company/maroa',
              ],
            }),
          }}
        />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
