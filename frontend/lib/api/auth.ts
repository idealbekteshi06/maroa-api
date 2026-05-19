/**
 * lib/api/auth.ts — Supabase Auth wrapper (magic link).
 *
 * Uses @supabase/ssr for Next.js App Router compatibility.
 * Magic-link flow: signUp / logIn send an email; the user clicks and lands
 * on /auth/callback (route handler — to be added) which writes the session.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SITE_URL =
  typeof window !== 'undefined'
    ? window.location.origin
    : process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

// Audit 2026-05-19 F11: memoize the browser client. Previously every
// signUp/logIn/getSession allocated a new client + reopened the realtime
// channel + reread the auth cookie. Singleton-per-process is correct and
// avoids a 50 KB churn cost on each auth call.
let _cachedClient: SupabaseClient | null = null;

function client(): SupabaseClient {
  if (_cachedClient) return _cachedClient;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      'Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  _cachedClient = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _cachedClient;
}

export async function signUp({
  email,
  businessName,
  plan = 'free',
}: {
  email: string;
  businessName: string;
  plan?: string;
}) {
  const supabase = client();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `${SITE_URL}/auth/callback?next=/onboarding&plan=${encodeURIComponent(plan)}`,
      data: { business_name: businessName, intended_plan: plan },
    },
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function logIn({ email }: { email: string }) {
  const supabase = client();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${SITE_URL}/auth/callback`,
    },
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function logOut() {
  const supabase = client();
  await supabase.auth.signOut();
}

export async function getSession(): Promise<Session | null> {
  const supabase = client();
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}
