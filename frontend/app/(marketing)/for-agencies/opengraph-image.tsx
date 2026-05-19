import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Maroa for Agencies — multi-client workspaces and white-label reports';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OgImageAgencies() {
  return new ImageResponse(
    (
      <div
        style={{
          background: 'linear-gradient(140deg, #0a0a0b 0%, #3A2EA3 100%)',
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
          <div style={{ width: 36, height: 36, borderRadius: 999, background: '#5145E5' }} />
          <div style={{ fontSize: 28, fontWeight: 600 }}>Maroa</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ fontSize: 28, letterSpacing: 1.5, color: '#BFC5FE' }}>FOR AGENCIES</div>
          <div style={{ fontSize: 78, fontWeight: 700, lineHeight: 1.05, maxWidth: 1000 }}>
            Scale to fifty clients without hiring fifty marketers.
          </div>
          <div style={{ fontSize: 28, color: '#BFC5FE', lineHeight: 1.4, maxWidth: 900 }}>
            Multi-client workspaces · roles · white-label reports · magic-link approvals.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 22,
            color: '#9499F8',
          }}
        >
          <div>$599/month flat · cancel anytime</div>
          <div>maroa.ai/for-agencies</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
