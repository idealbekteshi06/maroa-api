import type { Metadata } from 'next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Content',
  robots: { index: false, follow: false },
};

export default function ContentPage() {
  return (
    <>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold text-ink-700 tracking-tight">Content</h1>
        <p className="mt-2 text-ink-400">Approve, edit, or reschedule everything Maroa drafts.</p>
      </header>

      <Card>
        <CardContent className="py-16 text-center">
          <p className="text-ink-400">
            Your content queue will appear here once onboarding completes.
          </p>
          <Button href="/onboarding" variant="outline" size="sm" className="mt-6">
            Continue onboarding
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
