/**
 * Root loading.tsx — shown during the streaming wait of any route segment
 * that hasn't finished prerendering or that's fetching server data.
 *
 * Kept deliberately minimal — a centered subtle progress indicator. No
 * skeleton flash, no full-screen takeover. Respects prefers-reduced-motion
 * via CSS (`@media (prefers-reduced-motion)` in globals.css).
 */

export default function Loading() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none bg-white/50 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      <div className="flex items-center gap-3">
        <span className="h-2 w-2 rounded-full bg-ink-700 motion-safe:animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="h-2 w-2 rounded-full bg-ink-700 motion-safe:animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="h-2 w-2 rounded-full bg-ink-700 motion-safe:animate-bounce" style={{ animationDelay: '300ms' }} />
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}
