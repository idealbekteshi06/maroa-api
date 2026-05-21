/**
 * design-tokens.ts — single source of truth for design-system constants.
 *
 * These values are referenced by both code (motion primitives, framer
 * configs) and Tailwind (borderRadius, etc.). Keep this file in sync
 * with tailwind.config.ts when the radius/spacing scales change.
 *
 * Inspiration: Linear's design language — restraint, density, and motion
 * that teaches rather than decorates.
 */

// ─── Easing curves ────────────────────────────────────────────────────────
// Linear-flavored cubic beziers. Available as CSS strings (for inline
// styles + Tailwind arbitrary values) and as 4-tuple arrays (for
// framer-motion's `ease` prop, which doesn't parse CSS strings).
export const EASING = {
  // ease-out-expo — most UI motion. Snappy in, gentle out.
  snappy: 'cubic-bezier(0.16, 1, 0.3, 1)',
  // ease-in-out — symmetrical, neutral. Default for state changes.
  soft: 'cubic-bezier(0.4, 0, 0.2, 1)',
  // Overshoot — use sparingly. Reserved for success/confirmation moments.
  bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

export const EASING_BEZIER = {
  snappy: [0.16, 1, 0.3, 1],
  soft: [0.4, 0, 0.2, 1],
  bounce: [0.34, 1.56, 0.64, 1],
} as const;

// ─── Duration buckets ─────────────────────────────────────────────────────
// Three named buckets keep motion consistent. Don't introduce ad-hoc
// values — pick the closest bucket.
export const DURATION = {
  instant: 100,    // hover state changes, tooltips
  quick: 180,      // open/close, fade, small UI transitions
  moderate: 320,   // page entries, list staggers, card swaps
  cinematic: 600,  // hero loop beats — never for UI feedback
} as const;

// ─── Radius scale ─────────────────────────────────────────────────────────
// Tighter than the previous scale. Mirror these in tailwind.config.ts.
export const RADIUS = {
  sm: '6px',   // chips, badges, tiny pills
  md: '10px',  // inputs, buttons
  lg: '14px',  // cards
  xl: '20px',  // hero panels, modals
} as const;

// ─── Borders ──────────────────────────────────────────────────────────────
// Linear's secret: borders carry weight, shadows are reserved for lift.
export const BORDER = {
  hairline: '1px solid var(--ink-200)',
  hairlineStrong: '1px solid var(--ink-300)',
} as const;

// ─── State dots ───────────────────────────────────────────────────────────
// Single source of truth for status colors. Every dot, badge, and ring
// indicator should reference these by name.
export const STATE_DOTS = {
  green: '#34C759',  // success / safe / approved
  amber: '#FF9500',  // warning / yellow band
  red: '#FF3B30',    // refusal / red band / rejected
  blue: '#3D4DE8',   // info / running (Maroa brand cobalt — matches accent-500)
  gray: '#86868b',   // muted / dead
} as const;

// ─── Types ────────────────────────────────────────────────────────────────
export type EasingKey = keyof typeof EASING;
export type DurationKey = keyof typeof DURATION;
export type RadiusKey = keyof typeof RADIUS;
export type StateDotKey = keyof typeof STATE_DOTS;
