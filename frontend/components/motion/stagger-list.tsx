'use client';

import { m, useReducedMotion } from 'framer-motion';
import { Children, type ReactNode } from 'react';
import { DURATION, EASING_BEZIER } from '@/lib/design-tokens';

/**
 * StaggerList — wraps direct children in a stagger sequence. Each child
 * fades in with a small upward translate, offset by `step` ms.
 *
 * Children remain keyboard-tabbable because each wrapper is just a
 * motion.div with no tabIndex or interaction blocking.
 *
 * Reduced-motion: opacity only, single moment (no stagger).
 */
export function StaggerList({
  children,
  delay = 0,
  step = 60,
  className,
}: {
  children: ReactNode;
  delay?: number;
  step?: number;
  className?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const items = Children.toArray(children);
  const fromY = prefersReducedMotion ? 0 : 8;
  const stepSec = prefersReducedMotion ? 0 : step / 1000;
  const baseDelay = delay / 1000;

  return (
    <div className={className}>
      {items.map((child, i) => (
        <m.div
          key={i}
          initial={{ opacity: 0, y: fromY }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: DURATION.moderate / 1000,
            delay: baseDelay + i * stepSec,
            ease: EASING_BEZIER.snappy,
          }}
        >
          {child}
        </m.div>
      ))}
    </div>
  );
}
