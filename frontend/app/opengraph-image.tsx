import { ImageResponse } from 'next/og';

/**
 * Default OG image for the site. Auto-served at /opengraph-image and
 * referenced via Next's metadata pipeline. Pages can override by adding
 * their own opengraph-image.tsx in their route folder.
 *
 * 1200×630 — the canonical OG / Twitter card size that covers Facebook,
 * LinkedIn, Twitter/X, Slack, iMessage preview.
 */

export const runtime = 'edge';
export const alt = 'Maroa — Marketing that knows your industry on day one';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0a0a0b',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 80,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {/* Top: brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <svg width={48} height={48} viewBox="0 0 24 24" fill="none">
            <path
              d="M3 12C3 7 7 3 12 3C17 3 21 7 21 12C21 17 17 21 12 21"
              stroke="white"
              strokeWidth={2}
              strokeLinecap="round"
            />
            <circle cx={12} cy={12} r={4} fill="white" />
          </svg>
          <div style={{ color: 'white', fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em' }}>
            Maroa
          </div>
        </div>

        {/* Middle: headline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              color: '#86868b',
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}
          >
            Marketing for small businesses
          </div>
          <div
            style={{
              color: 'white',
              fontSize: 84,
              fontWeight: 700,
              letterSpacing: '-0.04em',
              lineHeight: 1.05,
              maxWidth: 1000,
            }}
          >
            Never start from a blank page.
          </div>
          <div
            style={{
              color: '#86868b',
              fontSize: 30,
              fontWeight: 400,
              letterSpacing: '-0.01em',
              lineHeight: 1.3,
              maxWidth: 900,
              marginTop: 8,
            }}
          >
            Industry-aware content + ads + compliance from your very first post.
          </div>
        </div>

        {/* Bottom: pill row */}
        <div style={{ display: 'flex', gap: 12 }}>
          {['28 frameworks', '35 channels', '20 compliance rulesets', '50+ industries'].map((p) => (
            <div
              key={p}
              style={{
                color: '#d2d2d7',
                fontSize: 20,
                padding: '10px 20px',
                borderRadius: 999,
                border: '1px solid #424245',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {p}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
