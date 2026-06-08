'use strict';

/**
 * services/creative-engine/registerRoutes.js
 * ---------------------------------------------------------------------------
 * Endpoints for Daily Creative Engine + Measurement Health probes.
 *
 * Cron-target fanouts (called by Inngest functions):
 *   POST /webhook/creative-engine-generate-all
 *   POST /webhook/creative-engine-evaluate-all
 *   POST /webhook/measurement-health-probe-all
 *
 * Per-business endpoints (manual triggers / dashboards):
 *   POST /webhook/creative-engine-generate
 *   POST /webhook/creative-engine-evaluate
 *   POST /webhook/measurement-health-probe
 * ---------------------------------------------------------------------------
 */

function registerCreativeEngineRoutes(deps) {
  const internalDispatcher = require('../../lib/internalDispatcher');
  const {
    app,
    apiError,
    logger,
    sentry,
    sbGet,
    sbPost,
    sbPatch,
    callClaude,
    brandVoice,
    higgsfield,
    creativeEngine,
    measurementHealth,
    metaInsights,
    googleAdsDiag,
    tiktokDiag,
    competitorWatch,
    metaAdLibraryApi,
    citationTracker,
    marketingGraph, // optional — lib/marketingGraph. Receives each generated variant as a `creative` entity.
  } = deps;

  function buildEngineDeps() {
    return {
      sbGet,
      sbPost,
      sbPatch,
      callClaude,
      brandVoice,
      higgsfield,
      logger,
      marketingGraph,
    };
  }
  function buildHealthDeps() {
    return { sbGet, sbPost, sbPatch, metaInsights, googleAdsDiag, tiktokDiag, logger };
  }

  async function runCreativeEngineGenerateAll() {
    const businesses = await sbGet(
      'businesses',
      'is_active=eq.true&plan=in.(growth,agency)&select=id&limit=1000'
    ).catch(() => []);
    let generated = 0;
    const errors = [];
    for (const b of businesses) {
      try {
        const r = await creativeEngine.generateDailyVariants({ businessId: b.id, deps: buildEngineDeps() });
        if (r?.ok && r?.generated) generated += r.generated;
      } catch (e) {
        errors.push({ businessId: b.id, error: e.message });
      }
    }
    return { ok: true, businesses: businesses.length, generated, errors: errors.length };
  }
  internalDispatcher.register('/webhook/creative-engine-generate-all', () => runCreativeEngineGenerateAll());

  app.post('/webhook/creative-engine-generate-all', async (req, res) => {
    try {
      res.json(await runCreativeEngineGenerateAll());
    } catch (e) {
      sentry?.captureException?.(e, { tags: { route: 'creative-engine-generate-all' } });
      apiError(res, 500, 'CREATIVE_ENGINE_GENERATE_ALL_FAILED', e.message);
    }
  });

  app.post('/webhook/creative-engine-generate', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await creativeEngine.generateDailyVariants({ businessId, deps: buildEngineDeps() });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'CREATIVE_ENGINE_GENERATE_FAILED', e.message);
    }
  });

  async function runCreativeEngineEvaluateAll() {
    const rows = await sbGet('ad_creative_variants', 'status=eq.testing&select=business_id&limit=2000').catch(() => []);
    const seen = new Set();
    const businessIds = [];
    for (const r of rows) {
      if (!seen.has(r.business_id)) {
        seen.add(r.business_id);
        businessIds.push(r.business_id);
      }
    }
    let evaluated = 0,
      promoted = 0,
      killed = 0;
    for (const bid of businessIds) {
      try {
        const r = await creativeEngine.evaluateTestingVariants({ businessId: bid, deps: buildEngineDeps() });
        evaluated += r?.evaluated || 0;
        promoted += r?.promoted || 0;
        killed += r?.killed || 0;
      } catch (e) {
        logger?.warn?.('/webhook/creative-engine-evaluate-all', bid, 'evaluate failed', { error: e.message });
      }
    }
    return { ok: true, businesses: businessIds.length, evaluated, promoted, killed };
  }
  internalDispatcher.register('/webhook/creative-engine-evaluate-all', () => runCreativeEngineEvaluateAll());

  app.post('/webhook/creative-engine-evaluate-all', async (req, res) => {
    try {
      res.json(await runCreativeEngineEvaluateAll());
    } catch (e) {
      apiError(res, 500, 'CREATIVE_ENGINE_EVALUATE_ALL_FAILED', e.message);
    }
  });

  app.post('/webhook/creative-engine-evaluate', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await creativeEngine.evaluateTestingVariants({ businessId, deps: buildEngineDeps() });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'CREATIVE_ENGINE_EVALUATE_FAILED', e.message);
    }
  });

  async function runMeasurementHealthProbeAll() {
    const businesses = await sbGet('businesses', 'is_active=eq.true&select=id,daily_budget&limit=1000').catch(() => []);
    let probed = 0,
      healthy = 0,
      degraded = 0,
      broken = 0;
    for (const b of businesses) {
      for (const platform of ['meta', 'google', 'tiktok']) {
        if (platform === 'tiktok' && Number(b.daily_budget) < 50) continue;
        try {
          const r = await measurementHealth.probe({ businessId: b.id, platform, deps: buildHealthDeps() });
          if (r?.ok) {
            probed += 1;
            if (r.health_verdict === 'healthy') healthy += 1;
            else if (r.health_verdict === 'degraded') degraded += 1;
            else if (r.health_verdict === 'broken') broken += 1;
          }
        } catch (e) {
          logger?.warn?.('/webhook/measurement-health-probe-all', b.id, 'probe failed', {
            platform,
            error: e.message,
          });
        }
      }
    }
    return { ok: true, probed, healthy, degraded, broken };
  }
  internalDispatcher.register('/webhook/measurement-health-probe-all', () => runMeasurementHealthProbeAll());

  app.post('/webhook/measurement-health-probe-all', async (req, res) => {
    try {
      res.json(await runMeasurementHealthProbeAll());
    } catch (e) {
      apiError(res, 500, 'MEASUREMENT_HEALTH_PROBE_ALL_FAILED', e.message);
    }
  });

  app.post('/webhook/measurement-health-probe', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    const platform = req.body?.platform;
    if (!businessId || !platform) return apiError(res, 400, 'INVALID_REQUEST', 'businessId + platform required');
    try {
      const r = await measurementHealth.probe({ businessId, platform, deps: buildHealthDeps() });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'MEASUREMENT_HEALTH_PROBE_FAILED', e.message);
    }
  });

  async function runCitationTrackerAll() {
    if (!citationTracker?.runDailyForBusiness) throw new Error('citation-tracker not configured');
    const businesses = await sbGet(
      'businesses',
      'is_active=eq.true&plan=in.(growth,agency)&select=id&limit=1000'
    ).catch(() => []);
    let ran = 0,
      cited = 0,
      costUsd = 0;
    const trackerDeps = { sbGet, sbPost, sbPatch, logger };
    for (const b of businesses) {
      try {
        const r = await citationTracker.runDailyForBusiness({ businessId: b.id, deps: trackerDeps });
        if (r?.ok) {
          ran += r.ran || 0;
          cited += r.cited || 0;
          costUsd += r.cost_usd || 0;
        }
      } catch (e) {
        logger?.warn?.('/webhook/citation-tracker-run-all', b.id, 'run failed', { error: e.message });
      }
    }
    return { ok: true, businesses: businesses.length, ran, cited, cost_usd: costUsd };
  }
  internalDispatcher.register('/webhook/citation-tracker-run-all', () => runCitationTrackerAll());

  app.post('/webhook/citation-tracker-run-all', async (req, res) => {
    if (!citationTracker?.runDailyForBusiness) {
      return apiError(res, 503, 'CITATION_TRACKER_DISABLED', 'citation-tracker not configured');
    }
    try {
      res.json(await runCitationTrackerAll());
    } catch (e) {
      apiError(res, 500, 'CITATION_TRACKER_RUN_ALL_FAILED', e.message);
    }
  });

  app.post('/webhook/citation-tracker-run', async (req, res) => {
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await citationTracker.runDailyForBusiness({ businessId, deps: { sbGet, sbPost, sbPatch, logger } });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'CITATION_TRACKER_RUN_FAILED', e.message);
    }
  });

  app.get('/webhook/citation-tracker-share-of-voice', async (req, res) => {
    const businessId = req.query?.businessId || req.query?.business_id;
    const days = Number(req.query?.days || 7);
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const r = await citationTracker.computeShareOfVoice({ businessId, days, deps: { sbGet } });
      res.json(r);
    } catch (e) {
      apiError(res, 500, 'CITATION_TRACKER_SOV_FAILED', e.message);
    }
  });

  async function runCompetitorWatchScanAll() {
    if (!competitorWatch?.scanForBusiness) throw new Error('competitor-watch not configured');
    const businesses = await sbGet('businesses', 'is_active=eq.true&select=id&limit=1000').catch(() => []);
    let scanned = 0,
      alerts = 0,
      critical = 0;
    const watchDeps = { sbGet, sbPost, logger, metaAdLibraryApi };
    for (const b of businesses) {
      try {
        const r = await competitorWatch.scanForBusiness({ businessId: b.id, deps: watchDeps });
        if (r?.ok) {
          scanned += 1;
          for (const s of r.signals || []) {
            if (s.severity === 'alert') alerts += 1;
            else if (s.severity === 'critical') critical += 1;
          }
        }
      } catch (e) {
        logger?.warn?.('/webhook/competitor-watch-scan-all', b.id, 'scan failed', { error: e.message });
      }
    }
    return { ok: true, businesses: businesses.length, scanned, alerts, critical };
  }
  internalDispatcher.register('/webhook/competitor-watch-scan-all', () => runCompetitorWatchScanAll());

  app.post('/webhook/competitor-watch-scan-all', async (req, res) => {
    if (!competitorWatch?.scanForBusiness) {
      return apiError(res, 503, 'COMPETITOR_WATCH_DISABLED', 'competitor-watch not configured');
    }
    try {
      res.json(await runCompetitorWatchScanAll());
    } catch (e) {
      apiError(res, 500, 'COMPETITOR_WATCH_SCAN_ALL_FAILED', e.message);
    }
  });

  // ─── Per-business competitor War Room (canonical surface for the UI) ───────
  // These let the dashboard bind to competitor-watch (canonical) instead of the
  // deprecated wf5-* routes. Mirrors the citation-tracker per-business pattern.
  // The scan handler is also registered on the internal dispatcher so the
  // `maroa/manual.competitor-watch` Inngest event runs it in-process.
  function runCompetitorWatchScan(body) {
    const businessId = body?.businessId || body?.business_id;
    if (!businessId) return Promise.resolve({ ok: false, reason: 'businessId required' });
    return competitorWatch.scanForBusiness({
      businessId,
      deps: { sbGet, sbPost, logger, metaAdLibraryApi },
    });
  }
  internalDispatcher.register('/webhook/competitor-watch-scan', (body) => runCompetitorWatchScan(body || {}));

  app.post('/webhook/competitor-watch-scan', async (req, res) => {
    if (!competitorWatch?.scanForBusiness) {
      return apiError(res, 503, 'COMPETITOR_WATCH_DISABLED', 'competitor-watch not configured');
    }
    const businessId = req.body?.businessId || req.body?.business_id;
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const scan = await runCompetitorWatchScan(req.body);
      const briefing = await competitorWatch.compileWarRoomBriefing({ businessId, days: 7, deps: { sbGet } });
      res.json({ ...scan, briefing });
    } catch (e) {
      apiError(res, 500, 'COMPETITOR_WATCH_SCAN_FAILED', e.message);
    }
  });

  app.get('/webhook/competitor-watch-briefing', async (req, res) => {
    if (!competitorWatch?.compileWarRoomBriefing) {
      return apiError(res, 503, 'COMPETITOR_WATCH_DISABLED', 'competitor-watch not configured');
    }
    const businessId = req.query?.businessId || req.query?.business_id;
    const days = Number(req.query?.days || 7);
    if (!businessId) return apiError(res, 400, 'INVALID_REQUEST', 'businessId required');
    try {
      const briefing = await competitorWatch.compileWarRoomBriefing({ businessId, days, deps: { sbGet } });
      res.json(briefing);
    } catch (e) {
      apiError(res, 500, 'COMPETITOR_WATCH_BRIEFING_FAILED', e.message);
    }
  });
}

module.exports = { registerCreativeEngineRoutes };
