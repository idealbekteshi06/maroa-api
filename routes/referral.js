'use strict';

/**
 * routes/referral.js — double-sided referral program endpoints.
 *
 * Public endpoints:
 *   POST /api/referral/setup           — generate program + share copy
 *   GET  /api/referral/status/:userId  — fetch program for a user
 *   POST /api/referral/track           — register a referred email
 *
 * Carved from server.js per the routes/waitlist.js pattern.
 */

const crypto = require('crypto');

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
  app.post('/api/referral/setup', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json({ received: true, message: 'Generating referral program' });
    setImmediate(async () => {
      try {
        const p = await getProfile(userId);
        if (!p) return;
        const code = crypto.randomBytes(4).toString('hex');
        const result = await callClaude(
          `You are a referral program expert for ${p.business_name}, a ${p.business_type} in ${pCity(p)}.\nAvg spend: ${p.avg_spend || 'moderate'}\nLanguage: ${p.primary_language || 'English'}\n\nDesign a double-sided referral reward program.\nReturn ONLY valid JSON:\n{"reward_for_referrer":"string","reward_for_referee":"string","trigger_moments":["string"],"share_message":"string (${p.primary_language}, max 160 chars)","email_subject":"string","email_body":"string"}`,
          'email',
          1000,
          claudeBiz(userId)
        );
        await sbPost('referral_programs', {
          user_id: userId,
          referral_code: code,
          reward_type: 'discount',
          reward_value: result.reward_for_referee || '20%',
          is_active: true,
        });
        storeInsight(
          userId,
          'referral',
          'program',
          'reward_structure',
          `${result.reward_for_referrer || ''} / ${result.reward_for_referee || ''}`
        );
        log('/api/referral/setup', `✅ Referral program created for ${p.business_name}`);
      } catch (err) {
        console.error('[referral/setup]', err.message);
      }
    });
  });

  app.get('/api/referral/status/:userId', async (req, res) => {
    try {
      const r = await sbGet('referral_programs', `user_id=eq.${req.params.userId}&select=*`);
      res.json(r[0] || { active: false });
    } catch (err) {
      res.status(500).json({ error: safePublicError(err) });
    }
  });

  app.post('/api/referral/track', async (req, res) => {
    const { referral_code, referred_email } = req.body;
    if (!referral_code) return res.status(400).json({ error: 'referral_code required' });
    try {
      const progs = await sbGet('referral_programs', `referral_code=eq.${referral_code}&select=user_id`);
      if (!progs[0]) return res.status(404).json({ error: 'Invalid referral code' });
      await sbPost('referrals', { referrer_id: progs[0].user_id, referred_email, status: 'pending' });
      res.json({ tracked: true });
    } catch (err) {
      res.status(500).json({ error: safePublicError(err) });
    }
  });
}

module.exports = { register };
