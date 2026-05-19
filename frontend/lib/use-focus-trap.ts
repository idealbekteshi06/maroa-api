'use client';

import { useEffect, useRef } from 'react';

/**
 * lib/use-focus-trap.ts
 * ---------------------------------------------------------------------------
 * Dependency-free focus trap for modal-style overlays.
 *
 * Audit 2026-05-19 F14: the mobile-nav drawer had role="dialog" +
 * aria-modal="true" + ESC handler but no focus management. Tab let the
 * keyboard escape to the dimmed background content — a WCAG 2.1.2
 * (no-keyboard-trap-inverse: must trap focus inside the active dialog)
 * violation and a screen-reader confusion vector.
 *
 * What this hook does on `active`:
 *   1. Remembers the currently-focused element (the trigger).
 *   2. Moves focus to the first focusable element inside `ref`.
 *   3. On Tab / Shift+Tab, wraps focus within the container.
 *   4. On deactivation, restores focus to the trigger.
 *
 * It does NOT handle ESC — that's the consumer's job (already implemented
 * in mobile-nav.tsx). Pairing one hook per concern keeps wiring obvious.
 * ---------------------------------------------------------------------------
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const containerRef = useRef<T | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // Remember the trigger so we can restore focus on close.
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;

    // Move focus into the container. Prefer the first focusable element;
    // fall back to focusing the container itself so the dialog announces.
    const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE);
    if (firstFocusable) {
      firstFocusable.focus();
    } else if (container.tabIndex < 0) {
      container.tabIndex = -1;
      container.focus();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => !n.hasAttribute('disabled') && n.tabIndex !== -1,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to the trigger so keyboard users land back where
      // they came from instead of at the top of the page.
      const prior = previouslyFocused.current;
      if (prior && typeof prior.focus === 'function') {
        prior.focus();
      }
    };
  }, [active]);

  return containerRef;
}
