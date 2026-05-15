'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

/**
 * Theme provider — Apple-style white/black with three modes:
 *
 *   system  (default) — follows prefers-color-scheme
 *   light             — forced light
 *   dark              — forced dark
 *
 * Persists the user's choice to localStorage so subsequent visits skip
 * the system-pref check. Pairs with the inline blocking script in
 * app/layout.tsx that sets the `dark` class before paint — that's what
 * prevents the white-flash on dark mode load.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

type ThemeContextValue = {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  resolved: 'light' | 'dark';
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'maroa.theme';

function detectSystem(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // localStorage might be unavailable in some embed contexts
  }
  return 'system';
}

function applyClass(resolved: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (resolved === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  // Update color-scheme for native form controls + scrollbars
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  // Read stored mode + resolve on mount
  useEffect(() => {
    const m = readStoredMode();
    setModeState(m);
    const r = m === 'system' ? detectSystem() : m;
    setResolved(r);
    applyClass(r);
  }, []);

  // Listen for system changes when in system mode
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const r = mq.matches ? 'dark' : 'light';
      setResolved(r);
      applyClass(r);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // ignore
    }
    const r = m === 'system' ? detectSystem() : m;
    setResolved(r);
    applyClass(r);
  }, []);

  return <ThemeContext.Provider value={{ mode, setMode, resolved }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme must be used inside ThemeProvider');
  return v;
}
