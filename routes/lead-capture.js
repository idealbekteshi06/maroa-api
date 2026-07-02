'use strict';

/**
 * routes/lead-capture.js — inbound lead/contact capture v1
 * ----------------------------------------------------------------------------
 * The email + lead loops were engines with no fuel line: contacts arrived only
 * via manual /webhook/contact-create or CSV import, so for a connect-and-forget
 * customer the contacts table stayed empty forever. This module adds the two
 * automatic intakes:
 *
 *   GET  /api/lead-capture/embed     (JWT)  — per-business capture endpoint +
 *                                             copy-paste HTML form snippet
 *   POST /public/lead-capture/:token (public, rate-limited, honeypot) —
 *                                             hosted form target
 *   GET  /webhook/meta-leads         (public) — Meta subscription handshake
 *                                             (hub.challenge echo)
 *   POST /webhook/meta-leads         (signed) — Meta Lead Ads leadgen intake:
 *                                             X-Hub-Signature-256 verified,
 *                                             deduped via webhook_events,
 *                                             lead fetched from the Graph API
 *                                             with the page owner's token
 *
 * Every captured lead: contacts upsert (merge-duplicates on business_id+email)
 * → contact_activities form_fill → auto-enroll in the business's active
 * signup sequence (same path as /webhook/contact-create) → lead.captured
 * event → fire-and-forget WF2 scoring (hot-lead SLA + tier land on the row).
 *
 * Token scheme (hosted form): `<businessId>.<hmac>` where hmac =
 * HMAC-SHA256(businessId, LEAD_CAPTURE_SECRET || N8N_WEBHOOK_SECRET) hex[0:32].
 * Deterministic (oauthState/streamTicket-style) — no DB column needed; rotate
 * by rotating the secret.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function captureSecret(env = process.env) {
  return env.LEAD_CAPTURE_SECRET || env.N8N_WEBHOOK_SECRET || '';
}

function signBusinessId(businessId, env = process.env) {
  const secret = captureSecret(env);
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(String(businessId)).digest('hex').slice(0, 32);
}

function makeCaptureToken(businessId, env = process.env) {
  const sig = signBusinessId(businessId, env);
  return sig ? `${businessId}.${sig}` : null;
}

function parseCaptureToken(token, env = process.env) {
  const [businessId, sig] = String(token || '').split('.');
  if (!businessId || !sig || !UUID_RE.test(businessId)) return null;
  const expected = signBusinessId(businessId, env);
  if (!expected) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return businessId;
}

// Bounded in-memory IP throttle for the public form endpoint (no external
// dependency; Upstash outages must never break lead capture). 30/min per IP.
function makeThrottle({ limit = 30, windowMs = 60000, maxEntries = 10000 } = {}) {
  const hits = new Map();
  return function allow(ip) {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.start > windowMs) {
      if (hits.size >= maxEntries) hits.clear(); // bounded — crude but safe
      hits.set(ip, { start: now, count: 1 });
      return true;
    }
    rec.count += 1;
    return rec.count <= limit;
  };
}

function register({
  app,
  express,
  requireAnyUserId,
  sbGet,
  sbPost,
  sbPatch,
  apiRequest,
  sbH,
  SUPABASE_URL,
  oauthCrypto,
  wf2, // optional — fire-and-forget lead scoring
  markProcessed, // lib/webhookEvents — Meta leadgen dedup
  log,
  env = process.env,
}) {
  if (!app || !sbGet || !sbPost || !apiRequest) {
    log?.('/lead-capture', null, 'register skipped — missing dependencies');
    return null;
  }

  // HTML forms default to application/x-www-form-urlencoded; fetch-based
  // embeds send JSON. Accept both. (The global express.json parser may have
  // already parsed a JSON body — these route parsers skip parsed requests.)
  const bodyParsers = express
    ? [express.json({ limit: '8kb' }), express.urlencoded({ extended: false, limit: '8kb' })]
    : [];
  const throttle = makeThrottle();

  // ── shared: upsert a contact + activity + enrollment + event + scoring ──
  async function captureLead({ businessId, email, firstName, lastName, phone, company, source, meta }) {
    const r = await apiRequest(
      'POST',
      `${SUPABASE_URL}/rest/v1/contacts`,
      { ...sbH(), 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
      {
        business_id: businessId,
        email,
        first_name: firstName || null,
        last_name: lastName || null,
        phone: phone || null,
        company: company || null,
        source,
        last_activity_at: new Date().toISOString(),
      }
    );
    if (![200, 201].includes(r.status)) {
      throw new Error(`contact upsert: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    const contact = Array.isArray(r.body) ? r.body[0] : r.body;
    const contactId = contact?.id;

    await sbPost('contact_activities', {
      business_id: businessId,
      contact_id: contactId,
      activity_type: 'form_fill',
      metadata: { source, ...(meta || {}) },
    }).catch(() => {});

    // Auto-enroll in the business's active signup sequence — same behavior
    // as /webhook/contact-create so all intakes feed the same email loop.
    let enrolled = false;
    try {
      const seqs = await sbGet(
        'email_sequences',
        `business_id=eq.${encodeURIComponent(businessId)}&trigger_type=eq.signup&is_active=eq.true&limit=1`
      );
      if (seqs[0]) {
        await sbPost('contact_enrollments', {
          business_id: businessId,
          contact_email: email,
          contact_name: [firstName, lastName].filter(Boolean).join(' ') || email,
          sequence_id: seqs[0].id,
          current_step: 0,
          status: 'active',
          next_send_at: new Date().toISOString(),
        });
        enrolled = true;
      }
    } catch {
      /* soft-fail — capture must never bounce on enrollment issues */
    }

    await sbPost('events', {
      business_id: businessId,
      kind: 'lead.captured',
      workflow: '2_lead_scoring',
      payload: { contact_id: contactId, email, source },
      severity: 'success',
    }).catch(() => {});

    // Fire-and-forget WF2 scoring: tier + SLA deadline land on the contact
    // row; hot leads emit wf2.lead.scored severity=success.
    if (contactId && wf2?.rescoreLead) {
      Promise.resolve(wf2.rescoreLead({ businessId, leadId: contactId })).catch((e) =>
        log?.('/lead-capture', businessId, 'wf2 scoring failed (non-fatal)', { error: e.message })
      );
    }

    return { contactId, enrolled };
  }

  // ── GET /api/lead-capture/embed — the customer's endpoint + snippet ──────
  app.get('/api/lead-capture/embed', ...(requireAnyUserId ? [requireAnyUserId] : []), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Sign in first' });
      const rows = await sbGet(
        'businesses',
        `user_id=eq.${encodeURIComponent(userId)}&select=id&order=created_at.asc&limit=1`
      ).catch(() => []);
      const businessId = rows?.[0]?.id;
      if (!businessId) return res.status(404).json({ error: 'No business yet' });
      const token = makeCaptureToken(businessId, env);
      if (!token) return res.status(503).json({ error: 'Capture secret not configured' });
      const base = env.PUBLIC_API_BASE || 'https://maroa-api-production.up.railway.app';
      const endpoint = `${base}/public/lead-capture/${token}`;
      const snippet = [
        `<form action="${endpoint}" method="POST">`,
        '  <input name="first_name" placeholder="Name" />',
        '  <input name="email" type="email" placeholder="Email" required />',
        '  <input name="phone" placeholder="Phone (optional)" />',
        '  <input name="website" style="display:none" tabindex="-1" autocomplete="off" />',
        '  <button type="submit">Get in touch</button>',
        '</form>',
      ].join('\n');
      res.json({ endpoint, token, snippet });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /public/lead-capture/:token — hosted form target ────────────────
  // Permissive CORS: the whole point is embedding on the customer's site.
  app.options('/public/lead-capture/:token', (_req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.status(204).end();
  });
  app.post('/public/lead-capture/:token', ...bodyParsers, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
      if (!throttle(ip)) return res.status(429).json({ error: 'Too many requests' });

      const businessId = parseCaptureToken(req.params.token, env);
      if (!businessId) return res.status(404).json({ error: 'Unknown capture endpoint' });

      const body = req.body || {};
      // Honeypot: real users never fill the hidden "website" input. Answer
      // 200 so bots don't learn — but store nothing.
      if (body.website) return res.json({ ok: true });

      const email = String(body.email || '')
        .trim()
        .toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 320) {
        return res.status(400).json({ error: 'Valid email required' });
      }

      const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
      const result = await captureLead({
        businessId,
        email,
        firstName: clip(body.first_name || body.name, 80),
        lastName: clip(body.last_name, 80),
        phone: clip(body.phone, 40),
        company: clip(body.company, 120),
        source: 'form',
        meta: { ip },
      });
      res.json({ ok: true, enrolled: result.enrolled });
    } catch (e) {
      log?.('/public/lead-capture', null, 'capture failed', { error: e.message });
      res.status(500).json({ error: 'Capture failed' });
    }
  });

  // ── GET /webhook/meta-leads — subscription handshake ─────────────────────
  // Returned (not registered): the caller mounts these EARLY, before the
  // global express.json parser (signature needs raw bytes) and before the
  // /webhook auth gate (Meta authenticates via its own HMAC, not our JWT).
  function metaLeadsVerify(req, res) {
    const verifyToken = env.META_LEADS_VERIFY_TOKEN || captureSecret(env);
    if (req.query['hub.mode'] === 'subscribe' && verifyToken && req.query['hub.verify_token'] === verifyToken) {
      return res.status(200).send(req.query['hub.challenge'] || '');
    }
    return res.status(403).send('Forbidden');
  }

  // ── POST /webhook/meta-leads — leadgen intake (expects Buffer req.body) ──
  async function metaLeadsIntake(req, res) {
    const appSecret = (env.META_APP_SECRET || '').trim();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

    // Rule 3 part 1 — HMAC. Meta signs the raw payload with the app secret.
    if (appSecret) {
      const sig = String(req.headers['x-hub-signature-256'] || '');
      const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`;
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } else if (env.NODE_ENV === 'production') {
      // Refuse unsigned lead intake in prod rather than accept spoofed leads.
      return res.status(503).json({ error: 'META_APP_SECRET not configured' });
    }

    // Ack fast (Meta retries on slow responses); process inline after.
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    res.json({ ok: true });

    try {
      const changes = (payload.entry || []).flatMap((e) => e.changes || []);
      for (const change of changes) {
        if (change.field !== 'leadgen') continue;
        const leadgenId = change.value?.leadgen_id;
        const pageId = change.value?.page_id;
        if (!leadgenId || !pageId) continue;

        // Rule 3 part 3 — idempotency: Meta redelivers on any hiccup.
        if (markProcessed) {
          const dedup = await markProcessed({
            provider: 'meta_leads',
            eventId: String(leadgenId),
            sbPost,
            sbPatch,
            sbGet,
          }).catch(() => ({ firstTime: true }));
          if (!dedup.firstTime) continue;
        }

        // Page → business. facebook_page_id is stamped at Meta connect.
        const bizRows = await sbGet(
          'businesses',
          `facebook_page_id=eq.${encodeURIComponent(String(pageId))}&select=id,meta_access_token,meta_access_token_enc&limit=1`
        ).catch(() => []);
        const business = bizRows?.[0];
        if (!business) {
          log?.('/webhook/meta-leads', null, 'no business for page — lead dropped', { pageId, leadgenId });
          continue;
        }

        const token = oauthCrypto ? oauthCrypto.readToken(business, 'meta_access_token') : null;
        if (!token) {
          log?.('/webhook/meta-leads', business.id, 'no Meta token — cannot fetch lead', { leadgenId });
          continue;
        }

        // Pull the actual lead fields from the Graph API.
        const lead = await apiRequest(
          'GET',
          `https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}?fields=field_data,created_time&access_token=${encodeURIComponent(token)}`,
          {},
          null
        );
        if (lead.status >= 300) {
          log?.('/webhook/meta-leads', business.id, 'lead fetch failed', {
            leadgenId,
            status: lead.status,
          });
          continue;
        }

        const fields = {};
        for (const f of lead.body?.field_data || []) {
          fields[String(f.name || '').toLowerCase()] = Array.isArray(f.values) ? f.values[0] : f.values;
        }
        const email = String(fields.email || fields.work_email || '')
          .trim()
          .toLowerCase();
        if (!EMAIL_RE.test(email)) {
          log?.('/webhook/meta-leads', business.id, 'lead without usable email — skipped', { leadgenId });
          continue;
        }
        const fullName = String(fields.full_name || '').trim();
        await captureLead({
          businessId: business.id,
          email,
          firstName: fields.first_name || (fullName ? fullName.split(/\s+/)[0] : null),
          lastName: fields.last_name || (fullName ? fullName.split(/\s+/).slice(1).join(' ') || null : null),
          phone: fields.phone_number || fields.phone || null,
          company: fields.company_name || null,
          source: 'meta_lead_ad',
          meta: { leadgen_id: leadgenId, page_id: pageId },
        });
      }
    } catch (e) {
      log?.('/webhook/meta-leads', null, 'processing failed', { error: e.message });
    }
  }

  log?.('/lead-capture', null, 'lead-capture routes registered');
  return { metaLeadsVerify, metaLeadsIntake };
}

module.exports = { register, makeCaptureToken, parseCaptureToken, makeThrottle };
