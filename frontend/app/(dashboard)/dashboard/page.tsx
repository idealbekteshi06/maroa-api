import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, AlertCircle, TrendingUp, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return (
    <>
      <header className="mb-10">
        <p className="text-sm text-ink-400 mb-1">Welcome back</p>
        <h1 className="text-3xl font-semibold text-ink-700 tracking-tight">
          Your week, at a glance.
        </h1>
      </header>

      {/* KPI cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Scheduled today', value: '5', icon: Activity, trend: 'On track' },
          { label: 'Awaiting your approval', value: '3', icon: AlertCircle, trend: 'Review needed' },
          { label: 'Published this week', value: '14', icon: CheckCircle2, trend: '+2 vs last week' },
          { label: 'Ad spend pacing', value: '$87', icon: TrendingUp, trend: '92% of budget' },
        ].map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs uppercase tracking-wider text-ink-400">{kpi.label}</p>
                <kpi.icon className="h-4 w-4 text-ink-300" />
              </div>
              <p className="text-3xl font-semibold text-ink-700 tracking-tight">{kpi.value}</p>
              <p className="text-xs text-ink-400 mt-1">{kpi.trend}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      {/* Today's queue */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-ink-700">Today&apos;s content queue</h2>
          <Link href="/content" className="text-sm text-accent-500 hover:underline font-medium">
            View all
          </Link>
        </div>

        <div className="space-y-3">
          {[
            { time: '09:00', channel: 'Instagram', title: 'Morning post — Father\'s Day teaser', status: 'awaiting_review' },
            { time: '12:00', channel: 'LinkedIn', title: 'Thought piece — patient case story', status: 'scheduled' },
            { time: '15:00', channel: 'Facebook', title: 'Community shout — local soccer team', status: 'scheduled' },
            { time: '18:00', channel: 'Email', title: 'Newsletter — appointment reminders', status: 'draft' },
          ].map((item) => (
            <Card key={item.title}>
              <CardContent className="flex items-center gap-4 p-4">
                <div className="text-sm font-mono text-ink-400 w-16">{item.time}</div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-ink-700 truncate">{item.title}</p>
                  <p className="text-xs text-ink-400 mt-0.5">{item.channel}</p>
                </div>
                <StatusPill status={item.status} />
                <Button href={`/content`} size="sm" variant="ghost">
                  Open
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Ad performance preview */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Active ad campaigns</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-ink-400 text-sm">2 campaigns running · $87 spent today</p>
            <Button href="/ads" variant="outline" size="sm" className="mt-4">
              View ads dashboard
              <ArrowRight className="h-3 w-3" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Weekly scorecard</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-ink-400 text-sm">Next scorecard arrives Sunday evening.</p>
            <p className="text-ink-700 text-sm mt-2">
              Last week: <span className="font-medium">12 posts, 1.8% engagement, $312 ad spend, 4.2x ROAS</span>.
            </p>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const config: Record<string, { label: string; classes: string }> = {
    awaiting_review: { label: 'Review', classes: 'bg-amber-100 text-amber-700' },
    scheduled: { label: 'Scheduled', classes: 'bg-green-100 text-green-700' },
    draft: { label: 'Draft', classes: 'bg-ink-100 text-ink-700' },
  };
  const c = config[status] ?? config.draft;
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${c.classes}`}>
      {c.label}
    </span>
  );
}
