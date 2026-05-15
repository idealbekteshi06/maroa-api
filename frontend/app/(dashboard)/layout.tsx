import { Sidebar } from '@/components/dashboard/sidebar';
import { MobileNav } from '@/components/dashboard/mobile-nav';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex bg-ink-50/30">
      <Sidebar />
      <main id="main" className="flex-1 overflow-y-auto pb-24 lg:pb-0">
        <div className="container py-8 sm:py-12 max-w-6xl">{children}</div>
      </main>
      <MobileNav />
    </div>
  );
}
