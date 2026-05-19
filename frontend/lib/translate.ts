/**
 * lib/translate.ts
 * ---------------------------------------------------------------------------
 * Decision-log → plain English translation layer.
 *
 * The calm "Today" dashboard never shows raw agent_name + decision_type
 * to the customer. Those are operator-grade labels ("ad-optimizer",
 * "creative-engine.refresh", "competitor-watch.surge"). For a café owner
 * who hired Maroa precisely to NOT think about marketing, those labels
 * are noise.
 *
 * This module is the single place where Maroa's internal language is
 * translated into customer-facing sentences. Three outputs:
 *
 *   - `friendly(decision)` → one-sentence past-tense narration
 *     ("Paused your weekend lunch ad — it wasn't getting clicks.")
 *   - `approvalAsk(decision)` → one-sentence question for the approve card
 *     ("Approve this Instagram post for Friday?")
 *   - `categoryIcon(decision)` → Lucide icon name for the row
 *
 * The map is intentionally explicit so we can audit copy by reading one
 * file. New decision types added to the backend get a row here and ship
 * with friendly copy by default.
 *
 * If a decision type isn't mapped, we fall back to the
 * `recommendation_text` field as written by the backend — it's already
 * human-readable, just slightly more technical.
 * ---------------------------------------------------------------------------
 */

import type { DecisionLogRow } from '@/lib/types/war-room';

export type DecisionCategory =
  | 'content'
  | 'ads'
  | 'budget'
  | 'creative'
  | 'experiment'
  | 'competitor'
  | 'compliance'
  | 'audience'
  | 'report'
  | 'system';

interface TemplateEntry {
  category: DecisionCategory;
  /** Past tense, narrative — used in the "What I did" feed. */
  done: (d: DecisionLogRow) => string;
  /** Question — used on the approve card. */
  ask: (d: DecisionLogRow) => string;
}

const TEMPLATES: Record<string, TemplateEntry> = {
  // ad-optimizer
  'ad-optimizer.pause': {
    category: 'ads',
    done: () => `Paused an ad that wasn't getting clicks. Saved you money.`,
    ask: () => `Pause an ad that isn't getting clicks?`,
  },
  'ad-optimizer.scale': {
    category: 'ads',
    done: () => `Scaled up an ad that's performing well.`,
    ask: () => `Spend more on the ad that's doing best?`,
  },
  'ad-optimizer.keep': {
    category: 'ads',
    done: () => `Reviewed your ads. Nothing to change today.`,
    ask: () => `Keep things as they are?`,
  },
  'ad-optimizer.optimize': {
    category: 'ads',
    done: () => `Tweaked an ad's audience targeting to find better leads.`,
    ask: () => `Try a smarter audience for this ad?`,
  },
  'ad-optimizer.refresh_creative': {
    category: 'creative',
    done: () => `Asked for a fresh ad image — the old one was getting tired.`,
    ask: () => `Try a fresh ad image? The current one is getting tired.`,
  },

  // creative-engine / WF1
  'creative.draft_post': {
    category: 'content',
    done: () => `Drafted a new post for you.`,
    ask: () => `Approve this post?`,
  },
  'creative.publish_post': {
    category: 'content',
    done: () => `Published your post on Instagram.`,
    ask: () => `Publish this post on Instagram?`,
  },
  'creative.refresh': {
    category: 'creative',
    done: () => `Created new ad variants to test.`,
    ask: () => `Test new ad variants?`,
  },
  'creative.promote_winner': {
    category: 'experiment',
    done: () => `Promoted the winning variant — it beat the others by a clear margin.`,
    ask: () => `Promote the winning variant?`,
  },
  'creative.kill_loser': {
    category: 'experiment',
    done: () => `Retired a variant that wasn't working.`,
    ask: () => `Retire the variant that isn't working?`,
  },

  // budget / pacing
  'budget.alert': {
    category: 'budget',
    done: () => `Flagged a pacing issue with one of your ad budgets.`,
    ask: () => `Adjust the daily budget to stay on track this month?`,
  },
  'budget.cap_reached': {
    category: 'budget',
    done: () => `Hit the monthly budget cap and paused new spend.`,
    ask: () => `Raise the monthly cap so ads keep running?`,
  },

  // competitor
  'competitor.surge': {
    category: 'competitor',
    done: () => `Spotted a competitor running a new campaign — worth taking a look.`,
    ask: () => `Match the competitor's new campaign?`,
  },
  'competitor.copy_alert': {
    category: 'competitor',
    done: () => `A competitor used copy similar to yours. We changed yours to keep it fresh.`,
    ask: () => `Refresh your copy — a competitor is using something similar?`,
  },

  // compliance
  'compliance.block': {
    category: 'compliance',
    done: () => `Blocked a draft that would have broken platform rules.`,
    ask: () => `Approve a fix for a draft that broke a rule?`,
  },
  'compliance.warn': {
    category: 'compliance',
    done: () => `Flagged copy that might trip a platform rule. Rewrote it safer.`,
    ask: () => `Use the safer rewrite of this copy?`,
  },

  // audience / segments
  'audience.refine': {
    category: 'audience',
    done: () => `Refined your audience based on who's actually responding.`,
    ask: () => `Refine the audience to focus on who's actually responding?`,
  },
};

/**
 * Build a decision-type key from agent_name + decision_subtype if present,
 * else decision_type alone.
 */
function keyFor(d: DecisionLogRow): string {
  if (d.decision_subtype) return `${d.agent_name}.${d.decision_subtype}`;
  return `${d.agent_name}.${d.decision_type}`;
}

export function friendly(decision: DecisionLogRow): string {
  const k = keyFor(decision);
  const entry = TEMPLATES[k];
  if (entry) return entry.done(decision);
  // Last-resort fallback. Use the recommendation_text field which is
  // already vetted by the backend's copywriter persona.
  return decision.recommendation_text || 'Did some work on your marketing.';
}

export function approvalAsk(decision: DecisionLogRow): string {
  const k = keyFor(decision);
  const entry = TEMPLATES[k];
  if (entry) return entry.ask(decision);
  return decision.recommendation_text || 'Approve this?';
}

export function decisionCategory(decision: DecisionLogRow): DecisionCategory {
  const k = keyFor(decision);
  const entry = TEMPLATES[k];
  if (entry) return entry.category;
  // Heuristic fallback by agent_name prefix.
  const a = decision.agent_name || '';
  if (a.startsWith('ad-')) return 'ads';
  if (a.startsWith('creative')) return 'creative';
  if (a.startsWith('competitor')) return 'competitor';
  if (a.startsWith('compliance')) return 'compliance';
  if (a.startsWith('budget')) return 'budget';
  if (a.startsWith('audience')) return 'audience';
  if (a.startsWith('voc')) return 'audience';
  if (a.startsWith('wf6') || a.startsWith('weekly')) return 'report';
  return 'system';
}

/**
 * Plain-English description of "why this came up" — used inside the
 * reasoning-trace popover on each approve card. Surfaces the model's
 * stated upside + risk fields in customer language.
 */
export function whyExplanation(decision: DecisionLogRow): string {
  const bits: string[] = [];
  if (decision.expected_upside_text) {
    bits.push(`Why: ${decision.expected_upside_text}`);
  }
  if (decision.confidence > 0) {
    const pct = Math.round(decision.confidence * 100);
    bits.push(`Confidence: ${pct}%.`);
  }
  if (decision.risk_text) {
    bits.push(`Heads up: ${decision.risk_text}`);
  }
  return bits.join(' ') || 'I thought this was the right call given what worked before.';
}

/**
 * Time formatting that says "this morning" / "yesterday" / "Tuesday" /
 * "last week" rather than ISO timestamps.
 */
export function friendlyTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const ms = now.getTime() - t.getTime();
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(ms / 86_400_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 6) return `${hours}h ago`;
  // Same day, but earlier today
  if (now.toDateString() === t.toDateString()) {
    const period = t.getHours() < 12 ? 'this morning' : t.getHours() < 17 ? 'this afternoon' : 'this evening';
    return period;
  }
  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.toDateString() === t.toDateString()) return 'yesterday';
  // Within this week
  if (days < 7) return t.toLocaleDateString('en-US', { weekday: 'long' });
  if (days < 14) return 'last week';
  return t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Time-aware greeting ("Morning, Maria" / "Afternoon, Maria" / "Evening,
 * Maria") — small detail that signals the product knows the user is
 * a person, not a userID.
 */
export function greeting(firstName: string | null | undefined, now: Date = new Date()): string {
  const hour = now.getHours();
  const period = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const name = (firstName || '').trim();
  return name ? `${period}, ${name}.` : `${period}.`;
}
