import { Sidebar } from '@/components/dashboard/sidebar';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex bg-ink-50/30">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="container py-8 sm:py-12 max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
