'use strict';

/**
 * routes/onboarding.js
 * ----------------------------------------------------------------------------
 * Onboarding API — the seam between the dashboard's onboarding flow and
 * the cold-start orchestrator. These endpoints were referenced by the
 * frontend (lib/api/business.ts) but never wired backend-side, so submitting
 * the onboarding form 400'd against /webhook/cold-start-trigger (which
 * expects a pre-existing businessId, not the raw form payload).
 *
 *   POST  /api/onboarding/save              upsert business + return profile
 *   GET   /api/onboarding/profile/:userId   read profile
 *   PATCH /api/onboarding/profile/:userId   partial update
 *   GET   /api/onboarding/score/:userId     completeness score
 *   POST  /api/onboarding/spark             first-draft content (magic moment)
 *
 * Magic-moment design (W4-4):
 *   The dashboard hits POST /api/onboarding/save first (fast — single
 *   upsert + cold-start trigger fire-and-forget). Then it hits
 *   POST /api/onboarding/spark which calls the existing /api/content/generate
 *   pipeline once with the new business's profile and returns the first
 *   draft inline. The frontend shows the multi-step "drafting your first
 *   week" animation between the two — by the time the animation finishes,
 *   the draft is ready and the dashboard lands with content already visible.
 *
 * The split keeps `save` deterministically fast so onboarding never
 * appears stuck, while `spark` carries the LLM latency budget.
 * ----------------------------------------------------------------------------
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(value, max = 200) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

// DB column names — `businesses` uses `location` (not region) and
// `marketing_goal` (not goal). Score against the actual schema so that
// `GET /api/onboarding/score/:userId` reflects what's stored.
const REQUIRED_FIELDS = ['business_name', 'industry', 'location'];
const SCORED_FIELDS = ['business_name', 'industry', 'location', 'target_audience', 'marketing_goal', 'brand_tone'];

function completenessScore(profile) {
  if (!profile) return { score: 0, missing_fields: [...REQUIRED_FIELDS], recommendations: [] };
  let filled = 0;
  const missing = [];
  for (const f of SCORED_FIELDS) {
    if (profile[f] && String(profile[f]).trim()) filled += 1;
    else if (REQUIRED_FIELDS.includes(f)) missing.push(f);
  }
  const score = Math.round((filled / SCORED_FIELDS.length) * 100);
  const recommendations = [];
  if (!profile.target_audience) recommendations.push('Add your target audience so drafts target real customers.');
  if (!profile.marketing_goal) recommendations.push('Set a 90-day goal so Maroa can prioritize the right channels.');
  if (!profile.brand_tone) recommendations.push('Tune your brand voice — paste a few sample posts in Settings.');
  return { score, missing_fields: missing, recommendations };
}

function register({
  app,
  requireAnyUserId,
  sbGet,
  sbPost,
  sbPatch,
  apiError,
  safePublicError,
  log,
  express,
  callContentGenerate, // optional — server.js may pass an internal helper
  enrichWebsite, // optional — fetch+summarize the customer's website (migration 088)
}) {
  if (!requireAnyUserId || !sbGet || !sbPost || !sbPatch) {
    log?.('/api/onboarding', null, 'register skipped — missing dependencies');
    return;
  }

  async function businessForUser(userId) {
    try {
      const rows = await sbGet(
        'businesses',
        `user_id=eq.${encodeURIComponent(userId)}&select=*&order=created_at.asc&limit=1`
      );
      return rows?.[0] || null;
    } catch {
      return null;
    }
  }

  // ─── POST /api/onboarding/save ──────────────────────────────────────────
  app.post(
    '/api/onboarding/save',
    requireAnyUserId,
    express ? express.json({ limit: '8kb' }) : (req, _res, next) => next(),
    async (req, res) => {
      try {
        const userId = req.user?.id;
        if (!userId) return apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
        const body = req.body || {};
        const profile = {
          business_name: clean(body.businessName || body.business_name, 120),
          industry: clean(body.industry, 80),
          location: clean(body.region || body.location, 120),
          target_audience: clean(body.audience || body.target_audience, 500),
          marketing_goal: clean(body.goal || body.marketing_goal, 300),
          brand_tone: clean(body.brandTone || body.brand_tone, 200),
          // voice_seed: customer-pasted brand voice samples ("Paste 1–3
          // existing posts or copy you love"). Persisted in migration 077
          // so the grounding context can anchor day-1 generation before
          // any published-content history accumulates. Cap at 4kB.
          voice_seed: clean(body.voiceSeed || body.voice_seed, 4000),
          website_url: clean(body.websiteUrl || body.website_url, 300),
          email: req.user?.email || null,
          user_id: userId,
          updated_at: new Date().toISOString(),
        };
        if (!profile.business_name) {
          return apiError(res, 400, 'VALIDATION_ERROR', 'businessName is required');
        }

        // Upsert: if this user already has a business row, patch it.
        const existing = await businessForUser(userId);
        let businessId = existing?.id || null;
        if (existing) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(existing.id)}`, profile);
        } else {
          const created = await sbPost('businesses', {
            ...profile,
            onboarding_complete: true,
            plan: profile.plan || existing?.plan || 'growth',
          });
          const row = Array.isArray(created) ? created[0] : created;
          businessId = row?.id || null;
        }

        // Fire-and-forget website enrichment so the brain actually "reads" the
        // customer's site (migration 088). Never blocks the snappy save
        // response; the summary lands a few seconds later via sbPatch.
        if (businessId && profile.website_url && typeof enrichWebsite === 'function') {
          Promise.resolve(enrichWebsite({ businessId, url: profile.website_url })).catch((e) =>
            log?.('/api/onboarding/save', businessId, 'website enrichment failed (non-fatal)', { error: e.message })
          );
        }

        return res.json({
          ok: true,
          businessId,
          profile: { ...profile, id: businessId },
          // The dashboard immediately follows up with /api/onboarding/spark
          // to trigger the magic moment. Returning here keeps `save` snappy.
          nextStep: 'spark',
        });
      } catch (err) {
        log?.('/api/onboarding/save', null, 'failed', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError ? safePublicError(err) : 'save failed');
      }
    }
  );

  // ─── GET /api/onboarding/profile/:userId ────────────────────────────────
  app.get('/api/onboarding/profile/:userId', requireAnyUserId, async (req, res) => {
    try {
      const userId = req.user?.id;
      const requested = String(req.params.userId || '');
      if (!UUID_RE.test(requested)) return apiError(res, 400, 'VALIDATION_ERROR', 'invalid userId');
      if (requested !== userId) return apiError(res, 403, 'FORBIDDEN', 'Cannot read another user');
      const row = await businessForUser(userId);
      if (!row) return res.json({ profile: null });
      return res.json({
        profile: {
          business_name: row.business_name,
          industry: row.industry,
          region: row.location,
          audience: row.target_audience,
          goal: row.marketing_goal,
          brand_tone: row.brand_tone,
          id: row.id,
        },
      });
    } catch (err) {
      log?.('/api/onboarding/profile', null, 'read failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError ? safePublicError(err) : 'profile read failed');
    }
  });

  // ─── PATCH /api/onboarding/profile/:userId ──────────────────────────────
  app.patch(
    '/api/onboarding/profile/:userId',
    requireAnyUserId,
    express ? express.json({ limit: '8kb' }) : (req, _res, next) => next(),
    async (req, res) => {
      try {
        const userId = req.user?.id;
        const requested = String(req.params.userId || '');
        if (!UUID_RE.test(requested)) return apiError(res, 400, 'VALIDATION_ERROR', 'invalid userId');
        if (requested !== userId) return apiError(res, 403, 'FORBIDDEN', 'Cannot modify another user');
        const body = req.body || {};
        const patch = {
          business_name: clean(body.business_name || body.businessName, 120),
          industry: clean(body.industry, 80),
          location: clean(body.region || body.location, 120),
          target_audience: clean(body.audience || body.target_audience, 500),
          marketing_goal: clean(body.goal || body.marketing_goal, 300),
          brand_tone: clean(body.brand_tone || body.brandTone, 200),
          updated_at: new Date().toISOString(),
        };
        // Drop null keys so PATCH preserves untouched columns.
        for (const k of Object.keys(patch)) if (patch[k] === null) delete patch[k];
        const existing = await businessForUser(userId);
        if (!existing) return apiError(res, 404, 'NOT_FOUND', 'No business profile yet — call /save first');
        await sbPatch('businesses', `id=eq.${encodeURIComponent(existing.id)}`, patch);
        const refreshed = await businessForUser(userId);
        return res.json({
          profile: {
            business_name: refreshed?.business_name,
            industry: refreshed?.industry,
            region: refreshed?.location,
            audience: refreshed?.target_audience,
            goal: refreshed?.marketing_goal,
            brand_tone: refreshed?.brand_tone,
            id: refreshed?.id,
          },
        });
      } catch (err) {
        log?.('/api/onboarding/profile', null, 'patch failed', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError ? safePublicError(err) : 'profile update failed');
      }
    }
  );

  // ─── GET /api/onboarding/score/:userId ──────────────────────────────────
  app.get('/api/onboarding/score/:userId', requireAnyUserId, async (req, res) => {
    try {
      const userId = req.user?.id;
      const requested = String(req.params.userId || '');
      if (!UUID_RE.test(requested)) return apiError(res, 400, 'VALIDATION_ERROR', 'invalid userId');
      if (requested !== userId) return apiError(res, 403, 'FORBIDDEN', 'Cannot read another user');
      const row = await businessForUser(userId);
      return res.json(completenessScore(row));
    } catch (err) {
      log?.('/api/onboarding/score', null, 'failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError ? safePublicError(err) : 'score failed');
    }
  });

  // ─── POST /api/onboarding/spark ─────────────────────────────────────────
  // The magic moment: synchronously create the first draft so by the time
  // the user lands on /dashboard there's already something to look at.
  // If callContentGenerate isn't wired (server.js failed to inject it),
  // we still return a structured stub so the UI doesn't error out — the
  // dashboard will pick up the real draft from the normal pipeline.
  app.post(
    '/api/onboarding/spark',
    requireAnyUserId,
    express ? express.json({ limit: '4kb' }) : (req, _res, next) => next(),
    async (req, res) => {
      try {
        const userId = req.user?.id;
        if (!userId) return apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
        const business = await businessForUser(userId);
        if (!business?.id) {
          return apiError(res, 404, 'NOT_FOUND', 'No business yet — call /api/onboarding/save first');
        }
        if (typeof callContentGenerate !== 'function') {
          // No generator wired; return enough metadata for the dashboard to render
          // a "drafting in the background" state. The async cold-start orchestrator
          // will fill in real content within a minute.
          return res.json({
            ok: true,
            businessId: business.id,
            draftReady: false,
            message: 'First draft is being generated in the background — refresh your dashboard in ~60s.',
          });
        }
        const draft = await callContentGenerate({
          business,
          theme: 'introduction',
          industry: business.industry,
          tone: business.brand_tone,
        }).catch((e) => {
          log?.('/api/onboarding/spark', business.id, 'generate failed', { error: e.message });
          return null;
        });
        if (!draft) {
          return res.json({
            ok: true,
            businessId: business.id,
            draftReady: false,
            message: 'First draft will appear in your dashboard shortly.',
          });
        }
        return res.json({
          ok: true,
          businessId: business.id,
          draftReady: true,
          draft,
        });
      } catch (err) {
        log?.('/api/onboarding/spark', null, 'failed', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError ? safePublicError(err) : 'spark failed');
      }
    }
  );

  log?.('/api/onboarding', null, 'onboarding routes registered');
}

module.exports = { register, completenessScore };
