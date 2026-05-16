import type { Config } from 'tailwindcss';

const config: Config = {
  // Class-based dark mode — set on <html> by our ThemeProvider. Lets us
  // do both system-preference and manual toggle with no flash on load.
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: '1rem',
        sm: '1.5rem',
        lg: '2rem',
      },
      screens: {
        '2xl': '1280px',
      },
    },
    extend: {
      colors: {
        // Apple-inspired palette: monochrome base + restrained accent
        ink: {
          50: '#fafafa',
          100: '#f5f5f7', // Apple's signature off-white
          200: '#e8e8ed',
          300: '#d2d2d7', // Apple separator gray
          400: '#86868b', // Apple muted text
          500: '#6e6e73',
          600: '#424245',
          700: '#1d1d1f', // Apple primary text
          800: '#161617',
          900: '#0a0a0b',
        },
        // Maroa brand: deep indigo-violet. Replaces the generic Apple
        // "Buy" blue with a distinctive hue every Maroa surface keys off.
        // Picked between Tailwind indigo-500 (#6366F1, too pale) and
        // indigo-700 (#4338CA, too dark) — #5145E5 reads as confident
        // and intelligent without veering into purple novelty.
        accent: {
          50: '#EEF0FF',
          100: '#DDE1FF',
          200: '#BFC5FE',
          300: '#9499F8',
          400: '#6E73F0',
          500: '#5145E5', // BRAND — every primary action, every link, every focus ring
          600: '#4938CA',
          700: '#3A2EA3',
          800: '#2D2480',
          900: '#1B1450',
        },
      },
      fontFamily: {
        // Inter Variable leads; system stack is the fallback while the
        // variable file loads. -apple-system keeps SF on macOS/iOS users
        // if the font request fails entirely.
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system', 'BlinkMacSystemFont',
          'SF Pro Display', 'SF Pro Text',
          'Helvetica Neue', 'Arial', 'sans-serif',
        ],
        mono: ['SF Mono', 'Menlo', 'Monaco', 'monospace'],
      },
      fontSize: {
        // Display scale — softened from the original -0.04em tracking that
        // was too tight on mobile. Inter Variable handles the negative
        // tracking better than SF and stays readable at viewport widths.
        'display-xl': ['clamp(2.75rem, 5.5vw, 5rem)', { lineHeight: '1.05', letterSpacing: '-0.025em', fontWeight: '700' }],
        'display-lg': ['clamp(2.25rem, 4.5vw, 3.75rem)', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '600' }],
        'display-md': ['clamp(1.875rem, 3.75vw, 2.75rem)', { lineHeight: '1.15', letterSpacing: '-0.015em', fontWeight: '600' }],
        'eyebrow': ['0.875rem', { lineHeight: '1.4', letterSpacing: '0.02em', fontWeight: '500' }],
      },
      borderRadius: {
        // Mirrors RADIUS in lib/design-tokens.ts. Keep in sync.
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '20px',
      },
      boxShadow: {
        // Soft, Apple-style elevation — never harsh
        'subtle': '0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.03)',
        'card': '0 4px 16px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'lifted': '0 12px 40px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)',
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fadeIn 0.4s ease-out',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
