/**
 * War Room loading skeleton — matches the 3-band layout exactly so the
 * page never flashes blank during a server data fetch. Pure CSS shimmer
 * (see .skeleton-shimmer in globals.css). Reduced-motion users get the
 * placeholder rectangles without the sweep — handled at the CSS layer.
 *
 * Wired through app/(dashboard)/dashboard/loading.tsx for Next App
 * Router automatic loading-state rendering.
 */
export function WarRoomSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      {/* Header */}
      <header className="mb-6">
        <div className="skeleton-shimmer h-3 w-40 rounded-md" />
        <div className="skeleton-shimmer h-8 w-56 rounded-md mt-2" />
        <div className="skeleton-shimmer h-3 w-96 max-w-full rounded-md mt-3" />
      </header>

      {/* Band A — Needs you */}
      <section className="mt-2">
        <div className="skeleton-shimmer h-7 w-48 rounded-full" />
        <div className="mt-4 grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
          <div className="space-y-3">
            <SkeletonPriority />
            <SkeletonPriority />
            <SkeletonPriority />
          </div>
          <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-4 space-y-3">
            <div className="skeleton-shimmer h-3 w-32 rounded-md" />
            <div className="skeleton-shimmer h-14 w-full rounded-lg" />
            <div className="skeleton-shimmer h-14 w-full rounded-lg" />
          </div>
        </div>
      </section>

      {/* Band B — Working */}
      <section className="mt-10">
        <div className="skeleton-shimmer h-7 w-44 rounded-full" />
        <div className="mt-4 grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonKpi key={i} />
            ))}
          </div>
          <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-4 space-y-3">
            <div className="skeleton-shimmer h-3 w-28 rounded-md" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="skeleton-shimmer h-2 w-24 rounded-md" />
                <div className="skeleton-shimmer h-3 w-full rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Band C — Resting */}
      <section className="mt-10 rounded-2xl bg-ink-50/40 dark:bg-ink-950/40 border border-ink-200/40 dark:border-ink-800/60 p-6">
        <div className="skeleton-shimmer h-7 w-40 rounded-full" />
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <SkeletonClient />
          <SkeletonClient />
          <SkeletonClient />
          <SkeletonClient />
        </div>
        <div className="mt-6 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
          <div className="skeleton-shimmer h-16 rounded-xl" />
          <div className="skeleton-shimmer h-12 w-56 rounded-xl" />
        </div>
      </section>
    </div>
  );
}

function SkeletonPriority() {
  return (
    <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 border-l-4 border-l-transparent p-5">
      <div className="flex items-start gap-4">
        <div className="skeleton-shimmer h-10 w-10 rounded-xl flex-shrink-0" />
        <div className="flex-1 space-y-2 min-w-0">
          <div className="skeleton-shimmer h-3 w-48 rounded-md" />
          <div className="skeleton-shimmer h-4 w-full rounded-md" />
          <div className="skeleton-shimmer h-4 w-3/4 rounded-md" />
          <div className="flex gap-2 pt-2">
            <div className="skeleton-shimmer h-7 w-20 rounded-full" />
            <div className="skeleton-shimmer h-7 w-24 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SkeletonKpi() {
  return (
    <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="skeleton-shimmer h-3 w-20 rounded-md" />
        <div className="skeleton-shimmer h-4 w-4 rounded" />
      </div>
      <div className="skeleton-shimmer h-7 w-12 rounded-md" />
      <div className="skeleton-shimmer h-7 w-full rounded-md" />
      <div className="skeleton-shimmer h-2.5 w-24 rounded-md" />
    </div>
  );
}

function SkeletonClient() {
  return (
    <div className="rounded-xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-700/60 p-5 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-1.5">
          <div className="skeleton-shimmer h-4 w-32 rounded-md" />
          <div className="skeleton-shimmer h-3 w-20 rounded-md" />
        </div>
        <div className="skeleton-shimmer h-4 w-4 rounded" />
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between">
          <div className="skeleton-shimmer h-3 w-24 rounded-md" />
          <div className="skeleton-shimmer h-3 w-16 rounded-md" />
        </div>
        <div className="skeleton-shimmer h-1.5 w-full rounded-full" />
      </div>
      <div className="flex gap-2">
        <div className="skeleton-shimmer h-5 w-20 rounded-full" />
        <div className="skeleton-shimmer h-5 w-16 rounded-full" />
      </div>
    </div>
  );
}
