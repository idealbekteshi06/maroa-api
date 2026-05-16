'use client';

import { m, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { DURATION, EASING_BEZIER, type DurationKey } from '@/lib/design-tokens';

/**
 * FadeIn — opacity 0→1 with a small upward translate, snappy easing.
 * Wraps children in a motion.div. Use for cards/sections appearing on
 * first mount.
 *
 * Reduced-motion: opacity only, no transform.
 */
export function FadeIn({
  children,
  delay = 0,
  duration = 'moderate',
  className,
}: {
  children: ReactNode;
  delay?: number;
  duration?: Extract<DurationKey, 'quick' | 'moderate'>;
  className?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const ms = DURATION[duration];
  const fromY = prefersReducedMotion ? 0 : 8;

  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y: fromY }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ms / 1000,
        delay: delay / 1000,
        ease: EASING_BEZIER.snappy,
      }}
    >
      {children}
    </m.div>
  );
}
