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
        // Maroa brand cobalt — matches the live homepage. Brighter and
        // more saturated than indigo, leans true-blue instead of purple.
        // 500 is the conversion blue (CTAs, "Automated by AI" headline
        // fill, primary buttons); 600 is the press/hover state.
        accent: {
          50: '#EEF1FF',
          100: '#DDE3FF',
          200: '#BAC4FF',
          300: '#8E9CFF',
          400: '#6573F2',
          500: '#3D4DE8', // BRAND — primary CTAs, link colour, focus ring
          600: '#2F3FD1',
          700: '#2632A8',
          800: '#1E2782',
          900: '#141B5C',
        },
      },
      fontFamily: {
        // DM Sans Variable leads — matches the live maroa.ai homepage and
        // carries Maroa's brand voice (rounded geometric, friendly bold
        // weights for display sizes). Inter Variable kept as a fallback
        // for dashboard surfaces that already key off it, then the system
        // stack while the variable file loads.
        sans: [
          'DM Sans Variable',
          'DM Sans',
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
