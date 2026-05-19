/** @type {import('next').NextConfig} */

// Build the Content-Security-Policy header value.
// 'unsafe-inline' on script-src is required by Next.js for its inline
// runtime bootstrap script; switching to nonces would mean rewriting layout
// inline scripts and the theme-bootstrap snippet. 'unsafe-inline' on
// style-src is required for Tailwind's runtime-injected style tags. Both
// are accepted compromises for the Next.js + Tailwind stack — frame-ancestors
// 'none' still blocks click-jacking, and the connect-src allowlist still
// blocks ex-filtration to attacker hosts.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maroa-api-production.up.railway.app https://va.vercel-scripts.com https://vitals.vercel-insights.com",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // Audit 2026-05-19 F22: surface lint errors in builds instead of silently
  // shipping them. CI's `npm run lint` is the primary gate; this is belt
  // and suspenders.
  eslint: {
    ignoreDuringBuilds: false,
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      { protocol: 'https', hostname: 'maroa.ai' },
      { protocol: 'https', hostname: 'cdn.maroa.ai' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
          // Audit 2026-05-19 F21: previously missing.
          { key: 'Content-Security-Policy', value: CSP_DIRECTIVES },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/home', destination: '/', permanent: true },
    ];
  },
};

module.exports = nextConfig;
