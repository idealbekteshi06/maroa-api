import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Ads', robots: { index: false } };

export default function AdsPage() {
  return (
    <>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold text-ink-700 tracking-tight">Ads</h1>
        <p className="mt-2 text-ink-400">Daily audits, pacing alerts, recommendations.</p>
      </header>
      <Card>
        <CardContent className="py-16 text-center">
          <p className="text-ink-400">Connect Meta or Google ads to see your campaigns here.</p>
        </CardContent>
      </Card>
    </>
  );
}
