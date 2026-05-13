'use strict';

/**
 * routes/org-management.js — Agency multi-workspace management.
 *
 * Carved from server.js as part of the 2026-05-13 audit P4 (server.js
 * carve-up: 15.6k → <4k lines). All routes gated by planGate('multi_workspace')
 * or planGate('white_label') for the agency tier.
 *
 * Public endpoints:
 *   POST /webhook/org-create               — create an organization
 *   GET  /webhook/org-get?org_id=          — read org + members + workspaces
 *   POST /webhook/org-add-workspace        — add a workspace (max 20/org)
 *   POST /webhook/org-invite-member        — email-invite a member
 *   POST /webhook/org-white-label-update   — update white-label fields
 *
 * Behavior unchanged from inline. Dep-injected for testability.
 */

function register({ app, sbGet, sbPost, sbPatch, sendEmail, planGate, log, logError }) {
  // POST /webhook/org-create
  // Body: { business_id, name }
  app.post('/webhook/org-create', planGate('multi_workspace'), async (req, res) => {
    const { business_id, name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json({ received: true, message: 'Creating organization' });

    try {
      const biz = (await sbGet('businesses', `id=eq.${business_id}&select=user_id,email`))[0];
      if (!biz) return;

      const org = await sbPost('organizations', {
        name,
        owner_user_id: biz.user_id || null,
        plan: 'agency',
      });
      if (biz.user_id && org?.id) {
        await sbPost('organization_members', {
          organization_id: org.id,
          user_id: biz.user_id,
          role: 'owner',
        });
      }
      if (org?.id) {
        await sbPatch('businesses', `id=eq.${business_id}`, { organization_id: org.id });
      }
      log('/webhook/org-create', `Org "${name}" created — id: ${org?.id}`);
    } catch (err) {
      console.error('[org-create ERROR]', err.message);
      await logError(business_id, 'org-create', err.message, req.body);
    }
  });

  // GET /webhook/org-get?org_id=...&business_id=...
  app.get('/webhook/org-get', async (req, res) => {
    const org_id = req.query.org_id || req.query.organization_id;
    if (!org_id) return res.status(400).json({ error: 'org_id required' });
    try {
      const org = (await sbGet('organizations', `id=eq.${org_id}`))[0];
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      const members = await sbGet('organization_members', `organization_id=eq.${org_id}`);
      const workspaces = await sbGet('workspaces', `organization_id=eq.${org_id}`);
      res.json({ organization: org, members, workspaces, workspace_count: workspaces.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /webhook/org-add-workspace
  // Body: { business_id, org_id, name, client_name? }
  app.post('/webhook/org-add-workspace', planGate('multi_workspace'), async (req, res) => {
    const { business_id, org_id, name, client_name } = req.body;
    if (!org_id || !name) return res.status(400).json({ error: 'org_id and name required' });
    res.json({ received: true, message: 'Adding workspace' });

    try {
      const existing = await sbGet('workspaces', `organization_id=eq.${org_id}&select=id`);
      if (existing.length >= 20) {
        return log('/webhook/org-add-workspace', `Workspace limit reached for org ${org_id}`);
      }
      const ws = await sbPost('workspaces', {
        organization_id: org_id,
        business_id: business_id || null,
        name,
        client_name: client_name || name,
        is_active: true,
      });
      if (business_id && ws?.id) {
        await sbPatch('businesses', `id=eq.${business_id}`, {
          organization_id: org_id,
          workspace_id: ws.id,
        });
      }
      log('/webhook/org-add-workspace', `Workspace "${name}" added to org ${org_id}`);
    } catch (err) {
      console.error('[org-add-workspace ERROR]', err.message);
      await logError(business_id, 'org-add-workspace', err.message, req.body);
    }
  });

  // POST /webhook/org-invite-member
  // Body: { business_id, org_id, email, role }
  app.post('/webhook/org-invite-member', planGate('multi_workspace'), async (req, res) => {
    const { org_id, email, role = 'member' } = req.body;
    if (!org_id || !email) return res.status(400).json({ error: 'org_id and email required' });
    res.json({ received: true, message: `Invite sent to ${email}` });

    try {
      const org = (await sbGet('organizations', `id=eq.${org_id}&select=name`))[0];
      await sbPost('organization_members', {
        organization_id: org_id,
        user_id: null,
        role,
      });
      const html = `<h2>You've been invited to ${org?.name || 'a maroa.ai workspace'}</h2>
<p>You've been added as a <strong>${role}</strong>. Click below to accept:</p>
<p><a href="https://maroa.ai/accept-invite?org=${org_id}&email=${encodeURIComponent(email)}"
   style="background:#667eea;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">
   Accept Invitation
</a></p>`;
      await sendEmail(email, `You've been invited to ${org?.name || 'maroa.ai'}`, html);
      log('/webhook/org-invite-member', `Invited ${email} as ${role} to org ${org_id}`);
    } catch (err) {
      console.error('[org-invite-member ERROR]', err.message);
    }
  });

  // POST /webhook/org-white-label-update
  // Body: { business_id, org_id, white_label_logo_url?, white_label_primary_color?, white_label_company_name?, white_label_domain? }
  app.post('/webhook/org-white-label-update', planGate('white_label'), async (req, res) => {
    const { org_id } = req.body;
    if (!org_id) return res.status(400).json({ error: 'org_id required' });

    const fields = [
      'white_label_logo_url',
      'white_label_primary_color',
      'white_label_company_name',
      'white_label_domain',
    ];
    const updates = {};
    fields.forEach((k) => {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    if (!Object.keys(updates).length)
      return res.status(400).json({ error: 'No white-label fields provided', accepted: fields });

    try {
      await sbPatch('organizations', `id=eq.${org_id}`, updates);
      log('/webhook/org-white-label-update', `White-label updated for org ${org_id}`);
      res.json({ received: true, updated: Object.keys(updates) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
