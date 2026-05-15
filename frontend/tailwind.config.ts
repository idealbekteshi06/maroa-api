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
        accent: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#b8d6ff',
          300: '#8bb9ff',
          400: '#5e95ff',
          500: '#0071e3', // Apple "Buy" blue
          600: '#0058b8',
          700: '#004491',
          800: '#003066',
          900: '#001f47',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system', 'BlinkMacSystemFont',
          'SF Pro Display', 'SF Pro Text',
          'Inter', 'Helvetica Neue', 'Arial', 'sans-serif',
        ],
        mono: ['SF Mono', 'Menlo', 'Monaco', 'monospace'],
      },
      fontSize: {
        // Apple-style scale — generous, restrained
        'display-xl': ['clamp(3rem, 6vw, 5.5rem)', { lineHeight: '1.05', letterSpacing: '-0.04em', fontWeight: '700' }],
        'display-lg': ['clamp(2.5rem, 5vw, 4rem)', { lineHeight: '1.1', letterSpacing: '-0.03em', fontWeight: '600' }],
        'display-md': ['clamp(2rem, 4vw, 3rem)', { lineHeight: '1.15', letterSpacing: '-0.025em', fontWeight: '600' }],
        'eyebrow': ['0.875rem', { lineHeight: '1.4', letterSpacing: '0.02em', fontWeight: '500' }],
      },
      borderRadius: {
        xl: '14px',
        '2xl': '20px',
        '3xl': '28px',
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
