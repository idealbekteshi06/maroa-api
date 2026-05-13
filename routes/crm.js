'use strict';

/**
 * routes/crm.js — CRM (contacts + deals + pipeline).
 *
 * Carved from server.js as part of the 2026-05-13 audit P4 (server.js
 * carve-up). 8 endpoints + the lead-score-weights constant:
 *
 *   POST /webhook/contact-create         — upsert contact, auto-enroll signup
 *   POST /webhook/contact-update         — update fields, log change
 *   POST /webhook/contact-import         — bulk import contacts (CSV-like)
 *   GET  /webhook/contacts-get           — list contacts + filter
 *   POST /webhook/contact-activity-log   — log activity, recompute lead score
 *   GET  /webhook/pipeline-get           — deals by stage + top contacts
 *   POST /webhook/deal-create            — create deal
 *   POST /webhook/deal-stage-update      — move deal between stages
 *
 * Lead-score weights stay co-located with the routes that use them.
 * Behavior unchanged. Dep injection makes the module testable.
 */

function register({
  app,
  sbGet,
  sbPost,
  sbPatch,
  callClaude,
  sendEmail,
  isUUID,
  log,
  apiRequest,
  sbH,
  SUPABASE_URL,
  storeInsight,
}) {
  // ── Lead score weights ────────────────────────────────────────────────────────
  const SCORE_WEIGHTS = {
    email_open: 5,
    email_click: 10,
    page_visit: 3,
    form_fill: 20,
    ad_click: 8,
    purchase: 50,
    meeting: 30,
    call: 15,
    email_bounce: -5,
  };
  
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/contact-create
  // UPSERT contact, log activity, auto-enroll in signup sequence.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/contact-create', async (req, res) => {
    const { business_id, email, first_name, last_name, phone, company, source = 'manual', tags = [] } = req.body;
    if (!business_id || !email) return res.status(400).json({ error: 'business_id and email required' });
  
    try {
      // UPSERT via REST: POST with Prefer: resolution=merge-duplicates
      const r = await apiRequest(
        'POST',
        `${SUPABASE_URL}/rest/v1/contacts`,
        { ...sbH(), 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
        {
          business_id,
          email,
          first_name,
          last_name,
          phone,
          company,
          source,
          tags,
          last_activity_at: new Date().toISOString(),
        }
      );
  
      if (![200, 201].includes(r.status))
        throw new Error(`contact upsert: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  
      const contact = Array.isArray(r.body) ? r.body[0] : r.body;
      const contact_id = contact?.id;
      if (!contact_id) throw new Error('No contact id returned');
  
      // Log creation activity
      await sbPost('contact_activities', {
        business_id,
        contact_id,
        activity_type: 'contact_created',
        metadata: { source },
      });
  
      // Auto-enroll in 'signup' sequence if one exists
      let enrolled = false;
      try {
        const seqs = await sbGet(
          'email_sequences',
          `business_id=eq.${business_id}&trigger_type=eq.signup&is_active=eq.true&limit=1`
        );
        if (seqs[0]) {
          await sbPost('contact_enrollments', {
            business_id,
            contact_email: email,
            contact_name: [first_name, last_name].filter(Boolean).join(' ') || email,
            sequence_id: seqs[0].id,
            current_step: 0,
            status: 'active',
            next_send_at: new Date().toISOString(),
          });
          enrolled = true;
        }
      } catch {
        /* soft-fail */
      }
  
      res.json({ success: true, contact_id, enrolled_in_sequence: enrolled });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/contact-update
  // Update arbitrary fields on a contact.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/contact-update', async (req, res) => {
    const { contact_id, ...fields } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    delete fields.id;
    delete fields.business_id;
    delete fields.created_at;
    try {
      await sbPatch('contacts', `id=eq.${contact_id}`, {
        ...fields,
        last_activity_at: new Date().toISOString(),
      });
      res.json({ success: true, contact_id, updated: fields });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/contact-import
  // Bulk UPSERT contacts from CSV array. Dedupe on (business_id, email).
  // Body: { business_id, contacts: [{email, first_name, ...}] }
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/contact-import', async (req, res) => {
    const { business_id, contacts = [] } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!contacts.length) return res.json({ imported: 0, updated: 0, failed: 0 });
  
    let imported = 0,
      updated = 0,
      failed = 0;
    for (const c of contacts) {
      if (!c.email) {
        failed++;
        continue;
      }
      try {
        // Check if exists
        const existing = await sbGet(
          'contacts',
          `business_id=eq.${business_id}&email=eq.${encodeURIComponent(c.email)}&select=id`
        );
        await apiRequest(
          'POST',
          `${SUPABASE_URL}/rest/v1/contacts`,
          { ...sbH(), 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates' },
          { business_id, source: 'import', ...c, last_activity_at: new Date().toISOString() }
        );
        existing.length ? updated++ : imported++;
      } catch {
        failed++;
      }
    }
    res.json({ imported, updated, failed, total: contacts.length });
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/contacts-get
  // ?business_id=X [&stage=X] [&min_score=X] [&limit=50] [&offset=0]
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/contacts-get', async (req, res) => {
    const { business_id, stage, min_score, limit = 50, offset = 0 } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      let filter = `business_id=eq.${business_id}&order=lead_score.desc&limit=${limit}&offset=${offset}`;
      if (stage) filter += `&stage=eq.${stage}`;
      if (min_score) filter += `&lead_score=gte.${min_score}`;
  
      const contacts = await sbGet('contacts', filter);
  
      // Count total (without limit)
      let countFilter = `business_id=eq.${business_id}`;
      if (stage) countFilter += `&stage=eq.${stage}`;
      if (min_score) countFilter += `&lead_score=gte.${min_score}`;
      const countR = await apiRequest('GET', `${SUPABASE_URL}/rest/v1/contacts?${countFilter}&select=id`, {
        ...sbH(),
        Prefer: 'count=exact',
      });
      const total = parseInt(countR.body?.length || contacts.length);
  
      res.json({ contacts, total, limit: Number(limit), offset: Number(offset) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/contact-activity-log  — UPGRADE 6: AI LEAD SCORING
  // Log activity, use Claude Sonnet to evaluate full contact history,
  // returns score 0-100 + intent_level + recommended_action.
  // If ready_to_buy: enroll in priority sequence + send alert email.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/contact-activity-log', async (req, res) => {
    const { business_id, contact_id, activity_type, metadata = {} } = req.body;
    if (!business_id || !contact_id || !activity_type)
      return res.status(400).json({ error: 'business_id, contact_id, activity_type required' });
    if (!isUUID(contact_id)) return res.status(400).json({ error: 'contact_id must be a valid UUID' });
  
    try {
      // Insert activity
      await sbPost('contact_activities', { business_id, contact_id, activity_type, metadata });
  
      // Fetch full contact + all activities for AI scoring
      const [contactArr, activities, bizArr] = await Promise.all([
        sbGet('contacts', `id=eq.${contact_id}&select=*&limit=1`),
        sbGet(
          'contact_activities',
          `contact_id=eq.${contact_id}&select=activity_type,metadata,created_at&order=created_at.desc&limit=30`
        ),
        sbGet('businesses', `id=eq.${business_id}&select=business_name,industry,email`),
      ]);
      const contact = contactArr[0];
      const biz = bizArr[0];
      const old_score = contact?.lead_score || 0;
      const old_stage = contact?.stage || 'lead';
      const old_intent = contact?.intent_level || 'cold';
  
      // ── Static score as baseline (fast) ──────────────────────────────────
      const staticScore = activities.reduce((sum, a) => sum + (SCORE_WEIGHTS[a.activity_type] || 0), 0);
  
      // ── AI scoring with Claude Sonnet (full context) ─────────────────────
      let aiScore = staticScore;
      let intentLevel = old_intent;
      let recommendedAction = '';
  
      // Only call Claude if there are enough activities to justify it
      if (activities.length >= 3) {
        try {
          const activitySummary = activities
            .map((a) => `${a.activity_type} at ${a.created_at}${a.metadata ? ' | ' + JSON.stringify(a.metadata) : ''}`)
            .join('\n');
  
          const prompt = `You are an AI lead scoring engine. Evaluate this contact's buying intent.
  
  CONTACT: ${contact?.first_name || ''} ${contact?.last_name || ''} (${contact?.email || ''})
  SOURCE: ${contact?.source || 'unknown'} | CURRENT STAGE: ${old_stage}
  COMPANY: ${contact?.company || 'unknown'}
  BUSINESS: ${biz?.business_name || ''} (${biz?.industry || ''})
  
  FULL ACTIVITY HISTORY (most recent first):
  ${activitySummary}
  
  SCORING GUIDE:
  - email_open=5, email_click=10, page_visit=3, form_fill=20, ad_click=8, purchase=50, meeting=30, call=15
  
  Evaluate the PATTERN of behavior, not just the sum. Consider:
  - Recency (recent activity = higher intent)
  - Frequency (multiple touches = building interest)
  - Depth (form fills, meetings > casual opens)
  - Velocity (how fast they're moving through the funnel)
  
  Return ONLY valid JSON:
  {
    "score": 0-100,
    "intent_level": "cold" | "warm" | "hot" | "ready_to_buy",
    "recommended_action": "specific next step",
    "reasoning": "1-2 sentences why"
  }`;
  
          const aiResult = await callClaude(prompt, 'social_post', 500);
          if (aiResult.score !== undefined) aiScore = Math.max(0, Math.min(100, aiResult.score));
          if (aiResult.intent_level) intentLevel = aiResult.intent_level;
          if (aiResult.recommended_action) recommendedAction = aiResult.recommended_action;
        } catch (aiErr) {
          log('/webhook/contact-activity-log', `AI scoring fallback to static: ${aiErr.message}`);
        }
      }
  
      // ── Update contact ──────────────────────────────────────────────────
      const updates = {
        lead_score: aiScore,
        intent_level: intentLevel,
        recommended_action: recommendedAction,
        last_activity_at: new Date().toISOString(),
      };
      let stage_changed = false;
  
      // Auto-qualify if score >= 50 and still a lead
      if (old_score < 50 && aiScore >= 50 && old_stage === 'lead') {
        updates.stage = 'qualified';
        stage_changed = true;
      }
  
      // Auto-escalate: ready_to_buy → enroll in priority sequence + alert
      if (intentLevel === 'ready_to_buy' && old_intent !== 'ready_to_buy') {
        updates.stage = 'opportunity';
        stage_changed = true;
  
        // Enroll in priority / ready_to_buy sequence
        try {
          const seqs = await sbGet(
            'email_sequences',
            `business_id=eq.${business_id}&trigger_type=eq.ready_to_buy&is_active=eq.true&limit=1`
          );
          // Fall back to qualified sequence
          const seq =
            seqs[0] ||
            (
              await sbGet(
                'email_sequences',
                `business_id=eq.${business_id}&trigger_type=eq.qualified&is_active=eq.true&limit=1`
              )
            )[0];
          if (seq && contact) {
            await sbPost('contact_enrollments', {
              business_id,
              contact_email: contact.email,
              contact_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
              sequence_id: seq.id,
              current_step: 0,
              status: 'active',
              next_send_at: new Date().toISOString(),
            });
          }
        } catch {
          /* soft-fail */
        }
  
        // Send alert email to business owner
        if (biz?.email && contact) {
          const html = `<h2>🔥 Ready-to-Buy Lead Detected!</h2>
  <p><strong>${contact.first_name || ''} ${contact.last_name || ''}</strong> (${contact.email}) scored <strong>${aiScore}/100</strong> and is ready to buy.</p>
  <p><strong>Recommended action:</strong> ${recommendedAction}</p>
  <p><a href="https://maroa.ai/crm" style="background:#667eea;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">View in CRM</a></p>`;
          sendEmail(biz.email, `🔥 ${contact.first_name || 'Lead'} is ready to buy — ${biz.business_name}`, html).catch(
            () => {}
          );
        }
      }
  
      await sbPatch('contacts', `id=eq.${contact_id}`, updates);
      try {
        if (intentLevel === 'ready_to_buy' || aiScore >= 75)
          storeInsight(
            business_id,
            'leads',
            'lead_intelligence',
            'lead_quality_pattern',
            `Score ${aiScore}, intent: ${intentLevel}, source: ${contact?.source || 'unknown'}`
          );
      } catch {
        /* soft-fail */
      }
      res.json({
        success: true,
        new_score: aiScore,
        old_score,
        intent_level: intentLevel,
        recommended_action: recommendedAction,
        stage_changed,
        ai_scored: activities.length >= 3,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // GET /webhook/pipeline-get?business_id=X
  // Deals grouped by stage + top contacts by score.
  // ─────────────────────────────────────────────────────────────────────────────
  app.get('/webhook/pipeline-get', async (req, res) => {
    const { business_id } = req.query;
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    try {
      const [deals, top_contacts] = await Promise.all([
        sbGet('deals', `business_id=eq.${business_id}&order=created_at.desc`),
        sbGet(
          'contacts',
          `business_id=eq.${business_id}&order=lead_score.desc&limit=10&select=id,email,first_name,last_name,lead_score,stage`
        ),
      ]);
  
      const stages = ['new', 'contacted', 'proposal', 'negotiation', 'won', 'lost'];
      const pipeline = stages.reduce((acc, s) => {
        const group = deals.filter((d) => d.stage === s);
        acc[s] = {
          count: group.length,
          value: group.reduce((sum, d) => sum + parseFloat(d.value || 0), 0).toFixed(2),
          deals: group,
        };
        return acc;
      }, {});
  
      const total_value = deals.reduce((sum, d) => sum + parseFloat(d.value || 0), 0).toFixed(2);
      const weighted_value = deals
        .reduce((sum, d) => sum + (parseFloat(d.value || 0) * (d.probability || 0)) / 100, 0)
        .toFixed(2);
  
      res.json({ pipeline, total_value, weighted_value, total_deals: deals.length, top_contacts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/deal-create
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/deal-create', async (req, res) => {
    const {
      business_id,
      contact_id,
      title,
      value = 0,
      stage = 'new',
      probability = 0,
      expected_close_date,
      notes,
    } = req.body;
    if (!business_id || !title) return res.status(400).json({ error: 'business_id and title required' });
    try {
      const deal = await sbPost('deals', {
        business_id,
        contact_id,
        title,
        value,
        stage,
        probability,
        expected_close_date,
        notes,
      });
      res.json({ success: true, deal_id: deal?.id, deal });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /webhook/deal-stage-update
  // ─────────────────────────────────────────────────────────────────────────────
  app.post('/webhook/deal-stage-update', async (req, res) => {
    const { deal_id, stage, probability, notes } = req.body;
    if (!deal_id || !stage) return res.status(400).json({ error: 'deal_id and stage required' });
    try {
      const updates = { stage };
      if (probability !== undefined) updates.probability = probability;
      if (notes) updates.notes = notes;
      await sbPatch('deals', `id=eq.${deal_id}`, updates);
      res.json({ success: true, deal_id, stage });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
