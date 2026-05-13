import type { Metadata } from 'next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Settings', robots: { index: false } };

export default function SettingsPage() {
  return (
    <>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold text-ink-700 tracking-tight">Settings</h1>
        <p className="mt-2 text-ink-400">Brand voice, integrations, billing.</p>
      </header>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Brand voice</CardTitle>
            <CardDescription>
              How Maroa writes for you. Edit anytime.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm">Edit voice anchor</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Integrations</CardTitle>
            <CardDescription>Meta, Google, TikTok, LinkedIn, Pinterest, YouTube, email.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm" href="/api/oauth/meta/start">Connect Meta</Button>
            <Button variant="outline" size="sm" href="/api/oauth/google/start" className="ml-2">Connect Google</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Billing</CardTitle>
            <CardDescription>Manage your plan, view invoices, change payment method.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" href="/api/billing/portal">Open billing portal</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Danger zone</CardTitle>
            <CardDescription>Export everything Maroa has ever made for you, or close the account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" size="sm">Export data (.zip)</Button>
            <Button variant="ghost" size="sm" className="ml-2 text-red-600 hover:bg-red-50">Close account</Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
