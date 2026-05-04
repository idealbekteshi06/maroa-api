/*
 * services/wf13/engine.js
 * ----------------------------------------------------------------------------
 * WF13 Weekly Strategy Brief engine — runs the 3-phase pipeline:
 *
 *   Phase 1: gather WeeklyContextBundle  (contextBundle.gatherBundle)
 *   Phase 2: strategic synthesis via Claude Opus (buildStrategicSynthesisPrompt)
 *   Phase 3: client-voice polish via Claude Sonnet (buildClientVoicePrompt)
 *
 * Persists to weekly_briefs + brief_plan_actions. Handles review_first
 * approval gate and auto_send delivery.
 * ----------------------------------------------------------------------------
 */

'use strict';

const {
  buildStrategicSynthesisPrompt,
  buildClientVoicePrompt,
  WF13_GUARDRAILS,
  WF13_AUTONOMY_MODES,
} = require('../prompts/workflow_13_weekly_brief.js');

function createEngine({
  sbGet, sbPost, sbPatch,
  callClaude, extractJSON,
  logger,
  aggregator,
  buildBrandContext,
  sendEmail,
  sendWhatsApp,
}) {
  async function resolveBrandContext(businessId) {
    const [bizRows, profileRows] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    const business = bizRows[0];
    if (!business) throw new Error(`Business not found: ${businessId}`);
    return buildBrandContext({ business, profile: profileRows[0] || {} });
  }

  async function getDeliverySettings(businessId) {
    const rows = await sbGet('brief_delivery_settings', `business_id=eq.${businessId}&select=*`).catch(() => []);
    return rows[0] || {
      autonomy_mode: 'review_first',
      channels: ['email', 'dashboard_only'],
      recipients: [],
      delivery_day: 'monday',
      delivery_local_time: '07:00',
      preferred_length: 'standard',
      tone_preference: 'direct',
      technical_depth: 'intermediate',
      language: 'English',
    };
  }

  async function runSynthesis({ businessId, weekStart, force = false }) {
    const brandContext = await resolveBrandContext(businessId);
    const bundle = await aggregator.gatherBundle({ businessId, weekStart });
    const settings = await getDeliverySettings(businessId);

    // Idempotency: one brief per business per week unless force
    const existing = await sbGet(
      'weekly_briefs',
      `business_id=eq.${businessId}&week_start=eq.${bundle.weekStart}&select=id,status,deliverable`
    ).catch(() => []);
    if (existing[0] && !force && existing[0].status !== 'failed') {
      logger?.info('/wf13/engine', businessId, 'brief already exists for week', {
        brief_id: existing[0].id,
        status: existing[0].status,
      });
      return { briefId: existing[0].id, status: existing[0].status, reused: true };
    }

    // Phase 1: persist the brief row in aggregating state
    let briefRow;
    if (existing[0]) {
      await sbPatch('weekly_briefs', `id=eq.${existing[0].id}`, {
        status: 'aggregating',
        context_bundle: bundle,
        updated_at: new Date().toISOString(),
      });
      briefRow = { id: existing[0].id };
    } else {
      briefRow = await sbPost('weekly_briefs', {
        business_id: businessId,
        week_start: bundle.weekStart,
        week_end: bundle.weekEnd,
        status: 'aggregating',
        context_bundle: bundle,
        autonomy_mode_snapshot: settings.autonomy_mode,
      });
    }

    try {
      // Phase 2: synthesis
      await sbPatch('weekly_briefs', `id=eq.${briefRow.id}`, { status: 'synthesizing', updated_at: new Date().toISOString() });
      const synthesisPrompt = buildStrategicSynthesisPrompt(brandContext, bundle);
      const synthesisRaw = await callClaude(synthesisPrompt.user, 'claude-opus-4-7', 5000, {
        system: synthesisPrompt.system,
        businessId,
        returnRaw: true,
      });
      const synthesis = extractJSON(synthesisRaw) || {};

      // Validate synthesis guardrails
      if ((synthesis.dataSources || []).length < WF13_GUARDRAILS.minDataSources) {
        logger?.warn('/wf13/engine', businessId, 'synthesis missing data sources', { count: (synthesis.dataSources || []).length });
      }

      // Phase 3: polish
      await sbPatch('weekly_briefs', `id=eq.${briefRow.id}`, { status: 'polishing', synthesis, updated_at: new Date().toISOString() });
      const polishPrompt = buildClientVoicePrompt(brandContext, synthesis);
      const polishRaw = await callClaude(polishPrompt.user, 'claude-sonnet-4-5', 4000, {
        system: polishPrompt.system,
        businessId,
        returnRaw: true,
      });
      const deliverable = extractJSON(polishRaw) || {};

      // Decide final status
      const nextStatus =
        settings.autonomy_mode === 'auto_send' ? 'approved' :
        settings.autonomy_mode === 'manual' ? 'awaiting_review' :
        'awaiting_review';

      await sbPatch('weekly_briefs', `id=eq.${briefRow.id}`, {
        status: nextStatus,
        deliverable,
        subject_line: deliverable.subjectLine || synthesis.headline,
        headline: synthesis.headline,
        word_count: synthesis.wordCountEstimate || null,
        model_used_synthesis: 'claude-opus-4-7',
        model_used_polish: 'claude-sonnet-4-5',
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Persist plan actions
      for (const a of synthesis.nextWeekPlan || []) {
        await sbPost('brief_plan_actions', {
          brief_id: briefRow.id,
          business_id: businessId,
          action: a.action,
          why_now: a.whyNow,
          expected_impact_low: a.expectedImpact?.low || null,
          expected_impact_high: a.expectedImpact?.high || null,
          impact_metric: a.expectedImpact?.metric || a.metric,
          effort_hours: a.effortHours || null,
          owner: a.owner || 'ai',
          deadline: a.deadline || null,
          one_click_approve: a.oneClickApprove !== false,
        }).catch(() => {});
      }

      // Write event + approval if review_first
      await sbPost('events', {
        business_id: businessId,
        kind: 'wf13.brief.generated',
        workflow: '13_weekly_brief',
        payload: {
          brief_id: briefRow.id,
          week_start: bundle.weekStart,
          autonomy_mode: settings.autonomy_mode,
          status: nextStatus,
        },
        severity: 'info',
      }).catch(() => {});

      if (nextStatus === 'awaiting_review') {
        await sbPost('approvals', {
          business_id: businessId,
          workflow: '13_weekly_brief',
          entity_type: 'brief',
          entity_id: briefRow.id,
          preview: {
            title: synthesis.headline,
            body: deliverable.tldr?.headline || '',
            subject_line: deliverable.subjectLine,
            rationale: synthesis.biggestInsight,
          },
          status: 'pending',
          priority: 80,
          sla_at: new Date(Date.now() + 9 * 3600000).toISOString(), // 9 hours
        }).catch(() => {});
      }

      return { briefId: briefRow.id, status: nextStatus };
    } catch (e) {
      logger?.error('/wf13/engine', businessId, 'brief generation failed', e);
      await sbPatch('weekly_briefs', `id=eq.${briefRow.id}`, {
        status: 'failed',
        error_message: e.message,
      }).catch(() => {});
      throw e;
    }
  }

  async function deliverBrief({ briefId }) {
    const [briefRows] = await Promise.all([
      sbGet('weekly_briefs', `id=eq.${briefId}&select=*`),
    ]);
    const brief = briefRows[0];
    if (!brief) throw new Error(`Brief not found: ${briefId}`);

    const settings = await getDeliverySettings(brief.business_id);
    const bizRows = await sbGet('businesses', `id=eq.${brief.business_id}&select=email,business_name,first_name,whatsapp_number`);
    const business = bizRows[0] || {};
    const deliverable = brief.deliverable || {};

    const deliveries = [];
    const channels = Array.isArray(settings.channels) ? settings.channels : [];
    const recipients = Array.isArray(settings.recipients) ? settings.recipients : [];

    // Fallback recipient: the business owner's email
    const fallbackEmail = recipients.find(r => r.email)?.email || business.email;

    for (const channel of channels) {
      try {
        if (channel === 'email' && fallbackEmail && sendEmail) {
          const subject = deliverable.subjectLine || brief.subject_line || `Weekly brief — ${brief.week_start}`;
          const html = renderHtmlFromDeliverable(deliverable, business);
          const result = await sendEmail(fallbackEmail, subject, html);
          deliveries.push({ channel, recipient: fallbackEmail, status: result?.ok ? 'sent' : 'failed', external_id: result?.id });
        } else if (channel === 'whatsapp' && business.whatsapp_number && sendWhatsApp) {
          const msg = `*${deliverable.tldr?.headline || brief.headline || 'Weekly brief'}*\n\n${(deliverable.tldr?.bullets || []).slice(0, 3).join('\n')}\n\n${deliverable.tldr?.strategicQuestion || ''}`;
          await sendWhatsApp(business.whatsapp_number, msg);
          deliveries.push({ channel, recipient: business.whatsapp_number, status: 'sent' });
        } else if (channel === 'dashboard_only') {
          deliveries.push({ channel, status: 'sent' });
        } else {
          deliveries.push({ channel, status: 'skipped' });
        }
      } catch (e) {
        deliveries.push({ channel, status: 'failed', error: e.message });
      }
    }

    for (const d of deliveries) {
      await sbPost('brief_delivery_log', {
        brief_id: briefId,
        business_id: brief.business_id,
        channel: d.channel,
        recipient: d.recipient || null,
        status: d.status,
        external_id: d.external_id || null,
        error: d.error || null,
      }).catch(() => {});
    }

    await sbPatch('weekly_briefs', `id=eq.${briefId}`, {
      status: 'delivered',
      delivered_at: new Date().toISOString(),
    });

    await sbPost('events', {
      business_id: brief.business_id,
      kind: 'wf13.brief.delivered',
      workflow: '13_weekly_brief',
      payload: { brief_id: briefId, deliveries },
      severity: 'success',
    }).catch(() => {});

    return { briefId, deliveries };
  }

  function renderHtmlFromDeliverable(deliverable, business) {
    if (!deliverable) return '<p>Weekly brief not available</p>';
    const fb = deliverable.fullBrief || {};
    const h = n => `<h2 style="font-family:Inter,sans-serif;color:#0f172a;font-size:18px;margin:24px 0 8px;">${n}</h2>`;
    const body = s => `<div style="font-family:Inter,sans-serif;color:#334155;font-size:14px;line-height:1.6;">${s || ''}</div>`;
    const greet = deliverable.greeting || `Hi ${business.first_name || ''},`;
    return `
<!doctype html>
<html><body style="margin:0;padding:24px;background:#fafafa;">
<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
<p style="font-family:Inter,sans-serif;font-size:15px;color:#0f172a;">${greet}</p>
${deliverable.tldr ? `<div style="background:#f8fafc;border-left:3px solid #0f172a;padding:16px;margin:16px 0;">
  <p style="margin:0 0 8px;font-family:Inter,sans-serif;font-weight:500;">${deliverable.tldr.headline || ''}</p>
  <ul style="margin:0;padding-left:20px;font-family:Inter,sans-serif;font-size:13px;color:#334155;">${(deliverable.tldr.bullets || []).map(b => `<li>${b}</li>`).join('')}</ul>
  <p style="margin:12px 0 0;font-family:Inter,sans-serif;font-style:italic;color:#64748b;">${deliverable.tldr.strategicQuestion || ''}</p>
</div>` : ''}
${h('Executive summary')}${body(fb.executiveSummary)}
${h('KPI narrative')}${body(fb.kpiNarrativeMarkdown)}
${h('What is working')}${body(fb.winsMarkdown)}
${h('What is not working')}${body(fb.lossesMarkdown)}
${h('What changed')}${body(fb.whatChangedMarkdown)}
${h('Market context')}${body(fb.marketContextMarkdown)}
${h('Recommendations for next week')}${body(fb.recommendationsMarkdown)}
${h('What is coming')}${body(fb.whatsComingMarkdown)}
${h('Risks to watch')}${body(fb.riskWatchMarkdown)}
${h('Biggest insight')}${body(fb.biggestInsightMarkdown)}
${h('Strategic question')}${body(fb.strategicQuestionMarkdown)}
<p style="margin-top:32px;font-family:Inter,sans-serif;font-size:12px;color:#94a3b8;">${deliverable.footer || ''}</p>
</div>
</body></html>`;
  }

  return { runSynthesis, deliverBrief, getDeliverySettings, resolveBrandContext, renderHtmlFromDeliverable };
}

module.exports = createEngine;
