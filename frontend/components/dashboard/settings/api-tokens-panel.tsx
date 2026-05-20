'use client';

/**
 * components/dashboard/settings/api-tokens-panel.tsx
 * ---------------------------------------------------------------------------
 * Lists the user's API tokens and lets them mint or revoke ones. After
 * creating, the full secret renders ONCE in a copy-to-clipboard panel —
 * once the customer dismisses it, the secret is gone for good.
 *
 * Endpoints:
 *   POST   /api/tokens            → { ok, token, prefix, label, expires_at }
 *   GET    /api/tokens            → { tokens: [...] }
 *   DELETE /api/tokens/:id        → { ok }
 * ---------------------------------------------------------------------------
 */

import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch, ApiError } from '@/lib/api/client';

interface TokenRow {
  id: number | string;
  label: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  active: boolean;
}

interface MintedToken {
  token: string;
  prefix: string;
  label: string;
  expires_at: string;
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ApiTokensPanel() {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintedToken | null>(null);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const body = await apiFetch<{ tokens: TokenRow[] }>('/api/tokens');
      setTokens(body.tokens || []);
    } catch (err) {
      toast.error('Could not load API tokens.', { description: errMessage(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onMint = useCallback(async () => {
    const trimmed = label.trim();
    if (!trimmed) {
      toast.error('Give the token a label (e.g. "CLI on my laptop").');
      return;
    }
    setMinting(true);
    try {
      const body = await apiFetch<MintedToken & { ok: boolean }>('/api/tokens', {
        method: 'POST',
        body: { label: trimmed },
      });
      setMinted({
        token: body.token,
        prefix: body.prefix,
        label: body.label,
        expires_at: body.expires_at,
      });
      setLabel('');
      void reload();
    } catch (err) {
      toast.error('Could not create token.', { description: errMessage(err) });
    } finally {
      setMinting(false);
    }
  }, [label, reload]);

  const onRevoke = useCallback(
    async (id: number | string, name: string) => {
      const ok = window.confirm(`Revoke "${name}"? Anything using this token will stop working.`);
      if (!ok) return;
      try {
        await apiFetch(`/api/tokens/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
        toast.success('Token revoked.');
        void reload();
      } catch (err) {
        toast.error('Could not revoke token.', { description: errMessage(err) });
      }
    },
    [reload],
  );

  const onCopy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Could not copy — copy manually.');
    }
  }, []);

  return (
    <div className="space-y-6">
      {/* Mint form */}
      <section className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 p-6 shadow-subtle">
        <h2 className="text-lg font-semibold text-ink-700 dark:text-ink-50">Create a new token</h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          Tokens last 90 days and have read + write access to your workspace. Treat them like passwords.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            value={label}
            maxLength={80}
            placeholder='e.g. "CLI on my laptop"'
            className="flex-1 rounded-lg border border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-800 px-3 py-2 text-sm text-ink-700 dark:text-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            onChange={(e) => setLabel(e.target.value)}
            disabled={minting}
          />
          <button
            type="button"
            onClick={onMint}
            disabled={minting}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600 disabled:opacity-50"
          >
            {minting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {minting ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </section>

      {/* One-time secret reveal */}
      {minted ? (
        <section className="rounded-xl border border-amber-300/70 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-500/10 p-6">
          <div className="flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 mt-0.5 text-amber-700 dark:text-amber-300 shrink-0" />
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                Copy this token now — you won&apos;t see it again.
              </h3>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                Maroa stores only a one-way hash. If you lose it, revoke and mint a new one.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 rounded-md bg-white dark:bg-ink-900 border border-amber-200 dark:border-amber-500/30 px-3 py-2 font-mono text-xs text-ink-700 dark:text-ink-50 break-all">
                  {minted.token}
                </code>
                <button
                  type="button"
                  onClick={() => onCopy(minted.token)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 dark:border-amber-500/40 bg-white dark:bg-ink-900 px-3 py-2 text-xs font-medium text-amber-900 dark:text-amber-100 hover:bg-amber-100/60"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>
              <button
                type="button"
                onClick={() => setMinted(null)}
                className="mt-3 text-xs font-medium text-amber-900 dark:text-amber-100 underline underline-offset-4"
              >
                I&apos;ve saved it — dismiss
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* List */}
      <section className="rounded-xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 shadow-subtle">
        <div className="px-6 py-4 border-b border-ink-200/60 dark:border-ink-800">
          <h2 className="text-lg font-semibold text-ink-700 dark:text-ink-50">Your tokens</h2>
        </div>
        {loading ? (
          <div className="px-6 py-8 text-sm text-ink-500 dark:text-ink-300 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : tokens.length === 0 ? (
          <div className="px-6 py-8 text-sm text-ink-500 dark:text-ink-300">
            No tokens yet. Create one above to connect the CLI or browser extension.
          </div>
        ) : (
          <ul className="divide-y divide-ink-200/60 dark:divide-ink-800">
            {tokens.map((t) => (
              <li key={t.id} className="px-6 py-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-ink-700 dark:text-ink-50 truncate">{t.label}</span>
                    {t.revoked_at ? (
                      <span className="inline-flex items-center rounded-full bg-ink-100 dark:bg-ink-800 text-ink-500 dark:text-ink-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        Revoked
                      </span>
                    ) : t.active ? (
                      <span className="inline-flex items-center rounded-full bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        Expired
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-500 dark:text-ink-300">
                    <code className="font-mono">{t.prefix}…</code>
                    <span>Expires {new Date(t.expires_at).toLocaleDateString()}</span>
                    {t.last_used_at ? (
                      <span>Last used {new Date(t.last_used_at).toLocaleDateString()}</span>
                    ) : (
                      <span>Never used</span>
                    )}
                  </div>
                </div>
                {!t.revoked_at ? (
                  <button
                    type="button"
                    onClick={() => onRevoke(t.id, t.label)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
