'use client';

import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';
import { DURATION, EASING_BEZIER, STATE_DOTS } from '@/lib/design-tokens';

/**
 * OptimisticCheck — green check that scales in with an overshoot when
 * `show` flips true. Used to confirm an action landed (approve, save,
 * etc.) without waiting for a server round-trip.
 *
 * Reduced-motion: same end-state, no scale animation — just opacity.
 */
export function OptimisticCheck({
  show,
  label,
  className,
}: {
  show: boolean;
  label?: string;
  className?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const initialScale = prefersReducedMotion ? 1 : 0;

  return (
    <AnimatePresence initial={false}>
      {show && (
        <m.span
          role="status"
          aria-label={label ?? 'Action confirmed'}
          className={
            'inline-flex items-center justify-center gap-1.5 ' + (className ?? '')
          }
          initial={{ opacity: 0, scale: initialScale }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.85 }}
          transition={{
            duration: DURATION.moderate / 1000,
            ease: prefersReducedMotion ? EASING_BEZIER.soft : EASING_BEZIER.bounce,
          }}
        >
          <Check
            className="h-3.5 w-3.5"
            style={{ color: STATE_DOTS.green }}
            strokeWidth={2.5}
          />
          {label ? <span>{label}</span> : null}
        </m.span>
      )}
    </AnimatePresence>
  );
}
