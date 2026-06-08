'use strict';

/**
 * routes/email-lifecycle.js — Resend-driven, trigger-based email blasts.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4 (server.js
 * carve-up). 4 endpoints around the "email-sequence" workflow:
 *
 *   POST /webhook/email-sequence-create   — create a sequence
 *   POST /webhook/email-enroll            — enroll a contact
 *   POST /webhook/email-trigger           — Resend event receiver (open / click / bounce)
 *   POST /webhook/email-sequence-process  — cron tick: send all due emails
 *
 * Single-writer consolidation (migration 090): this legacy trigger-based system
 * now reads/writes its OWN `email_blast_sequences` table (trigger_type + inline
 * `emails[]`), NOT the shared `email_sequences` table — which is owned solely by
 * the canonical services/email-lifecycle engine (stage/cadence_days +
 * email_sequence_runs). See CANONICAL_WORKFLOWS.md. Enrollment state still lives
 * in contact_enrollments.
 *
 * Behavior otherwise unchanged. Dep injection makes the module testable.
 */

function register({ app, sbGet, sbPost, sbPatch, callClaude, sendEmailWithTags, log, logError }) {
  // ───────────────────────────────────────────────────────────────────────
  // POST /webhook/email-sequence-create
  // ───────────────────────────────────────────────────────────────────────
  app.post('/webhook/email-sequence-create', async (req, res) => {
    const { business_id, name, trigger_type, trigger_value, delay_hours = 0, emails = [] } = req.body;
    const VALID_TRIGGERS = ['signup', 'no_open_7d', 'link_click', 'purchase', 'cart_abandon'];
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!VALID_TRIGGERS.includes(trigger_type))
      return res.status(400).json({ error: `trigger_type must be one of: ${VALID_TRIGGERS.join(', ')}` });
    if (!Array.isArray(emails) || !emails.length)
      return res.status(400).json({ error: 'emails array required (min 1 item)' });
    try {
      const seq = await sbPost('email_blast_sequences', {
        business_id,
        name,
        trigger_type,
        trigger_value: trigger_value || null,
        delay_hours,
        is_active: true,
        emails,
      });
      res.json({ sequence_id: seq.id, name: seq.name, trigger_type: seq.trigger_type, email_count: emails.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /webhook/email-enroll
  // Enrolls a contact into the first active sequence matching trigger_type.
  // Deduplication: silently skips if already active in the same sequence.
  // ───────────────────────────────────────────────────────────────────────
  app.post('/webhook/email-enroll', async (req, res) => {
    const { business_id, contact_email, contact_name, trigger_type, sequence_id } = req.body;
    if (!business_id || !contact_email)
      return res.status(400).json({ error: 'business_id and contact_email required' });
    res.json({ received: true, message: 'Enrollment processing' });

    try {
      let seq;
      if (sequence_id) {
        seq = (await sbGet('email_blast_sequences', `id=eq.${sequence_id}&is_active=eq.true`))[0];
      } else if (trigger_type) {
        seq = (
          await sbGet(
            'email_blast_sequences',
            `business_id=eq.${business_id}&trigger_type=eq.${trigger_type}&is_active=eq.true&limit=1`
          )
        )[0];
      }
      if (!seq) {
        return log('/webhook/email-enroll', `No active sequence for trigger=${trigger_type} biz=${business_id}`);
      }

      const existing = await sbGet(
        'contact_enrollments',
        `contact_email=eq.${encodeURIComponent(contact_email)}&sequence_id=eq.${seq.id}&status=eq.active`
      );
      if (existing.length) {
        return log('/webhook/email-enroll', `Already enrolled: ${contact_email} → seq ${seq.id}`);
      }

      const firstDelay = seq.emails?.[0]?.delay_hours ?? seq.delay_hours ?? 0;
      const nextSendAt = new Date(Date.now() + firstDelay * 3600000).toISOString();

      await sbPost('contact_enrollments', {
        business_id,
        contact_email,
        contact_name: contact_name || null,
        sequence_id: seq.id,
        current_step: 0,
        status: 'active',
        next_send_at: nextSendAt,
      });
      log('/webhook/email-enroll', `✅ Enrolled ${contact_email} into "${seq.name}" (next: ${nextSendAt})`);
    } catch (err) {
      console.error('[email-enroll ERROR]', err.message);
      await logError(business_id, 'email-enroll', err.message, req.body);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /webhook/email-trigger — Resend webhook receiver
  // Must respond 200 immediately. Handles open / click / bounce events.
  // Register this URL in Resend Dashboard → Webhooks.
  // ───────────────────────────────────────────────────────────────────────
  app.post('/webhook/email-trigger', async (req, res) => {
    res.json({ received: true });

    try {
      const { type, data = {} } = req.body;
      const contact_email = Array.isArray(data.to) ? data.to[0] : data.email_address || '';
      const tags = data.tags || {};
      const business_id = tags.business_id || null;
      if (!contact_email) return;

      if (type === 'email.bounced') {
        await sbPatch('contact_enrollments', `contact_email=eq.${encodeURIComponent(contact_email)}&status=eq.active`, {
          status: 'bounced',
        });
        return log('/webhook/email-trigger', `Bounce recorded: ${contact_email}`);
      }

      if (type === 'email.opened' && business_id) {
        try {
          await sbPost('retention_logs', {
            business_id,
            email_type: 'email_opened',
            subject: data.subject || 'email opened',
            sent_at: new Date().toISOString(),
          });
        } catch {
          /* retention_logs schema may vary */
        }
        return log('/webhook/email-trigger', `Open recorded: ${contact_email}`);
      }

      if (type === 'email.clicked' && business_id) {
        const seqs = await sbGet(
          'email_blast_sequences',
          `business_id=eq.${business_id}&trigger_type=eq.link_click&is_active=eq.true&limit=1`
        );
        if (!seqs.length) return;
        const already = await sbGet(
          'contact_enrollments',
          `contact_email=eq.${encodeURIComponent(contact_email)}&sequence_id=eq.${seqs[0].id}&status=eq.active`
        );
        if (!already.length) {
          await sbPost('contact_enrollments', {
            business_id,
            contact_email,
            sequence_id: seqs[0].id,
            current_step: 0,
            status: 'active',
            next_send_at: new Date().toISOString(),
          });
          log('/webhook/email-trigger', `Click-enrolled ${contact_email} → link_click sequence`);
        }
      }
    } catch (err) {
      console.error('[email-trigger ERROR]', err.message);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /webhook/email-sequence-process
  // Processes ALL due enrollments across all businesses (up to 50 per run).
  // Called by WF36 every 30 minutes. No request body needed.
  // ───────────────────────────────────────────────────────────────────────
  app.post('/webhook/email-sequence-process', async (req, res) => {
    res.json({ received: true, message: 'Processing email sequences' });

    let processed = 0;
    let sent = 0;
    let completed = 0;
    try {
      const now = new Date().toISOString();
      const due = await sbGet('contact_enrollments', `next_send_at=lte.${now}&status=eq.active&select=*&limit=50`);

      for (const enrollment of due) {
        try {
          processed++;

          const seq = (await sbGet('email_blast_sequences', `id=eq.${enrollment.sequence_id}`))[0];
          if (!seq?.emails?.[enrollment.current_step]) {
            await sbPatch('contact_enrollments', `id=eq.${enrollment.id}`, { status: 'completed', completed_at: now });
            completed++;
            continue;
          }

          const step = seq.emails[enrollment.current_step];
          const biz = (
            await sbGet('businesses', `id=eq.${enrollment.business_id}&select=business_name,brand_tone,industry`)
          )[0];
          if (!biz) continue;

          const contactName = enrollment.contact_name || enrollment.contact_email.split('@')[0];
          const prompt = `Write a marketing email for ${contactName} from ${biz.business_name}.
Tone: ${biz.brand_tone || 'professional and friendly'}
Subject goal: ${step.subject_prompt || 'Engaging marketing subject'}
Body goal: ${step.body_prompt || 'Valuable content with one clear CTA'}
Max 200 words. Conversational, personal, one clear action at the end.
Return ONLY valid JSON: {"subject":"...","body_html":"..."}`;

          const email = await callClaude(prompt, 'social_post', 600);
          if (!email.subject || !email.body_html) {
            log('/webhook/email-sequence-process', `Claude parse fail — enrollment ${enrollment.id}`);
            continue;
          }

          await sendEmailWithTags(enrollment.contact_email, email.subject, email.body_html, [
            { name: 'business_id', value: enrollment.business_id },
            { name: 'sequence_id', value: enrollment.sequence_id },
            { name: 'step', value: String(enrollment.current_step) },
          ]);
          sent++;

          const isLast = enrollment.current_step + 1 >= seq.emails.length;
          if (isLast) {
            await sbPatch('contact_enrollments', `id=eq.${enrollment.id}`, { status: 'completed', completed_at: now });
            completed++;
          } else {
            const nextStep = seq.emails[enrollment.current_step + 1];
            const delayHours = nextStep.delay_hours ?? 24;
            await sbPatch('contact_enrollments', `id=eq.${enrollment.id}`, {
              current_step: enrollment.current_step + 1,
              next_send_at: new Date(Date.now() + delayHours * 3600000).toISOString(),
            });
          }
        } catch (stepErr) {
          console.error(`[email-sequence-process] step error ${enrollment.id}:`, stepErr.message);
          await logError(enrollment.business_id, 'email-sequence-process', stepErr.message, {
            enrollment_id: enrollment.id,
          });
        }
      }
      log('/webhook/email-sequence-process', `✅ processed=${processed} sent=${sent} completed=${completed}`);
    } catch (err) {
      console.error('[email-sequence-process ERROR]', err.message);
    }
  });
}

module.exports = { register };
