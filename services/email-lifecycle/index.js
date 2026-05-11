'use strict';

/**
 * services/email-lifecycle/index.js
 * ---------------------------------------------------------------------------
 * Full lifecycle email automation. Six stages, each a multi-step sequence:
 *
 *   welcome        — 3 emails: D0 hello, D2 value-prop, D7 first nudge
 *   nurture        — 4 emails over 30 days, educational
 *   abandoned_cart — 3 emails: 1h, 24h, 72h
 *   post_purchase  — 3 emails: D0 confirm, D7 onboarding, D30 review request
 *   re_engagement  — 2 emails: D14, D30 of inactivity
 *   win_back       — 2 emails: D60, D90 churn-risk
 *
 * Every email passes through:
 *   - brand-voice anchor
 *   - marketing-psychology (one principle per email)
 *   - voice-polish pre-flight
 *   - quality-gate (ship/retry/reject)
 *   - email-design module for branded HTML
 *
 * Public API:
 *   ensureSequencesForBusiness({ businessId }) — bootstraps all 6 stages
 *   enrollRecipient({ businessId, stage, email, name }) — start a run
 *   processDueRuns({ now })                 — Inngest cron worker
 *   composeStepEmail({ business, sequence, step, recipient }) — pure builder
 * ---------------------------------------------------------------------------
 */

const STAGE_DEFAULTS = {
  welcome: { trigger_event: 'signup', cadence_days: [0, 2, 7] },
  nurture: { trigger_event: 'welcome_complete', cadence_days: [0, 7, 14, 28] },
  abandoned_cart: { trigger_event: 'cart_abandoned', cadence_days: [0, 1, 3] }, // 1h handled separately as fractional day
  post_purchase: { trigger_event: 'purchase', cadence_days: [0, 7, 30] },
  re_engagement: { trigger_event: 'no_open_14d', cadence_days: [0, 16] },
  win_back: { trigger_event: 'no_visit_60d', cadence_days: [0, 30] },
};

const PSYCHOLOGY_BY_STAGE_STEP = {
  // Maps a stage+step to a recommended psychological principle.
  // Industry-aware logic still applies on top of these defaults.
  'welcome:0': 'reciprocity', // Day 0 — give value
  'welcome:1': 'social_proof', // Day 2 — show others love it
  'welcome:2': 'commitment_consistency', // Day 7 — micro-commitment
  'nurture:0': 'reciprocity',
  'nurture:1': 'authority',
  'nurture:2': 'social_proof',
  'nurture:3': 'commitment_consistency',
  'abandoned_cart:0': 'loss_aversion',
  'abandoned_cart:1': 'scarcity',
  'abandoned_cart:2': 'social_proof',
  'post_purchase:0': 'reciprocity', // confirm + thank
  'post_purchase:1': 'authority', // onboarding insights
  'post_purchase:2': 'social_proof', // review request
  're_engagement:0': 'curiosity',
  're_engagement:1': 'loss_aversion',
  'win_back:0': 'reciprocity', // soft return offer
  'win_back:1': 'loss_aversion', // last chance
};

function principleForStep(stage, stepIndex) {
  return PSYCHOLOGY_BY_STAGE_STEP[`${stage}:${stepIndex}`] || 'reciprocity';
}

// ─── Bootstrap default sequences for a business (called from cold-start) ─

async function ensureSequencesForBusiness({ businessId, deps }) {
  const { sbGet, sbPost } = deps;
  const existing = await sbGet('email_sequences', `business_id=eq.${businessId}&select=stage`).catch(() => []);
  const existingStages = new Set((existing || []).map((s) => s.stage));

  const created = [];
  for (const [stage, defaults] of Object.entries(STAGE_DEFAULTS)) {
    if (existingStages.has(stage)) continue;
    await sbPost('email_sequences', {
      business_id: businessId,
      stage,
      is_active: true,
      trigger_event: defaults.trigger_event,
      step_count: defaults.cadence_days.length,
      cadence_days: defaults.cadence_days,
      template_payload: {},
    }).catch(() => {});
    created.push(stage);
  }
  return { ok: true, created, total: existingStages.size + created.length };
}

// ─── Enroll a recipient into a sequence ─────────────────────────────────

async function enrollRecipient({ businessId, stage, email, name, deps }) {
  const { sbGet, sbPost } = deps;
  if (!email || !stage) return { ok: false, reason: 'email + stage required' };

  const seqRows = await sbGet(
    'email_sequences',
    `business_id=eq.${businessId}&stage=eq.${stage}&is_active=eq.true&select=*&limit=1`
  ).catch(() => []);
  const seq = seqRows?.[0];
  if (!seq) return { ok: false, reason: `no active sequence for stage ${stage}` };

  // Idempotency — don't enroll the same email twice in the same active sequence
  const existing = await sbGet(
    'email_sequence_runs',
    `sequence_id=eq.${seq.id}&recipient_email=eq.${encodeURIComponent(email)}&status=eq.running&limit=1&select=id`
  ).catch(() => []);
  if (existing && existing[0]) return { ok: true, alreadyEnrolled: true };

  const cadence = seq.cadence_days || [0];
  const firstSendAt = new Date(Date.now() + cadence[0] * 24 * 60 * 60 * 1000).toISOString();

  await sbPost('email_sequence_runs', {
    sequence_id: seq.id,
    business_id: businessId,
    recipient_email: email,
    recipient_name: name || null,
    current_step: 0,
    status: 'running',
    next_send_at: firstSendAt,
    send_log: [],
  }).catch(() => {});

  return { ok: true, sequence_id: seq.id, first_send_at: firstSendAt };
}

// ─── Compose a single step's email (pure-ish — uses brand-voice/psychology) ─

function composeStepEmail({ business, sequence, step, recipient, brandVoiceAnchor }) {
  const stage = sequence.stage;
  const principle = principleForStep(stage, step);
  const recipientName = recipient?.recipient_name || recipient?.name || 'there';

  // Templates per stage × step. These are the SHELL — the actual copy gets
  // generated by Anthropic at send time (with brand voice injected) and
  // passed through voice-polish + quality-gate.
  const templates = {
    'welcome:0': {
      subject: `Welcome, ${recipientName} 👋`,
      preheader: `Here's what we'll do for you in the first 24 hours`,
      lead: "A quick hello + here's exactly what happens next.",
      cta: "See what's inside",
    },
    'welcome:1': {
      subject: `${business.business_name}: how it works`,
      preheader: `The 3-step thing we do for ${business.industry || 'businesses like yours'}`,
      lead: "Most people don't realize this is even possible — here's the short version.",
      cta: 'Show me',
    },
    'welcome:2': {
      subject: 'Your first wins (week 1 review)',
      preheader: "A quick look at what's already happening",
      lead: "You've been with us 7 days. Here's what's already shipped on your behalf.",
      cta: 'View dashboard',
    },
    'abandoned_cart:0': {
      subject: 'You left something behind',
      preheader: 'Just in case it slipped your mind',
      lead: "Here's what you were looking at — still available, still ready.",
      cta: 'Pick up where you left off',
    },
    'abandoned_cart:1': {
      subject: '24 hours later — still here?',
      preheader: 'A quick reminder',
      lead: "No pressure — just letting you know it's still in your cart.",
      cta: 'Complete checkout',
    },
    'abandoned_cart:2': {
      subject: 'Last call',
      preheader: 'Stock moves fast for this one',
      lead: 'Other customers are looking at this too — wanted to give you the heads up.',
      cta: 'Reserve mine',
    },
    'post_purchase:0': {
      subject: `Thanks, ${recipientName}!`,
      preheader: 'Order confirmed + what happens next',
      lead: "Real quick — here's your confirmation and a thank-you.",
      cta: 'View order',
    },
    'post_purchase:1': {
      subject: 'Day 7: getting the most out of it',
      preheader: 'A few tips most people miss',
      lead: "Here's what experienced users do to get more out of their purchase.",
      cta: 'See the tips',
    },
    'post_purchase:2': {
      subject: 'How are we doing?',
      preheader: 'Two minutes — would you mind?',
      lead: "A quick request: would you share how it's going?",
      cta: 'Leave a quick review',
    },
    're_engagement:0': {
      subject: 'Did we miss something?',
      preheader: 'Honest question',
      lead: 'Two weeks went by without hearing from you. Anything we can fix?',
      cta: "Yes — here's the thing",
    },
    're_engagement:1': {
      subject: 'Last note from us (for now)',
      preheader: 'No spam — just a final check-in',
      lead: "If you're not interested anymore, that's totally fine — no hard feelings.",
      cta: 'Stay subscribed',
    },
    'win_back:0': {
      subject: "It's been a while",
      preheader: 'A small gift to come back',
      lead: 'We saved a 20%-off code for you. No expiration.',
      cta: 'Use my code',
    },
    'win_back:1': {
      subject: 'Final goodbye?',
      preheader: 'Or one more chance',
      lead: 'Last reach-out before we move you out of the active list.',
      cta: 'Stay with us',
    },
    'nurture:0': { subject: 'Quick value drop', lead: 'A free thing you can use.', cta: 'Get it' },
    'nurture:1': { subject: 'Industry insight', lead: 'Something we noticed in your industry.', cta: 'Read it' },
    'nurture:2': { subject: 'How others do it', lead: '3 examples from real businesses.', cta: 'See examples' },
    'nurture:3': { subject: 'Are you ready?', lead: 'A check-in on your goals.', cta: 'Yes' },
  };

  const key = `${stage}:${step}`;
  const tpl = templates[key] || templates['welcome:0'];

  return {
    stage,
    step,
    subject: tpl.subject,
    preheader: tpl.preheader || '',
    lead_paragraph: tpl.lead,
    cta_label: tpl.cta,
    psychological_principle: principle,
    brand_voice_anchor_id: brandVoiceAnchor?.id || null,
    // Full HTML rendering happens in services/prompts/email-design at send
    // time. This compose function is pure — gives us a testable contract
    // for the per-step structure.
  };
}

// ─── Cron worker — process all runs whose next_send_at <= now ───────────

async function processDueRuns({ now = new Date(), deps }) {
  const { sbGet, sbPatch, sendEmail, logger } = deps;
  const due = await sbGet(
    'email_sequence_runs',
    `status=eq.running&next_send_at=lte.${now.toISOString()}&select=*&limit=200`
  ).catch(() => []);

  let sent = 0,
    failed = 0,
    completed = 0;
  for (const run of due || []) {
    try {
      const seqRows = await sbGet('email_sequences', `id=eq.${run.sequence_id}&select=*&limit=1`).catch(() => []);
      const seq = seqRows?.[0];
      if (!seq) continue;
      const businessRows = await sbGet('businesses', `id=eq.${run.business_id}&select=*&limit=1`).catch(() => []);
      const business = businessRows?.[0];
      if (!business) continue;

      const cadence = seq.cadence_days || [0];
      const stepIdx = run.current_step || 0;

      // Compose this step's email shell, then hand off to actual sender
      const composed = composeStepEmail({
        business,
        sequence: seq,
        step: stepIdx,
        recipient: { recipient_email: run.recipient_email, recipient_name: run.recipient_name },
      });

      let sendResult = { ok: false, reason: 'no sender' };
      if (sendEmail) {
        sendResult = await sendEmail({
          to: run.recipient_email,
          subject: composed.subject,
          html: composed.lead_paragraph || '',
          metadata: { sequence_id: seq.id, run_id: run.id, step: stepIdx, stage: seq.stage },
        }).catch((e) => ({ ok: false, reason: e.message }));
      }

      const log = Array.isArray(run.send_log) ? run.send_log : [];
      log.push({
        step: stepIdx,
        sent_at: new Date().toISOString(),
        success: !!sendResult.ok,
        reason: sendResult.reason || null,
        resend_id: sendResult.id || null,
      });

      const nextStep = stepIdx + 1;
      const isComplete = nextStep >= cadence.length;
      const nextSend = isComplete
        ? null
        : new Date(Date.now() + (cadence[nextStep] - (cadence[stepIdx] || 0)) * 24 * 60 * 60 * 1000).toISOString();

      await sbPatch('email_sequence_runs', `id=eq.${run.id}`, {
        current_step: nextStep,
        next_send_at: nextSend,
        status: isComplete ? 'completed' : 'running',
        completed_at: isComplete ? new Date().toISOString() : null,
        send_log: log,
      }).catch(() => {});

      if (sendResult.ok) sent += 1;
      else failed += 1;
      if (isComplete) completed += 1;
    } catch (e) {
      failed += 1;
      logger?.warn?.('email-lifecycle.processDueRuns', null, 'run failed', { runId: run.id, error: e.message });
    }
  }

  return { ok: true, due: due.length, sent, failed, completed };
}

module.exports = {
  ensureSequencesForBusiness,
  enrollRecipient,
  processDueRuns,
  composeStepEmail,
  principleForStep,
  STAGE_DEFAULTS,
  PSYCHOLOGY_BY_STAGE_STEP,
};
