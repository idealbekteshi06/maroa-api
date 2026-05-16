'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { DURATION, EASING_BEZIER } from '@/lib/design-tokens';

/**
 * PageTransition — wraps a route's main content in a motion.main with a
 * gentle fade-in on mount. Intentionally NOT a route-change orchestrator;
 * RSC + App Router makes that fragile. This is just first-paint polish.
 *
 * Reduced-motion: skipped entirely — children render at full opacity
 * from the start.
 */
export function PageTransition({
  children,
  className,
  id = 'main',
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return (
      <main id={id} className={className}>
        {children}
      </main>
    );
  }

  return (
    <motion.main
      id={id}
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        duration: DURATION.quick / 1000,
        ease: EASING_BEZIER.soft,
      }}
    >
      {children}
    </motion.main>
  );
}
