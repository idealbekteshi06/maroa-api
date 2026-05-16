import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@/components/theme/theme-provider';
import '@fontsource-variable/inter';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://maroa.ai';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Maroa — AI marketing OS for freelancers, agencies & SMBs',
    template: '%s · Maroa',
  },
  description:
    'The AI marketing operating system. Maroa runs content, ads, CRO, SEO, and reporting across every client — for freelancers managing 5–20 clients, agencies running 50, or any business that needs a marketing team without hiring one.',
  applicationName: 'Maroa',
  keywords: [
    // Vertical buyer intent
    'AI marketing software for agencies',
    'AI marketing assistant for freelancers',
    'AI marketing operating system',
    'marketing automation for multi-client teams',
    'white-label marketing dashboard',
    // Capability intent
    'AI ad creative automation',
    'AI SEO and citation tracking',
    'AI social media approval workflow',
    'AI marketing reasoning trace',
    'Higgsfield AI video marketing workflow',
    // Long-tail buyer
    'agency marketing tool with client approvals',
    'small business marketing automation',
    'compliance gates FDA FTC for marketing',
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
    title: 'Maroa — AI marketing OS for freelancers, agencies & SMBs',
    description:
      'Run content, ads, CRO, SEO, and reporting across every client. Daily decisions, full reasoning trace, compliance built in.',
    url: SITE_URL,
    locale: 'en_US',
    // OG image generated dynamically by app/opengraph-image.tsx.
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Maroa — AI marketing OS for freelancers, agencies & SMBs',
    description: 'The AI marketing operating system. Daily decisions, full reasoning trace.',
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

// Inline script that runs BEFORE paint to apply the saved theme class.
// Prevents the white-flash on dark-mode page loads. Kept tiny + IIFE.
const NO_FLASH_THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('maroa.theme');var d=s==='dark'||(s!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}else{document.documentElement.style.colorScheme='light';}}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-white dark:bg-ink-950" suppressHydrationWarning>
      <head>
        {/* Theme bootstrap — runs synchronously before any render. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }} />
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
      <body className="min-h-screen antialiased bg-white dark:bg-ink-950 text-ink-700 dark:text-ink-100 transition-colors">
        {/* Skip-to-content link for keyboard + screen-reader users.
            Hidden until focused, then pops to top-left with a focus ring. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-full focus:bg-ink-700 dark:focus:bg-white focus:text-white dark:focus:text-ink-900 focus:shadow-lifted focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2"
        >
          Skip to content
        </a>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
