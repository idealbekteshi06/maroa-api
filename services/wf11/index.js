/*
 * services/wf11/index.js — Workflow #11 Smart Routing
 * Specialist model + SLA enforcement + escalation on top of WF9 inbox threads.
 */

'use strict';

const SPECIALISTS = [
  'sdr',
  'support',
  'customer_success',
  'reputation',
  'community',
  'executive_assistant',
  'crisis',
];

/** Map WF9 classification → specialist role */
const CLASSIFICATION_TO_SPECIALIST = {
  lead: 'sdr',
  sales: 'sdr',
  support: 'support',
  complaint: 'support',
  partnership: 'executive_assistant',
  press: 'executive_assistant',
  review_mention: 'reputation',
  spam: 'support',
  internal: 'executive_assistant',
};

const URGENCY_SLA_MINUTES = {
  immediate: 15,
  high: 60,
  medium: 240,
  low: 1440,
};

function createWf11(deps) {
  const { sbGet, sbPost, sbPatch, logger, sendEmail } = deps;

  async function getSettings(businessId) {
    const rows = await sbGet('inbox_routing_settings', `business_id=eq.${businessId}&select=*`).catch(() => []);
    if (rows[0]) return rows[0];
    return {
      business_id: businessId,
      autonomy_mode: 'hybrid',
      deal_escalation_threshold_usd: 5000,
      refund_escalation_threshold_usd: 200,
      default_sla_minutes: 240,
      owner_notify_email: null,
      specialist_overrides: {},
    };
  }

  async function saveSettings({ businessId, ...patch }) {
    const row = {
      business_id: businessId,
      autonomy_mode: patch.autonomy_mode || 'hybrid',
      deal_escalation_threshold_usd: patch.deal_escalation_threshold_usd ?? 5000,
      refund_escalation_threshold_usd: patch.refund_escalation_threshold_usd ?? 200,
      default_sla_minutes: patch.default_sla_minutes ?? 240,
      owner_notify_email: patch.owner_notify_email || null,
      specialist_overrides: patch.specialist_overrides || {},
      updated_at: new Date().toISOString(),
    };
    const existing = await sbGet('inbox_routing_settings', `business_id=eq.${businessId}&select=business_id`).catch(() => []);
    if (existing[0]) {
      await sbPatch('inbox_routing_settings', `business_id=eq.${businessId}`, row);
    } else {
      await sbPost('inbox_routing_settings', row);
    }
    return { ok: true };
  }

  function resolveSpecialist(thread, triage, settings) {
    const overrides = settings.specialist_overrides || {};
    const fromTriage = triage?.specialist_role || triage?.route_to;
    if (fromTriage && SPECIALISTS.includes(fromTriage)) return fromTriage;
    const classification = (triage?.classification || thread.classification || 'support').toLowerCase();
    const mapped = CLASSIFICATION_TO_SPECIALIST[classification] || 'support';
    if (overrides[classification]) return overrides[classification];
    if (triage?.urgency === 'immediate' && /legal|lawsuit|lawyer|sue|viral|emergency/i.test(thread.body || '')) {
      return 'crisis';
    }
    return mapped;
  }

  function shouldEscalate({ specialist, thread, triage, settings }) {
    const body = `${thread.subject || ''} ${thread.body || ''}`.toLowerCase();
    const reasons = [];
    if (specialist === 'crisis') reasons.push('crisis_keywords');
    if (/refund|chargeback|dispute/i.test(body) && settings.refund_escalation_threshold_usd <= 200) {
      reasons.push('refund_request');
    }
    if (/enterprise|contract|legal|compliance/i.test(body)) reasons.push('high_stakes_language');
    if (triage?.requires_human === true || triage?.escalate === true) reasons.push('triage_escalation');
    if (settings.autonomy_mode === 'human_only') reasons.push('human_only_mode');
    return reasons;
  }

  function canAutorespond({ specialist, settings, escalationReasons }) {
    if (escalationReasons.length) return false;
    if (settings.autonomy_mode === 'human_only') return false;
    if (settings.autonomy_mode === 'full_autopilot') return specialist !== 'crisis';
    // hybrid: support + community can draft; sdr/crisis need human
    return ['support', 'community', 'customer_success'].includes(specialist);
  }

  async function applyRouting({ businessId, threadId, triage }) {
    const threadRows = await sbGet('inbox_threads', `id=eq.${threadId}&business_id=eq.${businessId}&select=*`);
    const thread = threadRows[0];
    if (!thread) throw new Error('Thread not found');

    const settings = await getSettings(businessId);
    const specialist = resolveSpecialist(thread, triage, settings);
    const escalationReasons = shouldEscalate({ specialist, thread, triage, settings });
    const aiCanAutorespond = canAutorespond({ specialist, settings, escalationReasons });

    const urgency = (triage?.urgency || thread.urgency || 'medium').toLowerCase();
    const slaMinutes =
      Number(triage?.sla_minutes) ||
      URGENCY_SLA_MINUTES[urgency] ||
      settings.default_sla_minutes ||
      240;

    const patch = {
      specialist_role: specialist,
      route_to: specialist,
      ai_can_autorespond: aiCanAutorespond,
      sla_deadline: new Date(Date.now() + slaMinutes * 60000).toISOString(),
      status: escalationReasons.length ? 'escalated' : 'routed',
      escalation_level: escalationReasons.length ? 1 : 0,
      escalated_at: escalationReasons.length ? new Date().toISOString() : null,
    };
    await sbPatch('inbox_threads', `id=eq.${threadId}`, patch);

    if (escalationReasons.length) {
      await sbPost('inbox_escalations', {
        business_id: businessId,
        thread_id: threadId,
        specialist_role: specialist,
        reason: escalationReasons.join(','),
        level: 1,
        notified: false,
      });
      if (settings.owner_notify_email && sendEmail) {
        sendEmail({
          to: settings.owner_notify_email,
          subject: `[Maroa] Inbox escalation — ${specialist}`,
          text: `Thread ${threadId} needs human attention.\nReasons: ${escalationReasons.join(', ')}\nPreview: ${(thread.body || '').slice(0, 280)}`,
        }).catch((e) => logger?.warn?.('wf11', businessId, 'escalation email failed', e?.message));
      }
      await sbPatch('inbox_escalations', `thread_id=eq.${threadId}&resolved_at=is.null`, { notified: true }).catch(() => {});
    }

    await sbPost('events', {
      business_id: businessId,
      kind: escalationReasons.length ? 'wf11.thread.escalated' : 'wf11.thread.routed',
      workflow: '11_smart_routing',
      payload: { thread_id: threadId, specialist, escalationReasons, aiCanAutorespond },
      severity: escalationReasons.length ? 'warn' : 'info',
    }).catch(() => {});

    return {
      specialist,
      aiCanAutorespond,
      escalationReasons,
      slaDeadline: patch.sla_deadline,
      status: patch.status,
    };
  }

  async function checkSlaBreaches({ businessId } = {}) {
    const now = new Date().toISOString();
    let query = `status=in.(new,routed)&sla_deadline=lt.${encodeURIComponent(now)}&select=id,business_id,subject,from_handle,specialist_role,sla_deadline`;
    if (businessId) query += `&business_id=eq.${businessId}`;
    const breached = await sbGet('inbox_threads', `${query}&limit=200`).catch(() => []);
    const results = [];
    for (const t of breached) {
      await sbPatch('inbox_threads', `id=eq.${t.id}`, {
        status: 'escalated',
        escalation_level: 2,
        escalated_at: now,
      });
      await sbPost('inbox_escalations', {
        business_id: t.business_id,
        thread_id: t.id,
        specialist_role: t.specialist_role || 'support',
        reason: 'sla_breach',
        level: 2,
      }).catch(() => {});
      await sbPost('events', {
        business_id: t.business_id,
        kind: 'wf11.sla.breach',
        workflow: '11_smart_routing',
        payload: { thread_id: t.id, sla_deadline: t.sla_deadline },
        severity: 'warn',
      }).catch(() => {});
      results.push({ threadId: t.id, businessId: t.business_id });
    }
    return { breached: results.length, items: results };
  }

  async function listEscalations({ businessId, limit = 50 }) {
    const rows = await sbGet(
      'inbox_escalations',
      `business_id=eq.${businessId}&resolved_at=is.null&order=created_at.desc&limit=${limit}&select=*`
    ).catch(() => []);
    return { items: rows };
  }

  async function resolveEscalation({ businessId, escalationId }) {
    await sbPatch('inbox_escalations', `id=eq.${escalationId}&business_id=eq.${businessId}`, {
      resolved_at: new Date().toISOString(),
    });
    return { ok: true };
  }

  async function getMetrics(businessId) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const threads = await sbGet(
      'inbox_threads',
      `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=specialist_role,status,urgency`
    ).catch(() => []);
    const bySpecialist = {};
    for (const s of SPECIALISTS) {
      bySpecialist[s] = { volume: 0, escalated: 0, resolved: 0 };
    }
    for (const t of threads) {
      const role = t.specialist_role || 'support';
      if (!bySpecialist[role]) bySpecialist[role] = { volume: 0, escalated: 0, resolved: 0 };
      bySpecialist[role].volume += 1;
      if (t.status === 'escalated') bySpecialist[role].escalated += 1;
      if (t.status === 'resolved') bySpecialist[role].resolved += 1;
    }
    const escalations = await sbGet(
      'inbox_escalations',
      `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=id`
    ).catch(() => []);
    return {
      periodDays: 7,
      threadCount: threads.length,
      escalationCount: escalations.length,
      bySpecialist,
      specialists: SPECIALISTS,
    };
  }

  return {
    SPECIALISTS,
    getSettings,
    saveSettings,
    applyRouting,
    checkSlaBreaches,
    listEscalations,
    resolveEscalation,
    getMetrics,
  };
}

module.exports = createWf11;
