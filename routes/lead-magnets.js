'use strict';

/**
 * routes/lead-magnets.js — AI-generated lead magnet endpoints.
 *
 * Public endpoints:
 *   POST /api/lead-magnets/generate    — fire-and-forget generation
 *   GET  /api/lead-magnets/:userId     — list recent lead magnets
 *
 * Carved from server.js per the routes/waitlist.js pattern.
 */

function register({
  app,
  getProfile,
  callClaude,
  pCity,
  claudeBiz,
  sbGet,
  sbPost,
  storeInsight,
  checkOrchestrationIdempotency,
  recordOrchestrationTaskRun,
  log,
  safePublicError,
}) {
  app.post('/api/lead-magnets/generate', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ received: true, message: 'Generating lead magnet' });
    setImmediate(async () => {
      try {
        if (await checkOrchestrationIdempotency(userId, 'lead_magnets_generate')) {
          log('/api/lead-magnets/generate', `skip idempotent userId=${userId}`);
          return;
        }
        const p = await getProfile(userId);
        if (!p) return;
        const result = await callClaude(
          `You are a lead magnet strategist for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nAudience: ${p.audience_description || 'local customers'}, age ${p.audience_age_min || 18}-${p.audience_age_max || 65}\nPain point: ${p.pain_point || 'not specified'}\nLanguage: ${p.primary_language || 'English'}\n\nGenerate the BEST lead magnet. Solve ONE specific problem. High value, consumable in 10 min.\nReturn ONLY valid JSON:\n{"title":"string","type":"checklist|guide|template","headline":"string","subheadline":"string","content":"string (full content)","cta_button":"string"}`,
          'campaign',
          2000,
          claudeBiz(userId)
        );
        await sbPost('lead_magnets', {
          user_id: userId,
          title: result.title || 'Lead Magnet',
          type: result.type || 'guide',
          content: JSON.stringify(result),
          is_active: true,
        });
        storeInsight(userId, 'lead_magnets', 'content', 'lead_magnet_topic', result.title || 'lead magnet');
        storeInsight(userId, 'lead_magnets', 'content', 'lead_magnet_type', result.type || 'guide');
        await recordOrchestrationTaskRun(userId, 'lead_magnets_generate');
        log('/api/lead-magnets/generate', `✅ Lead magnet: ${result.title}`);
      } catch (err) {
        console.error('[lead-magnets]', err.message);
      }
    });
  });

  app.get('/api/lead-magnets/:userId', async (req, res) => {
    try {
      if (req.params.userId !== req.user?.id) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot read another user' } });
      }
      const r = await sbGet(
        'lead_magnets',
        `user_id=eq.${encodeURIComponent(req.params.userId)}&order=created_at.desc&limit=10`
      );
      res.json({ magnets: r });
    } catch (err) {
      res.status(500).json({ error: safePublicError(err) });
    }
  });
}

module.exports = { register };
