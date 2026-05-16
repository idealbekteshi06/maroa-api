'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  CheckCircle2,
  Users,
  FileBarChart,
  Loader2,
  CheckCheck,
} from 'lucide-react';
import { fuzzyRank } from '@/lib/fuzzy-match';

/**
 * Command palette — Cmd/Ctrl + K invocation, three real actions.
 *
 *   • <CommandPaletteProvider> sits in the dashboard layout, owns the open
 *     state + the data slot (workspaceId, clients, green-band decisions
 *     queued for bulk-approve), binds the global shortcut, renders the
 *     <dialog> shell.
 *   • <CommandPaletteHandle> renders the "⌘ K" pill anywhere on the page
 *     and opens the dialog on click.
 *   • Pages push payload into the data slot via setPaletteData() so the
 *     suggestions become live for whichever surface is mounted.
 */

type GreenBandDecision = { id: string; recommendation_text: string };
type ClientLite = { business_id: string; client_name: string };

export type CommandPaletteData = {
  workspaceId: string | null;
  clients: ClientLite[];
  greenBandDecisions: GreenBandDecision[];
};

type Ctx = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
  data: CommandPaletteData;
  setPaletteData: (d: Partial<CommandPaletteData>) => void;
  /** IDs of decisions the palette has bulk-approved this session. Read by
      PriorityCard so cards collapse to the "Approved" state immediately
      while router.refresh() catches up. */
  actionedIds: ReadonlySet<string>;
  markActioned: (ids: string[]) => void;
};

const EMPTY_DATA: CommandPaletteData = {
  workspaceId: null,
  clients: [],
  greenBandDecisions: [],
};

const PaletteContext = createContext<Ctx>({
  open: () => {},
  close: () => {},
  isOpen: false,
  data: EMPTY_DATA,
  setPaletteData: () => {},
  actionedIds: new Set<string>(),
  markActioned: () => {},
});

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [data, setData] = useState<CommandPaletteData>(EMPTY_DATA);
  const [actionedIds, setActionedIds] = useState<ReadonlySet<string>>(new Set<string>());
  const markActioned = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setActionedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const open = useCallback(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    const dlg = dialogRef.current;
    if (dlg?.open) dlg.close();
    setIsOpen(false);
  }, []);

  const setPaletteData = useCallback((partial: Partial<CommandPaletteData>) => {
    setData((prev) => ({ ...prev, ...partial }));
  }, []);

  // Global Cmd/Ctrl + K binding — single listener at the layout level.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (dialogRef.current?.open) close();
        else open();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    function onClick(e: MouseEvent) {
      if (e.target === dlg) close();
    }
    dlg.addEventListener('click', onClick);
    return () => dlg.removeEventListener('click', onClick);
  }, [close]);

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const onClose = () => setIsOpen(false);
    dlg.addEventListener('close', onClose);
    return () => dlg.removeEventListener('close', onClose);
  }, []);

  const value: Ctx = useMemo(
    () => ({ open, close, isOpen, data, setPaletteData, actionedIds, markActioned }),
    [open, close, isOpen, data, setPaletteData, actionedIds, markActioned],
  );

  return (
    <PaletteContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        aria-label="Command palette"
        className="palette-dialog max-w-2xl w-full mx-auto p-0 rounded-2xl border border-ink-200/60 dark:border-ink-700/60 bg-white dark:bg-ink-900 shadow-lifted backdrop:bg-ink-950/40 backdrop:backdrop-blur-sm"
      >
        <PaletteBody onClose={close} isOpen={isOpen} />
      </dialog>
    </PaletteContext.Provider>
  );
}

/**
 * Inner body — split from provider so the input state, search filter, and
 * bulk-approve runtime can mount/unmount with the dialog.
 */
function PaletteBody({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { data, markActioned } = useContext(PaletteContext);
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [bulkState, setBulkState] = useState<'idle' | 'running' | 'done'>('idle');
  const [bulkResult, setBulkResult] = useState<{ ok: number; fail: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query + bulk state every time the palette closes so the next
  // open starts clean.
  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setBulkState('idle');
      setBulkResult(null);
    } else {
      // Give the dialog a tick to mount, then focus the input.
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [isOpen]);

  const greenBandCount = data.greenBandDecisions.length;
  const canBulkApprove = bulkState === 'idle' && greenBandCount > 0 && !!data.workspaceId;

  const trimmed = query.trim();
  const clientMatches = useMemo(() => {
    if (!trimmed) return data.clients.slice(0, 5);
    // Fuzzy ranker handles "stusm" → "Smile Studio", out-of-order chars,
    // word-boundary bonuses, gap penalties. Substring matches always
    // rank first.
    return fuzzyRank(data.clients, trimmed, (c) => c.client_name).slice(0, 5);
  }, [data.clients, trimmed]);

  async function runBulkApprove() {
    if (!canBulkApprove) return;
    setBulkState('running');
    setBulkResult(null);
    const ws = data.workspaceId!;
    const queued = data.greenBandDecisions;
    const results = await Promise.allSettled(
      queued.map((d) =>
        fetch(
          `/api/war-room/${encodeURIComponent(ws)}/decisions/${encodeURIComponent(d.id)}/approve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
          },
        ).then((r) => {
          if (!r.ok && r.status !== 409) throw new Error(`HTTP ${r.status}`);
          return { id: d.id, ok: true };
        }),
      ),
    );
    const succeededIds: string[] = [];
    let ok = 0;
    let fail = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        ok++;
        succeededIds.push(queued[i]!.id);
      } else {
        fail++;
      }
    });
    setBulkResult({ ok, fail });
    setBulkState('done');
    // Optimistic visual update: PriorityCards keyed on these ids will
    // immediately collapse to the Approved state via the actionedIds set
    // we just published. router.refresh() then catches up the real data.
    markActioned(succeededIds);
    router.refresh();
  }

  function jumpToClient(businessId: string) {
    router.push(`/dashboard/client/${encodeURIComponent(businessId)}`);
    onClose();
  }

  function openReport() {
    router.push('/dashboard/reports');
    onClose();
  }

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-ink-200/60 dark:border-ink-800">
        <Search className="h-4 w-4 text-ink-400 flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search clients or pick an action…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 bg-transparent outline-none text-sm text-ink-700 dark:text-ink-100 placeholder:text-ink-400"
        />
        <kbd className="text-[10px] font-mono text-ink-400 border border-ink-200 dark:border-ink-700 rounded px-1.5 py-0.5">
          Esc
        </kbd>
      </div>
      <div className="p-2 max-h-[60vh] overflow-y-auto">
        {/* ── Actions ───────────────────────────────────────────────────── */}
        <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-ink-400 font-medium">
          Actions
        </p>
        <ul>
          <li>
            <button
              type="button"
              onClick={runBulkApprove}
              disabled={!canBulkApprove}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-ink-700 dark:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {bulkState === 'running' ? (
                <Loader2 className="h-4 w-4 text-accent-500 flex-shrink-0 animate-spin" />
              ) : bulkState === 'done' ? (
                <CheckCheck className="h-4 w-4 text-green-500 flex-shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-ink-400 flex-shrink-0" />
              )}
              <span className="flex-1">
                {bulkState === 'done' && bulkResult
                  ? `Approved ${bulkResult.ok}${bulkResult.fail > 0 ? `, ${bulkResult.fail} failed` : ''}`
                  : `Approve all green-band decisions`}
              </span>
              {bulkState === 'idle' && (
                <span className="text-[10px] text-ink-400 tabular-nums">
                  {greenBandCount > 0 ? `${greenBandCount} ready` : 'none queued'}
                </span>
              )}
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={openReport}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-ink-700 dark:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors text-left"
            >
              <FileBarChart className="h-4 w-4 text-ink-400 flex-shrink-0" />
              <span className="flex-1">Open today&apos;s report</span>
              <kbd className="text-[10px] font-mono text-ink-400">↵</kbd>
            </button>
          </li>
        </ul>
        {/* ── Jump to client ────────────────────────────────────────────── */}
        <p className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-ink-400 font-medium">
          {trimmed ? 'Matching clients' : 'Recent clients'}
        </p>
        {clientMatches.length === 0 ? (
          <p className="px-3 py-2 text-sm text-ink-400">
            {trimmed ? `No clients match "${query}".` : 'No clients yet.'}
          </p>
        ) : (
          <ul>
            {clientMatches.map((c) => (
              <li key={c.business_id}>
                <button
                  type="button"
                  onClick={() => jumpToClient(c.business_id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-ink-700 dark:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors text-left"
                >
                  <Users className="h-4 w-4 text-ink-400 flex-shrink-0" />
                  <span className="flex-1 truncate">{c.client_name}</span>
                  <span className="text-[10px] text-ink-400 font-mono">jump</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function CommandPaletteHandle() {
  const { open, isOpen } = useContext(PaletteContext);
  return (
    <button
      type="button"
      onClick={open}
      aria-expanded={isOpen}
      aria-label="Open command palette"
      className="inline-flex items-center gap-1.5 text-[11px] font-mono text-ink-500 dark:text-ink-400 bg-ink-100 dark:bg-ink-800/60 hover:bg-ink-200 dark:hover:bg-ink-800 border border-ink-200/60 dark:border-ink-700/60 rounded-lg px-2 py-1 transition-colors flex-shrink-0"
    >
      <span>Quick action</span>
      <kbd className="inline-flex items-center gap-0.5 border border-ink-200 dark:border-ink-700 rounded px-1 py-px text-ink-600 dark:text-ink-300">
        <span>⌘</span>
        <span>K</span>
      </kbd>
    </button>
  );
}

/** Convenience hook so pages can publish data without importing the
    context type. Use inside an effect after the page's data loads. */
export function useCommandPaletteDataSetter() {
  return useContext(PaletteContext).setPaletteData;
}

/** Read which decision ids the palette has bulk-approved this session.
    Consumed by PriorityCard to surface the Approved state instantly
    while router.refresh() catches up the real data. */
export function useActionedDecisionIds(): ReadonlySet<string> {
  return useContext(PaletteContext).actionedIds;
}
