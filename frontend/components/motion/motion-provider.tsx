'use client';

import { LazyMotion, domAnimation } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * MotionProvider — wraps any subtree that uses the lightweight `m`
 * component from framer-motion. Loads only the DOM animation feature
 * set (transforms, opacity, layout) — strict subset of the full
 * `motion` payload. Saves ~15-20kB compared to importing `motion`
 * directly throughout the app.
 *
 * Place at the root of any client tree that uses motion primitives.
 * Cheap to wrap: zero render impact, no DOM nodes added.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={domAnimation} strict>{children}</LazyMotion>;
}
