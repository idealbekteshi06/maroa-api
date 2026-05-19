'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Save, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';
import { updateOnboardingProfile } from '@/lib/api/business';

/**
 * components/dashboard/settings/profile-form.tsx
 * ---------------------------------------------------------------------------
 * Edit the onboarding profile. PATCH /api/onboarding/profile/:userId.
 * Optimistic toast on save; reverts the local state on error.
 * ---------------------------------------------------------------------------
 */

interface InitialProfile {
  business_name: string;
  industry: string;
  region: string;
  audience: string;
  goal: string;
  [key: string]: unknown;
}

export function ProfileForm({
  userId,
  initial,
}: {
  userId: string | null;
  initial: InitialProfile;
}) {
  const [data, setData] = useState<InitialProfile>(initial);
  const [saving, startSaving] = useTransition();

  function onChange<K extends keyof InitialProfile>(key: K, value: InitialProfile[K]) {
    setData((d) => ({ ...d, [key]: value }));
  }

  function save() {
    if (!userId) {
      toast.error("Couldn't save — your session expired. Sign in again.");
      return;
    }
    startSaving(async () => {
      try {
        const updated = await updateOnboardingProfile(userId, data);
        if (!updated) throw new Error('Update returned no profile.');
        toast.success('Saved', { description: "I'll use this on the next draft." });
      } catch (e) {
        toast.error("Couldn't save", { description: errorMessage(e, 'Try again in a moment.') });
      }
    });
  }

  return (
    <form
      className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle p-6 sm:p-8 space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Input
        label="Business name"
        value={data.business_name}
        onChange={(e) => onChange('business_name', e.target.value)}
        required
      />
      <Input
        label="Industry"
        placeholder="Café, dental, plumbing, …"
        value={data.industry}
        onChange={(e) => onChange('industry', e.target.value)}
      />
      <Input
        label="City or region"
        placeholder="Tirana, Boston, EU, …"
        value={data.region}
        onChange={(e) => onChange('region', e.target.value)}
      />
      <div>
        <label
          htmlFor="audience"
          className="block text-sm font-medium text-ink-700 dark:text-ink-100 mb-1.5"
        >
          Who do you sell to?
        </label>
        <textarea
          id="audience"
          rows={3}
          className="block w-full rounded-xl border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-900 px-4 py-3 text-base text-ink-700 dark:text-ink-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20"
          value={data.audience}
          onChange={(e) => onChange('audience', e.target.value)}
          placeholder="Families with kids 5–12 within 5 miles of our office"
        />
      </div>
      <Input
        label="Primary goal"
        placeholder="Get 10 new patient bookings per month"
        value={data.goal}
        onChange={(e) => onChange('goal', e.target.value)}
        hint="What does success look like in 90 days?"
      />
      <div className="flex justify-end pt-2">
        <Button type="submit" variant="primary" size="lg" disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            <>
              <Save className="h-4 w-4" aria-hidden="true" />
              Save changes
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
