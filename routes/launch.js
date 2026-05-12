'use strict';

/**
 * routes/launch.js — product launch campaign endpoints.
 *
 * Public endpoints:
 *   POST /api/launch/create     — generate ORB launch plan (fire-and-forget)
 *   GET  /api/launch/:userId    — list recent launch campaigns
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
  log,
  safePublicError,
}) {
  app.post('/api/launch/create', async (req, res) => {
    const { userId, productName, launchDate, productDescription } = req.body;
    if (!userId || !productName) return res.status(400).json({ error: 'userId and productName required' });
    res.json({ received: true, message: 'Building launch campaign' });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const result = await callClaude(
          `You are a launch strategist for ${p.business_name} launching: ${productName}\nDescription: ${productDescription || 'new product'}\nLaunch date: ${launchDate || 'in 2 weeks'}\nBusiness: ${p.business_type} in ${pCity(p)}\nLanguage: ${p.primary_language}\nBudget: ${p.monthly_budget}\nAudience: ${p.audience_description}\n\nUsing ORB launch framework, create complete launch plan:\n- PRE-LAUNCH: 3 teaser posts + 1 email\n- LAUNCH DAY: announcement post + launch email + ad copy\n- POST-LAUNCH: 2 social proof posts + follow-up email\n\nReturn ONLY valid JSON:\n{"pre_launch":{"posts":["string"],"email":{"subject":"string","body":"string"}},"launch_day":{"post":"string","email":{"subject":"string","body":"string"},"ad_copy":"string"},"post_launch":{"posts":["string"],"email":{"subject":"string","body":"string"}}}`,
          'strategy',
          3000,
          claudeBiz(userId)
        );
        await sbPost('launch_campaigns', {
          user_id: userId,
          product_name: productName,
          launch_date: launchDate || new Date(Date.now() + 14 * 86400000).toISOString(),
          phase: 'pre_launch',
          content_plan: JSON.stringify(result),
        });
        storeInsight(userId, 'launch', 'campaign', 'product_launching', productName);
        log('/api/launch/create', `✅ Launch plan for ${productName}`);
      } catch (err) {
        console.error('[launch]', err.message);
      }
    });
  });

  app.get('/api/launch/:userId', async (req, res) => {
    try {
      const r = await sbGet('launch_campaigns', `user_id=eq.${req.params.userId}&order=created_at.desc&limit=5`);
      res.json({ campaigns: r });
    } catch (err) {
      res.status(500).json({ error: safePublicError(err) });
    }
  });
}

module.exports = { register };
