import { ImageResponse } from 'next/og';

/**
 * Page-specific OG card for /pricing. Audit 2026-05-19 F16: the generic
 * site-wide OG was shown on every share — pricing-specific copy boosts CTR on social.
 *
 * Reuses the brand palette (ink-700 background, accent indigo pop).
 * 1200×630 — canonical OG / Twitter card size.
 */

export const runtime = 'edge';
export const alt = 'Maroa pricing — $25 Starter, $59 Growth, $99 Agency';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OgImagePricing() {
  return new ImageResponse(
    (
      <div
        style={{
          background: 'linear-gradient(135deg, #0a0a0b 0%, #1d1d1f 100%)',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 80,
          fontFamily: 'system-ui, sans-serif',
          color: '#fff',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 999,
              background: '#5145E5',
              display: 'flex',
            }}
          />
          <div style={{ fontSize: 28, fontWeight: 600 }}>Maroa</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
          <div style={{ fontSize: 28, letterSpacing: 1.5, color: '#9499F8' }}>PRICING</div>
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              lineHeight: 1.05,
              maxWidth: 980,
            }}
          >
            Three plans. Starter · Growth · Agency.
          </div>
          <div style={{ display: 'flex', gap: 32, marginTop: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 20, color: '#86868b' }}>Starter</div>
              <div style={{ fontSize: 48, fontWeight: 700 }}>$25/mo</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 20, color: '#86868b' }}>Growth</div>
              <div style={{ fontSize: 48, fontWeight: 700 }}>$59/mo</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 20, color: '#86868b' }}>Agency</div>
              <div style={{ fontSize: 48, fontWeight: 700 }}>$99/mo</div>
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 22,
            color: '#86868b',
          }}
        >
          <div>Monthly billing · USD · cancel anytime</div>
          <div>maroa.ai/pricing</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
