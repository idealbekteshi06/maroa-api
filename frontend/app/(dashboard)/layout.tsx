import { Sidebar } from '@/components/dashboard/sidebar';
import { MobileNav } from '@/components/dashboard/mobile-nav';
import { DashboardBadgesProvider } from '@/components/dashboard/sidebar-badges-context';
import { CommandPaletteProvider } from '@/components/dashboard/command-palette';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardBadgesProvider>
      <CommandPaletteProvider>
        <div className="min-h-screen flex bg-ink-50/30 dark:bg-ink-950">
          <Sidebar />
          <main id="main" className="flex-1 overflow-y-auto pb-24 lg:pb-0">
            <div className="container py-8 sm:py-12 max-w-6xl">{children}</div>
          </main>
          <MobileNav />
        </div>
      </CommandPaletteProvider>
    </DashboardBadgesProvider>
  );
}
