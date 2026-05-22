'use strict';

/**
 * services/autopilot-brain/index.js
 * ---------------------------------------------------------------------------
 * The Autopilot Brain — top-level orchestrator. Runs every morning at
 * 08:00 UTC per business. Pulls signals from all 11 capability pillars,
 * resolves conflicts, narrates the plan in the customer's brand voice,
 * delivers the daily brief.
 *
 * Decision sources (cross-domain):
 *   - ad-optimizer            scale/pause decisions per campaign
 *   - measurement-health      trust verdicts per platform
 *   - creative-engine         today's variant generation + evaluations
 *   - competitor-watch        recent alerts / critical signals
 *   - citation-tracker        share-of-voice + gaps
 *   - voc / pacing-alerts     fresh customer signals
 *   - cold-start              if the business is still onboarding
 *
 * Cross-domain conflict examples this brain prevents:
 *   - Don't pause an ad while creative-engine wants to launch a refresh
 *     for the same campaign
 *   - Don't scale a Meta campaign on the same day measurement-health
 *     flagged Meta EMQ broken
 *   - Don't email a re-engagement when post_purchase is mid-sequence
 *
 * Public API:
 *   runDaily({ businessId })         — orchestrate one business's day
 *   runDailyForAll()                  — Inngest cron fanout
 *   composeBrief({ snapshot, decisions, brandVoice }) — pure narrator
 * ---------------------------------------------------------------------------
 */

// ─── Signal collection ───────────────────────────────────────────────────

async function collectSignals({ businessId, deps }) {
  const { sbGet } = deps;
  const today = new Date();
  const yesterdayISO = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysISO = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Run all signal pulls in parallel — each is best-effort, missing tables
  // gracefully degrade to empty.
  const [
    business,
    measurementHealth,
    pendingDecisions,
    creativeStats,
    competitorSignals,
    citationStats,
    pacingAlerts,
    coldStartRun,
    autopilotYesterday,
  ] = await Promise.all([
    sbGet(
      'businesses',
      `id=eq.${businessId}&select=id,business_name,email,plan,crisis_status,growth_engine_recommendation,marketing_strategy`
    ).catch(() => []),
    sbGet(
      'measurement_health',
      `business_id=eq.${businessId}&recorded_at=gte.${yesterdayISO}&order=recorded_at.desc&select=platform,health_verdict,trust_for_scaling,reasons&limit=10`
    ).catch(() => []),
    sbGet(
      'ad_campaigns',
      `business_id=eq.${businessId}&select=id,status,last_decision,last_decision_reason,last_optimized_at&limit=20`
    ).catch(() => []),
    sbGet(
      'ad_creative_variants',
      `business_id=eq.${businessId}&created_at=gte.${sevenDaysISO}&select=status&limit=200`
    ).catch(() => []),
    sbGet(
      'competitor_signals',
      `business_id=eq.${businessId}&observed_at=gte.${sevenDaysISO}&severity=in.(alert,critical)&select=*&limit=50`
    ).catch(() => []),
    sbGet(
      'ai_citations',
      `business_id=eq.${businessId}&observed_at=gte.${yesterdayISO}&select=brand_cited&limit=200`
    ).catch(() => []),
    sbGet('pacing_alerts', `business_id=eq.${businessId}&fired_at=gte.${yesterdayISO}&select=*&limit=20`).catch(
      () => []
    ),
    sbGet('cold_start_runs', `business_id=eq.${businessId}&select=status,current_phase,display_state&limit=1`).catch(
      () => []
    ),
    sbGet(
      'autopilot_runs',
      `business_id=eq.${businessId}&order=run_date.desc&limit=1&select=decisions,brief_text`
    ).catch(() => []),
  ]);

  // Aggregate creative engine stats
  const creativeAgg = {};
  for (const row of creativeStats || []) {
    creativeAgg[row.status] = (creativeAgg[row.status] || 0) + 1;
  }

  // Aggregate citation stats
  const citationsTotal = (citationStats || []).length;
  const citationsCited = (citationStats || []).filter((r) => r.brand_cited).length;

  return {
    business: business?.[0] || null,
    measurement_health: measurementHealth || [],
    pending_campaign_decisions: pendingDecisions || [],
    creative_engine_7d: creativeAgg,
    competitor_alerts_7d: competitorSignals || [],
    citation_run_24h: {
      total: citationsTotal,
      cited: citationsCited,
      cite_rate: citationsTotal > 0 ? citationsCited / citationsTotal : 0,
    },
    pacing_alerts_24h: pacingAlerts || [],
    cold_start: coldStartRun?.[0] || null,
    yesterday_brief: autopilotYesterday?.[0]?.brief_text || null,
    yesterday_decisions: autopilotYesterday?.[0]?.decisions || [],
  };
}

// ─── Cross-domain conflict resolution ────────────────────────────────────

/**
 * Given the proposed decisions per domain, detect and resolve conflicts.
 * Pure function — no side effects.
 */
function resolveConflicts({ snapshot, proposed }) {
  const conflicts = [];
  const final = [];
  const blockedReasons = {};

  // Block all SCALE decisions on Meta if measurement health says Meta is broken
  const metaHealth = (snapshot?.measurement_health || []).find((m) => m.platform === 'meta');
  const metaTrust = metaHealth ? metaHealth.trust_for_scaling : null;

  for (const d of proposed || []) {
    if (
      d.domain === 'ad-optimizer' &&
      d.platform === 'meta' &&
      /scale|increase/i.test(d.action) &&
      metaTrust === false
    ) {
      conflicts.push({
        domain: d.domain,
        action: d.action,
        blocked_by: 'measurement-health',
        reason: 'Meta EMQ + dedup unhealthy — scaling decisions untrustworthy until pixel/CAPI fixed',
      });
      blockedReasons['ad-optimizer:meta:scale'] = 'measurement_unhealthy';
      continue;
    }
    final.push(d);
  }

  // Block re-engagement email if post_purchase sequence is mid-flight (within
  // 30 days of a post_purchase send)
  const hasRecentPostPurchase = (snapshot?.yesterday_decisions || []).some(
    (d) => d.domain === 'email-lifecycle' && d.stage === 'post_purchase'
  );
  for (let i = final.length - 1; i >= 0; i -= 1) {
    const d = final[i];
    if (d.domain === 'email-lifecycle' && d.stage === 're_engagement' && hasRecentPostPurchase) {
      conflicts.push({
        domain: d.domain,
        action: 'enroll_re_engagement',
        blocked_by: 'email-lifecycle',
        reason: 'post_purchase sequence still active — re_engagement would create channel fatigue',
      });
      final.splice(i, 1);
    }
  }

  return { final, conflicts, blockedReasons };
}

// ─── Plan composer (deterministic — turns signals into proposed decisions) ─

function composeProposedDecisions({ snapshot }) {
  const out = [];

  const crisis = snapshot?.business?.crisis_status;
  if (crisis && crisis !== 'healthy') {
    out.push({
      domain: 'ops-maintenance',
      action: 'address_crisis',
      crisis_level: crisis,
      priority: 'highest',
    });
  }

  // Cold-start status takes priority — if onboarding is mid-flight, the
  // brain narrates the next step and yields to the cold-start orchestrator.
  if (snapshot.cold_start && snapshot.cold_start.status !== 'completed') {
    out.push({
      domain: 'cold-start',
      action: 'continue_onboarding',
      detail: snapshot.cold_start.display_state || {},
      priority: 'highest',
    });
    return out;
  }

  // Pacing alerts (fresh in last 24h)
  for (const a of snapshot.pacing_alerts_24h || []) {
    out.push({
      domain: 'pacing-alerts',
      action: 'address',
      alert_type: a.alert_type,
      detail: a.detail || {},
      priority: 'high',
    });
  }

  // Competitor alerts at critical severity
  for (const c of (snapshot.competitor_alerts_7d || []).filter((s) => s.severity === 'critical')) {
    out.push({
      domain: 'competitor-watch',
      action: 'react',
      competitor: c.competitor_name,
      signal: c.signal_type,
      priority: 'high',
    });
  }

  // Daily creative engine — variant evaluation kick-off (just signals "we'll
  // run it" — the actual cron is a separate Inngest function at 09:00)
  out.push({ domain: 'creative-engine', action: 'generate_today', priority: 'normal' });

  // Citation tracker daily run signal
  if (snapshot.citation_run_24h && snapshot.citation_run_24h.total > 0) {
    out.push({
      domain: 'citation-tracker',
      action: 'review_results',
      cite_rate: snapshot.citation_run_24h.cite_rate,
      priority: 'low',
    });
  }

  return out;
}

// ─── The customer-facing 1-paragraph brief ───────────────────────────────

function composeBrief({ snapshot, decisions, conflicts, brandVoice }) {
  const lines = [];
  const businessName = snapshot?.business?.business_name || 'your business';

  // Lead — set the day's tone
  if (snapshot?.cold_start && snapshot.cold_start.status !== 'completed') {
    const phase = snapshot.cold_start.current_phase || 'onboarding';
    const pct = snapshot.cold_start.display_state?.pct_complete || 0;
    lines.push(
      `This morning, ${businessName} is still in onboarding (${pct}% complete, on the ${phase.replace(/_/g, ' ')} step).`
    );
  } else {
    lines.push(`Here's what we did for ${businessName} yesterday and what we're doing today.`);
  }

  const crisis = snapshot?.business?.crisis_status;
  if (crisis && crisis !== 'healthy') {
    lines.push(
      `We're actively managing a ${crisis} marketing alert — check your dashboard for the recovery plan we sent overnight.`
    );
  }

  const growthRec = snapshot?.business?.growth_engine_recommendation;
  if (growthRec) {
    try {
      const parsed = typeof growthRec === 'string' ? JSON.parse(growthRec) : growthRec;
      const lever = parsed?.recommended_action?.lever;
      if (lever) lines.push(`This week's growth focus: ${lever}.`);
    } catch {
      /* soft-fail */
    }
  }

  // Pacing/competitor highlights
  const pacing = (snapshot?.pacing_alerts_24h || []).length;
  const critical = (snapshot?.competitor_alerts_7d || []).filter((s) => s.severity === 'critical').length;
  if (pacing > 0) {
    lines.push(
      `We caught ${pacing} pacing issue${pacing > 1 ? 's' : ''} on your ad spend overnight and adjusted accordingly.`
    );
  }
  if (critical > 0) {
    lines.push(`Two competitors made significant moves — we're matching where it makes sense.`);
  }

  // Conflicts that blocked an action — IMPORTANT to be honest about
  if (conflicts && conflicts.length > 0) {
    const measurementBlocks = conflicts.filter((c) => c.blocked_by === 'measurement-health').length;
    if (measurementBlocks > 0) {
      lines.push(
        `Heads up: tracking is degraded on one of your ad platforms — we're holding off on scale changes there until it's fixed (we'll keep monitoring).`
      );
    }
  }

  // Citation tracking
  const cite = snapshot?.citation_run_24h;
  if (cite && cite.total > 0) {
    const pct = Math.round(cite.cite_rate * 100);
    lines.push(`Yesterday's AI search check ran ${cite.total} queries; you were cited in ${pct}% of them.`);
  }

  // Sign-off
  lines.push(`Reply to this email if anything looks off.`);

  return lines.join(' ');
}

// ─── Run for one business ────────────────────────────────────────────────

async function runDaily({ businessId, deps }) {
  const { sbGet, sbPost, logger, sentry, sendEmail, voicePolish, brandVoiceService, qualityGate } = deps;
  const today = new Date();
  const todayDate = today.toISOString().slice(0, 10);

  // Idempotency — only one autopilot_runs row per (business, date)
  const existing = await sbGet(
    'autopilot_runs',
    `business_id=eq.${businessId}&run_date=eq.${todayDate}&select=id,status&limit=1`
  ).catch(() => []);
  if (existing && existing[0] && existing[0].status === 'completed') {
    return { ok: true, alreadyRan: true, run_id: existing[0].id };
  }

  const snapshot = await collectSignals({ businessId, deps });
  if (!snapshot.business) return { ok: false, reason: 'business not found' };

  const proposed = composeProposedDecisions({ snapshot });
  const { final: decisions, conflicts } = resolveConflicts({ snapshot, proposed });

  // Brand-voice anchor (so the brief sounds like the customer's brand,
  // not generic AI marketing speak)
  let brandVoice = null;
  try {
    const anchorRows = await sbGet(
      'brand_voice_anchors',
      `business_id=eq.${businessId}&order=created_at.desc&limit=1&select=anchor`
    ).catch(() => []);
    brandVoice = anchorRows?.[0]?.anchor || null;
  } catch (e) {
    /* soft-fail — see ADR-0003 for empty-catch cleanup plan */
  }

  let brief = composeBrief({ snapshot, decisions, conflicts, brandVoice });

  // Pass through voice-polish if available (strips AI-slop, anchors to brand)
  if (voicePolish?.detect) {
    try {
      const polished = await voicePolish.detect?.({ text: brief, brandVoiceAnchor: brandVoice });
      if (polished?.rewritten) brief = polished.rewritten;
    } catch (e) {
      logger?.warn?.('autopilot-brain.runDaily', businessId, 'voice-polish failed', { error: e.message });
    }
  }

  // Pass through quality-gate (refuses to ship slop)
  if (qualityGate?.evaluate) {
    try {
      const gate = await qualityGate.evaluate?.({ text: brief, contentType: 'daily_brief', businessId, deps });
      if (gate && gate.decision === 'reject') {
        // If quality gate rejects, fall back to a simpler factual brief
        brief = `Daily update for ${snapshot.business.business_name}. ${decisions.length} actions taken across paid ads, content, and SEO. View full details in your dashboard.`;
      }
    } catch (e) {
      logger?.warn?.('autopilot-brain.runDaily', businessId, 'quality-gate failed', { error: e.message });
    }
  }

  // Distill learnings into brain_memory (Dreaming-style curation)
  try {
    const { createAgentDreamingService } = require('../agent-dreaming');
    const dreaming = createAgentDreamingService({
      sbGet,
      sbPost,
      sbPatch: deps.sbPatch,
      memoryService: deps.memoryService,
      logger,
    });
    await dreaming.distillAutopilotLearnings({ businessId, snapshot, decisions });
  } catch (e) {
    logger?.warn?.('autopilot-brain.runDaily', businessId, 'dreaming distill failed', { error: e.message });
  }

  // Persist the run
  await sbPost('autopilot_runs', {
    business_id: businessId,
    run_date: todayDate,
    signals_snapshot: snapshot,
    decisions,
    conflicts_resolved: conflicts,
    brief_text: brief,
    status: 'completed',
    completed_at: new Date().toISOString(),
  }).catch((e) => logger?.warn?.('autopilot-brain.runDaily', businessId, 'persist failed', { error: e.message }));

  // P1-7 (audit 2026-05-20): mirror each composed decision into
  // decision_logs so the War Room UI surfaces them as pending approvals.
  // Pre-2026-05-20 the autopilot ran daily, emailed the brief, but never
  // populated the human-in-the-loop queue.
  for (const d of decisions) {
    if (!d || !d.action) continue;
    try {
      await sbPost('decision_logs', {
        business_id: businessId,
        agent_name: 'autopilot-brain',
        decision_type: d.action,
        decision_subtype: d.kind || d.subtype || null,
        inputs: d.inputs || d.signals || {},
        trigger: 'cron',
        recommendation_text: d.recommendation || d.summary || d.action || 'autopilot proposal',
        confidence: typeof d.confidence === 'number' ? d.confidence : 0.6,
        expected_upside_text: d.expected_upside || null,
        cost_usd: typeof d.cost_usd === 'number' ? d.cost_usd : 0,
        auto_safe_band: d.band || 'yellow',
        required_approval: d.required_approval !== false, // default: needs human eyes
      });
    } catch (e) {
      logger?.warn?.('autopilot-brain.runDaily', businessId, 'decision_log write failed', {
        error: e.message,
        action: d.action,
      });
    }
  }

  // Send the brief
  if (sendEmail && snapshot.business.email) {
    await sendEmail({
      to: snapshot.business.email,
      subject: `${snapshot.business.business_name} — your daily Maroa update`,
      html: `<p>${brief.replace(/\n/g, '</p><p>')}</p>`,
      metadata: { source: 'autopilot-brain', business_id: businessId, date: todayDate },
    }).catch((e) => logger?.warn?.('autopilot-brain.runDaily', businessId, 'email send failed', { error: e.message }));
  }

  return {
    ok: true,
    decisions: decisions.length,
    conflicts_resolved: conflicts.length,
    brief_chars: brief.length,
  };
}

module.exports = {
  runDaily,
  collectSignals,
  composeProposedDecisions,
  resolveConflicts,
  composeBrief,
};
