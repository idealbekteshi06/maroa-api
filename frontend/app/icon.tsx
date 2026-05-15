import { ImageResponse } from 'next/og';

/**
 * Dynamic favicon. Next auto-injects this as <link rel="icon"> + as the
 * /favicon.ico fallback so the original public/favicon.ico isn't needed.
 *
 * Visual: black ink-700 background with the white circle-arc logo mark.
 */

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#1d1d1f',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
        }}
      >
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M3 12C3 7 7 3 12 3C17 3 21 7 21 12C21 17 17 21 12 21"
            stroke="white"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <circle cx={12} cy={12} r={4} fill="white" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
