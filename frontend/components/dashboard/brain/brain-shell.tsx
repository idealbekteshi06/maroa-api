'use client';

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Sparkles,
  Send,
  Plus,
  Loader2,
  HelpCircle,
  Info,
  MessageSquare,
  Square,
  ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  listConversations,
  getConversation,
  createConversation,
  explainMessage,
  sendMessageStream,
  type BrainConversationSummary,
  type BrainMessage,
  type BrainExplanation,
} from '@/lib/api/brain';

/**
 * components/dashboard/brain/brain-shell.tsx
 * ---------------------------------------------------------------------------
 * The WF15 "AI Brain" chat — an advisory marketing strategist.
 *
 * It streams a Claude reply (SSE over fetch) and exposes a working "Why?"
 * disclosure (/wf15-explain). It deliberately ships NO action buttons: the
 * backend's 30 tools don't execute yet, so a one-line banner sets the
 * honest expectation ("execution coming soon") instead.
 * ---------------------------------------------------------------------------
 */

interface Props {
  businessId: string | null;
}

interface UiMessage extends BrainMessage {
  pending?: boolean;
}

type ExplainState = 'loading' | BrainExplanation;

const SUGGESTED_PROMPTS = [
  'What should I focus on this week?',
  'How are my ads performing?',
  'Draft 3 post ideas for a summer promo',
  'Who are my competitors and what are they doing?',
];

const isRealId = (id: string) => !!id && !id.startsWith('tmp-');

export function BrainShell({ businessId }: Props) {
  const [conversations, setConversations] = useState<BrainConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingConvos, setLoadingConvos] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [explanations, setExplanations] = useState<Record<string, ExplainState>>({});
  const [mobileListOpen, setMobileListOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshConversations = useCallback(async () => {
    if (!businessId) return;
    const list = await listConversations(businessId);
    setConversations(list);
  }, [businessId]);

  const openConversation = useCallback(
    async (id: string) => {
      if (!businessId) return;
      abortRef.current?.abort();
      abortRef.current = null;
      setStreaming(false);
      setActiveId(id);
      setMobileListOpen(false);
      setExplanations({});
      setLoadingThread(true);
      const detail = await getConversation(businessId, id);
      setMessages(detail?.messages ?? []);
      setLoadingThread(false);
    },
    [businessId],
  );

  // Initial load — conversations + open the most recent one.
  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    (async () => {
      setLoadingConvos(true);
      const list = await listConversations(businessId);
      if (cancelled) return;
      setConversations(list);
      setLoadingConvos(false);
      if (list[0]) void openConversation(list[0].id);
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId, openConversation]);

  // Keep the thread pinned to the latest message while it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  function startNew() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setActiveId(null);
    setMessages([]);
    setExplanations({});
    setMobileListOpen(false);
    setInput('');
    taRef.current?.focus();
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || streaming || !businessId) return;
    setInput('');

    let convId = activeId;
    if (!convId) {
      convId = await createConversation(businessId, content);
      if (!convId) {
        toast.error("Couldn't start a conversation", { description: 'Please try again in a moment.' });
        setInput(content);
        return;
      }
      setActiveId(convId);
      const newId = convId;
      setConversations((prev) => [
        { id: newId, title: content.slice(0, 60), lastMessageAt: new Date().toISOString(), messageCount: 1 },
        ...prev,
      ]);
    }

    const tmpUser = `tmp-u-${Date.now()}`;
    const tmpAsst = `tmp-a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tmpUser, role: 'user', content, createdAt: new Date().toISOString() },
      { id: tmpAsst, role: 'assistant', content: '', createdAt: new Date().toISOString(), pending: true },
    ]);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    let asstId = tmpAsst;

    await sendMessageStream(businessId, convId, content, {
      signal: ac.signal,
      onMeta: (realId) => {
        if (!realId) return;
        const prevId = asstId;
        asstId = realId;
        setMessages((prev) => prev.map((m) => (m.id === prevId ? { ...m, id: realId } : m)));
      },
      onToken: (delta) => {
        setMessages((prev) => prev.map((m) => (m.id === asstId ? { ...m, content: m.content + delta } : m)));
      },
      onDone: () => {
        setMessages((prev) => prev.map((m) => (m.id === asstId ? { ...m, pending: false } : m)));
        setStreaming(false);
        abortRef.current = null;
        void refreshConversations();
      },
      onError: (msg) => {
        setMessages((prev) => prev.filter((m) => m.id !== asstId));
        setStreaming(false);
        abortRef.current = null;
        toast.error('The Brain could not respond', { description: msg });
      },
    });
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages((prev) => prev.map((m) => (m.pending ? { ...m, pending: false } : m)));
  }

  async function toggleExplain(messageId: string) {
    if (!businessId) return;
    if (explanations[messageId]) {
      setExplanations((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      return;
    }
    setExplanations((prev) => ({ ...prev, [messageId]: 'loading' }));
    const exp = await explainMessage(businessId, messageId);
    if (!exp) {
      setExplanations((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      toast.error("Couldn't load the reasoning", { description: 'Try again in a moment.' });
      return;
    }
    setExplanations((prev) => ({ ...prev, [messageId]: exp }));
  }

  if (!businessId) {
    return (
      <div className="mx-auto max-w-xl text-center py-16">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-50 dark:bg-accent-900/30 text-accent-500 mb-4">
          <Sparkles className="h-6 w-6" />
        </span>
        <h1 className="text-2xl font-semibold text-ink-700 dark:text-ink-50">Meet your AI Brain</h1>
        <p className="mt-3 text-ink-500 dark:text-ink-300 leading-relaxed">
          Your always-on marketing strategist. Finish setting up your business profile and it’ll
          have the context to advise you.
        </p>
        <Link
          href="/onboarding"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent-500 text-white px-5 py-2.5 text-sm font-semibold hover:shadow-card transition-shadow"
        >
          Finish setup
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  const hasThread = messages.length > 0;

  return (
    <div className="flex h-[calc(100vh-12rem)] min-h-[460px] rounded-2xl border border-ink-200/60 dark:border-ink-800 bg-white dark:bg-ink-900 overflow-hidden shadow-subtle">
      <aside className="hidden md:flex w-64 flex-col border-r border-ink-200/60 dark:border-ink-800 bg-ink-50/40 dark:bg-ink-950/40">
        <Rail
          conversations={conversations}
          activeId={activeId}
          loading={loadingConvos}
          onSelect={openConversation}
          onNew={startNew}
        />
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-ink-200/60 dark:border-ink-800">
          <button
            type="button"
            onClick={() => setMobileListOpen((v) => !v)}
            className="md:hidden -ml-1 h-9 w-9 inline-flex items-center justify-center rounded-lg text-ink-400 hover:text-ink-700 dark:hover:text-ink-100 hover:bg-ink-100 dark:hover:bg-ink-800"
            aria-label="Conversations"
          >
            <MessageSquare className="h-5 w-5" />
          </button>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent-50 dark:bg-accent-900/30 text-accent-500 shrink-0">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-ink-700 dark:text-ink-50 leading-tight">AI Brain</h1>
            <p className="text-xs text-ink-400 truncate">Your marketing strategist — ask anything</p>
          </div>
          <button
            type="button"
            onClick={startNew}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-ink-200/70 dark:border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-600 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        </header>

        {mobileListOpen && (
          <div className="md:hidden border-b border-ink-200/60 dark:border-ink-800 max-h-56 overflow-y-auto bg-ink-50/60 dark:bg-ink-950/40">
            <Rail
              conversations={conversations}
              activeId={activeId}
              loading={loadingConvos}
              onSelect={openConversation}
              onNew={startNew}
              compact
            />
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
          <div className="flex items-start gap-2.5 rounded-xl border border-ink-200/60 dark:border-ink-800 bg-ink-50/70 dark:bg-ink-950/40 px-4 py-3">
            <Info className="h-4 w-4 mt-0.5 text-ink-400 shrink-0" aria-hidden="true" />
            <p className="text-xs text-ink-500 dark:text-ink-300 leading-relaxed">
              The Brain analyzes your marketing and recommends what to do next. One-tap actions —
              pausing a campaign, publishing, sending email — are{' '}
              <span className="font-medium text-ink-600 dark:text-ink-200">coming soon</span>; for now it
              advises and you approve in the relevant screen.
            </p>
          </div>

          {loadingThread ? (
            <div className="flex items-center justify-center py-10 text-ink-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !hasThread ? (
            <EmptyThread onPick={(p) => void send(p)} />
          ) : (
            messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} content={m.content} />
              ) : (
                <AssistantBubble
                  key={m.id}
                  message={m}
                  explain={explanations[m.id]}
                  onExplain={() => void toggleExplain(m.id)}
                  canExplain={isRealId(m.id) && !m.pending}
                />
              ),
            )
          )}
        </div>

        <Composer
          ref={taRef}
          value={input}
          onChange={setInput}
          onSend={() => void send(input)}
          onStop={stop}
          streaming={streaming}
        />
      </div>
    </div>
  );
}

function Rail({
  conversations,
  activeId,
  loading,
  onSelect,
  onNew,
  compact,
}: {
  conversations: BrainConversationSummary[];
  activeId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  compact?: boolean;
}) {
  return (
    <>
      {!compact && (
        <div className="p-3">
          <button
            type="button"
            onClick={onNew}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-ink-700 dark:bg-white text-white dark:text-ink-900 px-3 py-2 text-sm font-medium hover:shadow-card transition-shadow"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-ink-400">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-3 py-6 text-xs text-ink-400 text-center">No conversations yet.</p>
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              title={c.title}
              className={cn(
                'block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate',
                c.id === activeId
                  ? 'bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 font-medium'
                  : 'text-ink-500 dark:text-ink-300 hover:bg-ink-100/70 dark:hover:bg-ink-800/60',
              )}
            >
              {c.title || 'New conversation'}
            </button>
          ))
        )}
      </div>
    </>
  );
}

function EmptyThread({ onPick }: { onPick: (p: string) => void }) {
  return (
    <div className="py-8 text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-50 dark:bg-accent-900/30 text-accent-500 mb-4">
        <Sparkles className="h-6 w-6" />
      </span>
      <h2 className="text-lg font-semibold text-ink-700 dark:text-ink-50">How can I help?</h2>
      <p className="mt-1.5 text-sm text-ink-500 dark:text-ink-300 max-w-md mx-auto">
        Ask about your content, ads, competitors, or what to prioritize. I’ll use what I know about
        your business.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2 max-w-lg mx-auto">
        {SUGGESTED_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-full border border-ink-200/70 dark:border-ink-700 px-3.5 py-1.5 text-xs text-ink-600 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-500 text-white px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({
  message,
  explain,
  onExplain,
  canExplain,
}: {
  message: UiMessage;
  explain: ExplainState | undefined;
  onExplain: () => void;
  canExplain: boolean;
}) {
  const empty = !message.content && message.pending;
  return (
    <div className="flex gap-3">
      <span className="hidden sm:inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent-50 dark:bg-accent-900/30 text-accent-500 shrink-0 mt-0.5">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="rounded-2xl rounded-tl-md bg-ink-50 dark:bg-ink-800/70 border border-ink-200/50 dark:border-ink-700/50 px-4 py-3 text-sm leading-relaxed text-ink-700 dark:text-ink-100 whitespace-pre-wrap break-words">
          {empty ? (
            <span className="inline-flex items-center gap-1.5 text-ink-400">
              <span className="h-1.5 w-1.5 rounded-full bg-ink-400 animate-pulse" />
              <span className="h-1.5 w-1.5 rounded-full bg-ink-400 animate-pulse [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 rounded-full bg-ink-400 animate-pulse [animation-delay:300ms]" />
            </span>
          ) : (
            <>
              {message.content}
              {message.pending && (
                <span className="ml-0.5 inline-block w-1.5 h-4 align-middle bg-ink-400 animate-pulse" />
              )}
            </>
          )}
        </div>
        {canExplain && (
          <button
            type="button"
            onClick={onExplain}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-ink-400 hover:text-accent-500 transition-colors"
          >
            <HelpCircle className="h-3.5 w-3.5" />
            {explain ? 'Hide reasoning' : 'Why?'}
          </button>
        )}
        {explain && <ExplanationPanel state={explain} />}
      </div>
    </div>
  );
}

function ExplanationPanel({ state }: { state: ExplainState }) {
  if (state === 'loading') {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-ink-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working through the reasoning…
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-xl border border-accent-200/50 dark:border-accent-900/40 bg-accent-50/50 dark:bg-accent-900/10 px-4 py-3 text-xs space-y-2.5">
      {state.decision && (
        <div>
          <p className="font-semibold text-ink-700 dark:text-ink-100">Reasoning</p>
          <p className="mt-0.5 text-ink-600 dark:text-ink-300 leading-relaxed">{state.decision}</p>
        </div>
      )}
      {state.evidence?.length > 0 && (
        <div>
          <p className="font-semibold text-ink-700 dark:text-ink-100">What it’s based on</p>
          <ul className="mt-1 space-y-1">
            {state.evidence.map((e, i) => (
              <li key={i} className="flex gap-2 text-ink-600 dark:text-ink-300">
                <span className="mt-1.5 h-1 w-1 rounded-full bg-accent-400 shrink-0" />
                <span className="leading-relaxed">{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.alternatives?.length > 0 && (
        <div>
          <p className="font-semibold text-ink-700 dark:text-ink-100">Other options considered</p>
          <ul className="mt-1 space-y-1">
            {state.alternatives.map((a, i) => (
              <li key={i} className="text-ink-600 dark:text-ink-300 leading-relaxed">
                <span className="font-medium">{a.option}</span> — {a.why_rejected}
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.nextStep && (
        <div>
          <p className="font-semibold text-ink-700 dark:text-ink-100">Suggested next step</p>
          <p className="mt-0.5 text-ink-600 dark:text-ink-300 leading-relaxed">{state.nextStep}</p>
        </div>
      )}
    </div>
  );
}

const Composer = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    onStop: () => void;
    streaming: boolean;
  }
>(function Composer({ value, onChange, onSend, onStop, streaming }, ref) {
  return (
    <div className="border-t border-ink-200/60 dark:border-ink-800 p-3 sm:p-4">
      <div className="flex items-end gap-2 rounded-2xl border border-ink-200/70 dark:border-ink-700 bg-white dark:bg-ink-950 px-3 py-2 focus-within:ring-2 focus-within:ring-accent-500/40">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onInput={(e) => {
            const t = e.currentTarget;
            t.style.height = 'auto';
            t.style.height = `${Math.min(t.scrollHeight, 128)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!streaming) onSend();
            }
          }}
          placeholder="Ask your AI Brain…"
          className="flex-1 resize-none bg-transparent text-sm text-ink-700 dark:text-ink-100 placeholder:text-ink-400 focus:outline-none max-h-32 py-1.5"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-200 hover:bg-ink-200 dark:hover:bg-ink-700 transition-colors"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!value.trim()}
            aria-label="Send"
            className="shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-xl bg-accent-500 text-white hover:shadow-card transition-shadow disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[10px] text-ink-400">Enter to send · Shift+Enter for a new line</p>
    </div>
  );
});
