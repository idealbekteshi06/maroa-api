/*
 * services/wf13/registerRoutes.js
 * ----------------------------------------------------------------------------
 * Mounts WF13 endpoints matching frontend api.ts lines 420–487.
 * ----------------------------------------------------------------------------
 */

'use strict';

function registerWf13Routes({ app, wf13, sbGet, sbPost, sbPatch, apiError, logger }) {
  // ─── POST /webhook/wf13-generate-brief ──────────────────────
  app.post('/webhook/wf13-generate-brief', async (req, res) => {
    const { businessId, weekStart } = req.body || {};
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await wf13.engine.runSynthesis({ businessId, weekStart, force: true });
      res.json({ briefId: r.briefId, status: r.status });
    } catch (e) {
      logger?.error('/webhook/wf13-generate-brief', businessId, 'failed', e);
      apiError(res, 500, 'WF13_GEN_FAILED', e.message);
    }
  });

  // ─── GET/POST /webhook/wf13-latest-brief ───────────────────
  async function latestHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const rows = await sbGet(
        'weekly_briefs',
        `business_id=eq.${businessId}&order=week_start.desc&limit=1&select=*`
      ).catch(() => []);
      if (!rows[0]) return res.json(null);
      const brief = rows[0];
      const actions = await sbGet(
        'brief_plan_actions',
        `brief_id=eq.${brief.id}&select=*&order=created_at.asc`
      ).catch(() => []);
      res.json(briefRowToDetail(brief, actions));
    } catch (e) {
      logger?.error('/webhook/wf13-latest-brief', businessId, 'failed', e);
      apiError(res, 500, 'WF13_FETCH_FAILED', e.message);
    }
  }
  app.get('/webhook/wf13-latest-brief', latestHandler);
  app.post('/webhook/wf13-latest-brief', latestHandler);

  // ─── GET/POST /webhook/wf13-brief-history ──────────────────
  async function historyHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    const limit = Number(req.body?.limit || req.query?.limit || 10);
    const before = req.body?.before || req.query?.before;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      let query = `business_id=eq.${businessId}&order=week_start.desc&limit=${limit}&select=id,week_start,week_end,status,subject_line,headline,word_count,generated_at,delivered_at`;
      if (before) query += `&week_start=lt.${encodeURIComponent(before)}`;
      const rows = await sbGet('weekly_briefs', query).catch(() => []);
      const items = rows.map(r => ({
        id: r.id,
        weekStart: r.week_start,
        weekEnd: r.week_end,
        status: r.status,
        subjectLine: r.subject_line,
        headline: r.headline,
        wordCount: r.word_count,
        generatedAt: r.generated_at,
        deliveredAt: r.delivered_at,
      }));
      const nextCursor = items.length === limit ? items[items.length - 1].weekStart : null;
      res.json({ items, nextCursor });
    } catch (e) {
      logger?.error('/webhook/wf13-brief-history', businessId, 'failed', e);
      apiError(res, 500, 'WF13_HISTORY_FAILED', e.message);
    }
  }
  app.get('/webhook/wf13-brief-history', historyHandler);
  app.post('/webhook/wf13-brief-history', historyHandler);

  // ─── POST /webhook/wf13-brief-decision ─────────────────────
  app.post('/webhook/wf13-brief-decision', async (req, res) => {
    const { businessId, briefId, decision, editedSections, reason } = req.body || {};
    if (!businessId || !briefId || !decision) return apiError(res, 400, 'INVALID_REQUEST', 'required fields missing');
    try {
      const briefRows = await sbGet('weekly_briefs', `id=eq.${briefId}&select=*`);
      const brief = briefRows[0];
      if (!brief) return apiError(res, 404, 'NOT_FOUND', 'brief not found');

      let patch = { status: decision === 'reject' ? 'rejected' : 'approved', updated_at: new Date().toISOString(), review_notes: reason || null };
      if (decision === 'edit' && editedSections && brief.deliverable) {
        const d = brief.deliverable;
        if (editedSections.executiveSummary) d.fullBrief = { ...(d.fullBrief || {}), executiveSummary: editedSections.executiveSummary };
        if (editedSections.biggestInsight) d.fullBrief = { ...(d.fullBrief || {}), biggestInsightMarkdown: editedSections.biggestInsight };
        if (editedSections.strategicQuestion) d.fullBrief = { ...(d.fullBrief || {}), strategicQuestionMarkdown: editedSections.strategicQuestion };
        patch.deliverable = d;
      }
      await sbPatch('weekly_briefs', `id=eq.${briefId}`, patch);

      // Update pending approval row
      const approvals = await sbGet('approvals', `workflow=eq.13_weekly_brief&entity_id=eq.${briefId}&status=eq.pending&select=id`).catch(() => []);
      for (const a of approvals) {
        await sbPatch('approvals', `id=eq.${a.id}`, {
          status: decision === 'approve' || decision === 'edit' ? 'approved' : 'rejected',
          decided_at: new Date().toISOString(),
          decision_reason: reason || null,
        }).catch(() => {});
      }

      // If approved, deliver
      if (decision === 'approve' || decision === 'edit') {
        await wf13.engine.deliverBrief({ briefId });
      }

      await sbPost('events', {
        business_id: businessId,
        kind: `wf13.decision.${decision}`,
        workflow: '13_weekly_brief',
        payload: { brief_id: briefId, decision, reason },
        severity: 'info',
      }).catch(() => {});

      res.json({ ok: true, decision });
    } catch (e) {
      logger?.error('/webhook/wf13-brief-decision', businessId, 'failed', e);
      apiError(res, 500, 'WF13_DECISION_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf13-delivery-settings ──────────────────
  app.post('/webhook/wf13-delivery-settings', async (req, res) => {
    const body = req.body || {};
    if (!body.businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const row = {
        business_id: body.businessId,
        autonomy_mode: body.autonomyMode || 'review_first',
        channels: body.channels || ['email', 'dashboard_only'],
        recipients: body.recipients || [],
        delivery_day: body.deliveryDay || 'monday',
        delivery_local_time: body.deliveryLocalTime || '07:00',
        preferred_length: body.preferredLength || 'standard',
        tone_preference: body.tonePreference || 'direct',
        technical_depth: body.technicalDepth || 'intermediate',
        language: body.language || 'English',
        updated_at: new Date().toISOString(),
      };
      // Upsert
      const existing = await sbGet('brief_delivery_settings', `business_id=eq.${body.businessId}&select=business_id`).catch(() => []);
      if (existing[0]) {
        await sbPatch('brief_delivery_settings', `business_id=eq.${body.businessId}`, row);
      } else {
        await sbPost('brief_delivery_settings', row);
      }
      res.json({ ok: true });
    } catch (e) {
      logger?.error('/webhook/wf13-delivery-settings', body.businessId, 'failed', e);
      apiError(res, 500, 'WF13_SETTINGS_FAILED', e.message);
    }
  });

  // ─── GET/POST /webhook/wf13-delivery-settings-get ──────────
  async function settingsGetHandler(req, res) {
    const businessId = req.body?.business_id || req.query?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'business_id required');
    try {
      const rows = await sbGet('brief_delivery_settings', `business_id=eq.${businessId}&select=*`).catch(() => []);
      const s = rows[0] || {};
      res.json({
        autonomyMode: s.autonomy_mode || 'review_first',
        channels: s.channels || ['email', 'dashboard_only'],
        recipients: s.recipients || [],
        deliveryDay: s.delivery_day || 'monday',
        deliveryLocalTime: s.delivery_local_time || '07:00',
        preferredLength: s.preferred_length || 'standard',
        tonePreference: s.tone_preference || 'direct',
        technicalDepth: s.technical_depth || 'intermediate',
        language: s.language || 'English',
      });
    } catch (e) {
      apiError(res, 500, 'WF13_SETTINGS_GET_FAILED', e.message);
    }
  }
  app.get('/webhook/wf13-delivery-settings-get', settingsGetHandler);
  app.post('/webhook/wf13-delivery-settings-get', settingsGetHandler);

  // ─── POST /webhook/wf13-plan-action-decision ──────────────
  app.post('/webhook/wf13-plan-action-decision', async (req, res) => {
    const { businessId, briefId, actionId, decision } = req.body || {};
    if (!businessId || !briefId || !actionId || !decision) return apiError(res, 400, 'INVALID_REQUEST', 'required fields missing');
    try {
      await sbPatch('brief_plan_actions', `id=eq.${actionId}&brief_id=eq.${briefId}`, {
        status: decision,
        decided_at: new Date().toISOString(),
      });
      res.json({ ok: true });
    } catch (e) {
      apiError(res, 500, 'WF13_ACTION_FAILED', e.message);
    }
  });

  // ─── POST /webhook/wf13-run-weekly (Sunday cron target) ───
  app.post('/webhook/wf13-run-weekly', async (req, res) => {
    const { businessId, force } = req.body || {};
    try {
      if (businessId) {
        const r = await wf13.engine.runSynthesis({ businessId, force: !!force });
        res.json(r);
      } else {
        const bizList = await sbGet('businesses', 'is_active=eq.true&select=id&limit=500').catch(() => []);
        const results = [];
        for (const b of bizList) {
          try {
            const r = await wf13.engine.runSynthesis({ businessId: b.id, force: !!force });
            results.push({ businessId: b.id, ...r });
          } catch (e) {
            results.push({ businessId: b.id, ok: false, error: e.message });
          }
        }
        res.json({ processed: results.length, results });
      }
    } catch (e) {
      apiError(res, 500, 'WF13_CRON_FAILED', e.message);
    }
  });
}

function briefRowToDetail(brief, actions) {
  const s = brief.synthesis || {};
  const d = brief.deliverable || {};
  return {
    id: brief.id,
    weekStart: brief.week_start,
    weekEnd: brief.week_end,
    status: brief.status,
    subjectLine: brief.subject_line,
    headline: brief.headline,
    wordCount: brief.word_count,
    generatedAt: brief.generated_at,
    deliveredAt: brief.delivered_at,
    executiveSummary: s.executiveSummary || '',
    kpiNarrative: s.kpiNarrative || [],
    wins: s.wins || [],
    losses: s.losses || [],
    whatChanged: s.whatChanged || [],
    marketContext: s.marketContext || [],
    biggestInsight: s.biggestInsight || '',
    nextWeekPlan: actions.map(a => ({
      id: a.id,
      action: a.action,
      whyNow: a.why_now,
      expectedImpact: {
        low: Number(a.expected_impact_low || 0),
        high: Number(a.expected_impact_high || 0),
        metric: a.impact_metric || '',
      },
      effortHours: Number(a.effort_hours || 0),
      owner: a.owner,
      deadline: a.deadline,
      oneClickApprove: !!a.one_click_approve,
      metric: a.impact_metric || '',
      status: a.status || 'pending',
    })),
    whatsComingPreview: s.whatsComingPreview || '',
    riskWatch: s.riskWatch || [],
    strategicQuestion: s.strategicQuestion || '',
    dataSources: s.dataSources || [],
    frameworksCited: s.frameworksCited || [],
    kpiCards: [],
  };
}

module.exports = { registerWf13Routes };
