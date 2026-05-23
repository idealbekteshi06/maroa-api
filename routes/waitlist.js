'use strict';

/**
 * routes/waitlist.js — pre-launch waitlist registration + count.
 *
 * Public endpoints:
 *   POST /api/waitlist/register — sign up with name + email
 *   GET  /api/waitlist/count    — public count for marketing site
 *
 * Carved from server.js per the routes/observability.js pattern.
 */

function register({ app, validate, sbGet, sbPost, sendEmail, apiError, safePublicError }) {
  app.post('/api/waitlist/register', validate('waitlist'), async (req, res) => {
    const { name, email, plan, business_type, country } = req.validatedBody;

    try {
      await sbPost('waitlist', {
        name,
        email,
        plan: plan || null,
        business_type: business_type || null,
        country: country || null,
      });
    } catch (err) {
      if (err.message && err.message.includes('23505')) {
        return apiError(res, 409, 'CONFLICT', 'Email already registered');
      }
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }

    // Confirmation email to the user (fire-and-forget — never block the
    // response on email delivery)
    const userHtml = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
<h2 style="color:#667eea">You're on the maroa.ai waitlist! 🚀</h2>
<p>Hi ${name},</p>
<p>You're officially on the maroa.ai early access list!</p>
<p><strong>Your pre-launch price is locked:</strong></p>
<table style="border-collapse:collapse;margin:12px 0;font-size:14px">
<tr><td style="padding:6px 16px 6px 0">Starter</td><td style="padding:6px 0"><strong>$25/mo</strong></td></tr>
<tr><td style="padding:6px 16px 6px 0">Growth</td><td style="padding:6px 0"><strong>€39/mo</strong> <span style="text-decoration:line-through;color:#94a3b8">€69</span></td></tr>
<tr><td style="padding:6px 16px 6px 0">Agency</td><td style="padding:6px 0"><strong>€79/mo</strong> <span style="text-decoration:line-through;color:#94a3b8">€149</span></td></tr>
</table>
<p>We launch <strong>April 28, 2026</strong>. You'll be the first to know.</p>
<p>Your <strong>1 week free trial</strong> starts automatically on launch day.</p>
<p style="margin-top:20px">See you on April 28! 🚀<br/>— The maroa.ai team</p>
</div>`;
    sendEmail(email, "You're on the maroa.ai waitlist! 🚀", userHtml).catch(() => {
      /* user-confirmation soft-fail */
    });

    sendEmail(
      'idealbekteshi06@gmail.com',
      `New waitlist signup: ${name} — ${plan || 'no plan'}`,
      `<p><strong>New waitlist registration</strong></p><p>Name: ${name}<br/>Email: ${email}<br/>Plan: ${plan || 'not selected'}<br/>Business type: ${business_type || 'not specified'}<br/>Country: ${country || 'not specified'}<br/>Time: ${new Date().toISOString()}</p>`
    ).catch(() => {
      /* admin-notification soft-fail */
    });

    res.json({ success: true, message: 'Welcome to the waitlist!' });
  });

  app.get('/api/waitlist/count', async (req, res) => {
    try {
      const rows = await sbGet('waitlist', 'select=id');
      res.json({ count: Array.isArray(rows) ? rows.length : 0 });
    } catch (err) {
      res.json({ count: 0 });
    }
  });
}

module.exports = { register };
