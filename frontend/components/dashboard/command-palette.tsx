'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Search, CheckCircle2, Users, FileBarChart } from 'lucide-react';

/**
 * Command palette — seed of a real ⌘K experience.
 *
 *   • <CommandPaletteProvider> sits in the dashboard layout, owns the open
 *     state, binds the Cmd/Ctrl + K global shortcut once, and renders the
 *     <dialog> shell (native showModal → free focus trap + escape).
 *   • <CommandPaletteHandle> renders the "⌘ K" pill anywhere on the page
 *     and opens the dialog on click. Used in the War Room header.
 *
 * The three suggestion rows are stubs ("coming soon"). Full handler logic
 * lives in a future pass — this commit only ships the surface.
 */

type Ctx = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
};

const PaletteContext = createContext<Ctx>({
  open: () => {},
  close: () => {},
  isOpen: false,
});

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [isOpen, setIsOpen] = useState(false);

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

  // Global Cmd/Ctrl + K binding — single listener at the layout level.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (dialogRef.current?.open) {
          close();
        } else {
          open();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Backdrop click closes; the native <dialog::backdrop> isn't part of the
  // child tree so we attach to the dialog element and compare target.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    function onClick(e: MouseEvent) {
      if (e.target === dlg) close();
    }
    dlg.addEventListener('click', onClick);
    return () => dlg.removeEventListener('click', onClick);
  }, [close]);

  // Mirror native close (escape, .close()) into local state so the pill's
  // aria-expanded attribute stays accurate.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    const onClose = () => setIsOpen(false);
    dlg.addEventListener('close', onClose);
    return () => dlg.removeEventListener('close', onClose);
  }, []);

  return (
    <PaletteContext.Provider value={{ open, close, isOpen }}>
      {children}
      <dialog
        ref={dialogRef}
        aria-label="Command palette"
        className="palette-dialog max-w-2xl w-full mx-auto p-0 rounded-2xl border border-ink-200/60 dark:border-ink-700/60 bg-white dark:bg-ink-900 shadow-lifted backdrop:bg-ink-950/40 backdrop:backdrop-blur-sm"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-ink-200/60 dark:border-ink-800">
          <Search className="h-4 w-4 text-ink-400 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search clients, decisions, agents…"
            className="flex-1 bg-transparent outline-none text-sm text-ink-700 dark:text-ink-100 placeholder:text-ink-400"
            autoFocus
          />
          <kbd className="text-[10px] font-mono text-ink-400 border border-ink-200 dark:border-ink-700 rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>
        <ul className="p-2">
          {SUGGESTIONS.map((s) => (
            <li key={s.label}>
              <button
                type="button"
                disabled
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-ink-700 dark:text-ink-100 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors text-left disabled:cursor-not-allowed"
              >
                <s.icon className="h-4 w-4 text-ink-400 flex-shrink-0" />
                <span className="flex-1">{s.label}</span>
                <span className="text-[10px] text-ink-400 italic">(coming soon)</span>
              </button>
            </li>
          ))}
        </ul>
      </dialog>
    </PaletteContext.Provider>
  );
}

const SUGGESTIONS = [
  { label: 'Approve all green-band decisions', icon: CheckCircle2 },
  { label: 'Jump to client…', icon: Users },
  { label: "Open today's report", icon: FileBarChart },
];

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
