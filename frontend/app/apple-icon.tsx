import { ImageResponse } from 'next/og';

/**
 * Apple touch icon — 180×180. Used when a user adds Maroa to their iOS
 * home screen. Larger margins than the favicon so it looks correct in the
 * iOS rounded-rectangle frame.
 */

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
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
        }}
      >
        <svg width={100} height={100} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M3 12C3 7 7 3 12 3C17 3 21 7 21 12C21 17 17 21 12 21"
            stroke="white"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx={12} cy={12} r={4} fill="white" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
