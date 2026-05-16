import { Check, X, ShieldAlert, TrendingUp, FileCheck, Sparkles, Globe2 } from 'lucide-react';

/**
 * Visual proof tiles for the /features page. Each tile is a tightly
 * styled fragment of real dashboard UI — not an icon block. Goal: a
 * skeptical reader can see *what the feature actually looks like in the
 * product* without leaving the page.
 */

type ProofKind =
  | 'reasoning-trace'
  | 'compliance-refusal'
  | 'ad-audit-decision'
  | 'client-approval'
  | 'auto-safe-band'
  | 'channel-format'
  | 'voice-signature'
  | 'cultural-calendar'
  | 'multi-locale';

export function FeatureProof({ kind }: { kind: ProofKind }) {
  switch (kind) {
    case 'reasoning-trace':
      return <ReasoningTrace />;
    case 'compliance-refusal':
      return <ComplianceRefusal />;
    case 'ad-audit-decision':
      return <AdAuditDecision />;
    case 'client-approval':
      return <ClientApproval />;
    case 'auto-safe-band':
      return <AutoSafeBand />;
    case 'channel-format':
      return <ChannelFormat />;
    case 'voice-signature':
      return <VoiceSignature />;
    case 'cultural-calendar':
      return <CulturalCalendar />;
    case 'multi-locale':
      return <MultiLocale />;
    default:
      return null;
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white dark:bg-ink-900 border border-ink-200/60 dark:border-ink-800 p-5 shadow-subtle">
      {children}
    </div>
  );
}

function ReasoningTrace() {
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <FileCheck className="h-4 w-4 text-accent-500" />
        <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">Reasoning trace</p>
        <span className="ml-auto text-[10px] font-mono text-ink-400">draft #1842</span>
      </div>
      <p className="text-sm text-ink-700 dark:text-ink-100 mb-3 font-medium leading-snug">
        &ldquo;Father&apos;s Day weekend — first 30 reservations get a complimentary pour-over.&rdquo;
      </p>
      <dl className="space-y-1.5 text-xs">
        <Row label="Framework" value="Hormozi value-stack" />
        <Row label="Awareness stage" value="problem-aware" />
        <Row label="Hook type" value="scarcity_with_proof" />
        <Row label="Past performance signal" value="+34% on similar pour-over launches" />
        <Row label="Voice fit" value="0.91 / 1.0" tone="good" />
        <Row label="Compliance" value="passed (5 gates)" tone="good" />
      </dl>
    </Card>
  );
}

function ComplianceRefusal() {
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <ShieldAlert className="h-4 w-4 text-red-500" />
        <p className="text-xs uppercase tracking-wider text-red-700 dark:text-red-400 font-medium">
          Refused
        </p>
        <span className="ml-auto text-[10px] font-mono text-ink-400">FDA / supplements</span>
      </div>
      <p className="text-sm text-ink-400 line-through mb-2 leading-snug">
        &ldquo;Cures chronic fatigue in 14 days — guaranteed.&rdquo;
      </p>
      <div className="rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200/60 dark:border-red-500/20 p-3">
        <p className="text-xs font-medium text-red-700 dark:text-red-300 mb-1">
          Banned claim: &ldquo;cures&rdquo;
        </p>
        <p className="text-xs text-red-800/80 dark:text-red-300/80 leading-snug">
          Suggested rewrite: &ldquo;Supports natural energy levels.&rdquo; FDA-compliant, passes
          three gates.
        </p>
      </div>
    </Card>
  );
}

function AdAuditDecision() {
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp className="h-4 w-4 text-accent-500" />
        <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">Ad audit · 09:14</p>
        <span className="ml-auto text-[10px] font-mono text-ink-400">meta · cafe-launch-04</span>
      </div>
      <p className="text-sm text-ink-700 dark:text-ink-100 mb-3 leading-snug">
        CTR dropped <span className="font-semibold text-amber-700 dark:text-amber-400">31%</span>{' '}
        over 4 days. Recommendation: refresh creative, not budget.
      </p>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <Cell label="Expected upside" value="+15% CTR" tone="good" />
        <Cell label="Risk" value="Low" />
        <Cell label="Confidence" value="84%" />
      </dl>
      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300 uppercase tracking-wider">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          Auto-executed
        </span>
        <span className="text-[10px] text-ink-400 font-mono">$0.30 cost</span>
      </div>
    </Card>
  );
}

function ClientApproval() {
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-accent-500" />
        <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">
          Client magic-link
        </p>
        <span className="ml-auto text-[10px] font-mono text-ink-400">tiranaroastery.al</span>
      </div>
      <p className="text-sm text-ink-700 dark:text-ink-100 mb-3 leading-snug">
        Maroa drafted 5 Instagram captions for Father&apos;s Day weekend.{' '}
        <span className="text-ink-400">All passed compliance.</span>
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full bg-ink-700 dark:bg-white text-white dark:text-ink-900"
        >
          <Check className="h-3 w-3" />
          Approve all 5
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full text-ink-400"
        >
          <X className="h-3 w-3" />
          Reject
        </button>
        <span className="text-[10px] text-ink-400 font-mono ml-auto">expires in 64h</span>
      </div>
    </Card>
  );
}

function AutoSafeBand() {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-4">
        Auto-safe banding
      </p>
      <ul className="space-y-3">
        <BandRow
          tone="green"
          label="Green — auto-publish"
          body="Low-stakes creative refresh on a campaign you&apos;ve already approved."
        />
        <BandRow
          tone="yellow"
          label="Yellow — notify operator"
          body="Brand-sensitive copy or new audience. Goes live after your tap."
        />
        <BandRow
          tone="red"
          label="Red — never auto-publish"
          body="Regulated industry, above-threshold spend, or first-time campaign."
        />
      </ul>
    </Card>
  );
}

function ChannelFormat() {
  const chips = [
    { name: 'Reels', count: 6 },
    { name: 'LinkedIn post', count: 1 },
    { name: 'Email promo', count: 1 },
    { name: 'TikTok hook', count: 3 },
    { name: 'Meta ad', count: 4 },
  ];
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-3">
        One idea → six surfaces
      </p>
      <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug mb-3 font-medium">
        Father&apos;s Day pour-over launch
      </p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span
            key={c.name}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100"
          >
            {c.name}
            <span className="text-ink-400 font-mono">{c.count}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function VoiceSignature() {
  const traits = [
    { label: 'Formality', value: 0.32 },
    { label: 'Energy', value: 0.74 },
    { label: 'Humor', value: 0.58 },
    { label: 'Technicality', value: 0.21 },
    { label: 'Sentence rhythm', value: 0.66 },
  ];
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-4">
        Voice signature
      </p>
      <ul className="space-y-2.5">
        {traits.map((t) => (
          <li key={t.label} className="flex items-center gap-3 text-xs">
            <span className="text-ink-400 w-32 flex-shrink-0">{t.label}</span>
            <div className="flex-1 h-1.5 rounded-full bg-ink-100 dark:bg-ink-800 overflow-hidden">
              <div
                className="h-full bg-accent-500 rounded-full"
                style={{ width: `${Math.round(t.value * 100)}%` }}
              />
            </div>
            <span className="font-mono text-ink-700 dark:text-ink-100 w-10 text-right">
              {t.value.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs text-ink-400">
        Drift &gt; 0.15 triggers automatic rewrite, not a warning.
      </p>
    </Card>
  );
}

function CulturalCalendar() {
  const rows = [
    { date: 'Sep 11', region: 'US', action: 'Pause promotional content', tone: 'amber' as const },
    { date: 'Ramadan', region: 'MENA', action: 'Alcohol marketing paused', tone: 'amber' as const },
    { date: 'Christmas', region: 'IT', action: 'Family-first tone', tone: 'green' as const },
    { date: 'Yom Kippur', region: 'IL', action: 'Auto-pause all', tone: 'amber' as const },
  ];
  return (
    <Card>
      <p className="text-xs uppercase tracking-wider text-ink-400 font-medium mb-3">
        Cultural calendar
      </p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.date + r.region}
            className="flex items-center gap-3 text-xs py-1.5 border-b border-ink-100 dark:border-ink-800 last:border-0"
          >
            <span className="font-mono text-ink-700 dark:text-ink-100 w-20">{r.date}</span>
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-100 font-mono">
              {r.region}
            </span>
            <span
              className={
                r.tone === 'amber'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-green-700 dark:text-green-400'
              }
            >
              {r.action}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function MultiLocale() {
  const samples = [
    {
      lang: 'SQ',
      label: 'Albanian café',
      copy: '“Mëngjes me byrek nga zonja Drita. Rruga e Durrësit, 8 të mëngjesit.”',
    },
    {
      lang: 'IT',
      label: 'Italian retail',
      copy: '“Saldi di mezza stagione. Solo questo weekend — ti aspettiamo.”',
    },
    { lang: 'AR', label: 'Saudi e-com', copy: '“توصيل خلال ساعتين داخل الرياض.”' },
  ];
  return (
    <Card>
      <div className="flex items-center gap-2 mb-3">
        <Globe2 className="h-4 w-4 text-accent-500" />
        <p className="text-xs uppercase tracking-wider text-ink-400 font-medium">
          Native, not translated
        </p>
      </div>
      <ul className="space-y-3">
        {samples.map((s) => (
          <li key={s.lang} className="flex items-start gap-3">
            <span className="font-mono text-[10px] text-ink-400 w-8 mt-1">{s.lang}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-ink-400">{s.label}</p>
              <p className="text-sm text-ink-700 dark:text-ink-100 leading-snug mt-0.5">{s.copy}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-400">{label}</dt>
      <dd
        className={
          tone === 'good'
            ? 'text-green-700 dark:text-green-400 font-medium'
            : 'text-ink-700 dark:text-ink-100 font-medium'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <div className="rounded-lg bg-ink-50 dark:bg-ink-800/60 px-2 py-1.5">
      <p className="text-[10px] text-ink-400 uppercase tracking-wider">{label}</p>
      <p
        className={
          tone === 'good'
            ? 'text-green-700 dark:text-green-400 font-semibold text-xs mt-0.5'
            : 'text-ink-700 dark:text-ink-100 font-semibold text-xs mt-0.5'
        }
      >
        {value}
      </p>
    </div>
  );
}

function BandRow({
  tone,
  label,
  body,
}: {
  tone: 'green' | 'yellow' | 'red';
  label: string;
  body: string;
}) {
  const tones = {
    green: 'bg-green-500',
    yellow: 'bg-amber-500',
    red: 'bg-red-500',
  } as const;
  return (
    <li className="flex items-start gap-3">
      <span className={`mt-1.5 h-2 w-2 rounded-full ${tones[tone]} flex-shrink-0`} />
      <div>
        <p className="text-sm font-semibold text-ink-700 dark:text-ink-100">{label}</p>
        <p className="text-xs text-ink-400 leading-snug mt-0.5">{body}</p>
      </div>
    </li>
  );
}
