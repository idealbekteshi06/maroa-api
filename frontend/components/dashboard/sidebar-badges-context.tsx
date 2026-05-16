'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Sidebar badge state — lives at the dashboard-layout level so the sidebar
 * (in the layout) can render counts published by the page (war-room-shell).
 * Pure client-side, no fetching; pages call `useDashboardBadgesSetter()` and
 * push numbers in. The sidebar reads via `useDashboardBadges()`.
 *
 * `settings` is intentionally `string | number` so we can render `!` for
 * a sync-failure flag without inventing a separate type.
 */
export type DashboardBadges = {
  approvals: number;
  clients: number;
  settings: number | string;
};

const DEFAULT_BADGES: DashboardBadges = { approvals: 0, clients: 0, settings: 0 };

const BadgesValueContext = createContext<DashboardBadges>(DEFAULT_BADGES);
const BadgesSetterContext = createContext<(b: Partial<DashboardBadges>) => void>(() => {});

export function DashboardBadgesProvider({ children }: { children: ReactNode }) {
  const [badges, setBadges] = useState<DashboardBadges>(DEFAULT_BADGES);
  const publish = useCallback((next: Partial<DashboardBadges>) => {
    setBadges((prev) => ({ ...prev, ...next }));
  }, []);
  const value = useMemo(() => badges, [badges]);
  return (
    <BadgesValueContext.Provider value={value}>
      <BadgesSetterContext.Provider value={publish}>{children}</BadgesSetterContext.Provider>
    </BadgesValueContext.Provider>
  );
}

export function useDashboardBadges(): DashboardBadges {
  return useContext(BadgesValueContext);
}

export function useDashboardBadgesSetter() {
  return useContext(BadgesSetterContext);
}
