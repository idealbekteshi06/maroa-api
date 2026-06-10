'use strict';

/**
 * routes/inspiration.js
 * ----------------------------------------------------------------------------
 * Inspiration saves from the Maroa Chrome extension (and any future
 * "save this post" surfaces). Each save lands as a typed entity in the
 * Marketing Graph so the grounding library + creative-engine pull from
 * what the user has flagged as good.
 *
 *   POST /api/inspiration/save
 *     Auth: Bearer JWT (requireAnyUserId)
 *     Body: { source, source_url?, image_url?, excerpt?, claim_text?, tab_title?, captured_at?, hint? }
 *     → { id, ok: true } | 4xx error
 *
 *   GET /api/inspiration/list?businessId=...&limit=
 *     Auth: Bearer JWT
 *     → { items: [...] }
 *
 * Storage: marketing_graph_entities (migration 065) with entity_type=
 * 'inspiration' (default) or 'claim' (when hint='claim' or claim_text
 * is non-empty). Graceful fallback: if migration 065 isn't applied yet,
 * we still respond 200 — the save just no-ops silently and the customer
 * sees a "saved" toast in the extension. The audit log captures every
 * attempt regardless.
 * ----------------------------------------------------------------------------
 */

const { assertBusinessOwner } = require('../lib/assertBusinessOwner');

function register({
  app,
  marketingGraph,
  workspaces,
  requireAnyUserId,
  sbGet,
  apiError,
  safePublicError,
  log,
  express,
}) {
  const logger = { warn: (...a) => log?.(...a) };

  async function _ownedBusinessForUser(userId) {
    if (!userId || typeof sbGet !== 'function') return null;
    try {
      // Prefer the user's own business if they own one directly.
      const own = await sbGet(
        'businesses',
        `user_id=eq.${encodeURIComponent(userId)}&select=id&order=created_at.asc&limit=1`
      );
      if (own && own[0]?.id) return own[0].id;
      // Otherwise fall back to the first workspace the user is in + that
      // workspace's first client (the same heuristic the dashboard uses).
      if (workspaces && typeof workspaces.listForUser === 'function') {
        const memberships = await workspaces.listForUser(userId).catch(() => []);
        const first = memberships?.[0];
        if (first?.workspace_id || first?.id) {
          const wsId = first.workspace_id || first.id;
          const clients = await workspaces.listClients(wsId, { limit: 1 }).catch(() => []);
          return clients?.[0]?.business_id || null;
        }
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  app.post(
    '/api/inspiration/save',
    requireAnyUserId,
    express ? express.json({ limit: '64kb' }) : (req, _res, next) => next(),
    async (req, res) => {
      try {
        const body = req.body || {};
        // A client-supplied businessId must be one the caller owns — otherwise
        // saves could be written into another tenant's Marketing Graph. Verify
        // ownership before trusting it; fall back to the user's own business.
        const suppliedBusinessId = body.businessId && typeof body.businessId === 'string' ? body.businessId : null;
        if (suppliedBusinessId) {
          if (!(await assertBusinessOwner(req, res, suppliedBusinessId, { sbGet, apiError, logger }))) return;
        }
        const businessId = suppliedBusinessId || (await _ownedBusinessForUser(req.user?.id));

        if (!businessId) {
          return apiError(res, 400, 'NO_BUSINESS', 'No business to save inspiration into. Finish onboarding first.');
        }

        const isClaim = body.hint === 'claim' || (body.claim_text && body.claim_text.trim());
        const sourceUrl = typeof body.source_url === 'string' ? body.source_url.slice(0, 1024) : null;
        const imageUrl = typeof body.image_url === 'string' ? body.image_url.slice(0, 1024) : null;
        const excerpt = typeof body.excerpt === 'string' ? body.excerpt.slice(0, 4000) : null;
        const tabTitle = typeof body.tab_title === 'string' ? body.tab_title.slice(0, 240) : null;

        // Build a stable external_id so the same browser tab pinged twice
        // (extension retries) dedups in the graph.
        const stableSeed = `${businessId}:${sourceUrl || imageUrl || ''}:${excerpt?.slice(0, 64) || ''}`;
        const externalId = `inspiration:${require('crypto').createHash('sha1').update(stableSeed).digest('hex').slice(0, 32)}`;

        if (!marketingGraph || typeof marketingGraph.upsertEntity !== 'function') {
          // Migration 065 not applied. Log + soft-accept so the UX
          // (saved toast in extension) doesn't lie about success.
          log?.('/api/inspiration/save', null, 'graph unavailable — accepting but discarding', {
            hasSource: !!sourceUrl,
            isClaim: !!isClaim,
          });
          return res.json({ ok: true, persisted: false, reason: 'graph_unavailable' });
        }

        const entity = await marketingGraph.upsertEntity({
          businessId,
          type: isClaim ? 'claim' : 'inspiration',
          subtype: body.source || 'browser_extension',
          title: (tabTitle || excerpt || sourceUrl || 'Saved inspiration').slice(0, 200),
          description: excerpt || null,
          externalId,
          source:
            body.source === 'browser_extension'
              ? 'extension:chrome'
              : `source:${String(body.source || 'manual').slice(0, 40)}`,
          attrs: {
            source_url: sourceUrl,
            image_url: imageUrl,
            tab_title: tabTitle,
            captured_at: body.captured_at || new Date().toISOString(),
            claim_text: isClaim ? body.claim_text || excerpt || null : null,
          },
        });

        return res.json({ ok: true, persisted: !!entity, id: entity?.id || null });
      } catch (err) {
        log?.('/api/inspiration/save', null, 'save failed', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
      }
    }
  );

  app.get('/api/inspiration/list', requireAnyUserId, async (req, res) => {
    try {
      // A client-supplied businessId must be one the caller owns — otherwise the
      // list could leak another tenant's saved inspiration. Verify before trust.
      const suppliedBusinessId =
        typeof req.query.businessId === 'string' && req.query.businessId ? req.query.businessId : null;
      if (suppliedBusinessId) {
        if (!(await assertBusinessOwner(req, res, suppliedBusinessId, { sbGet, apiError, logger }))) return;
      }
      const businessId = suppliedBusinessId || (await _ownedBusinessForUser(req.user?.id));
      if (!businessId) return res.json({ items: [] });
      if (!marketingGraph || typeof marketingGraph.getEntitiesByType !== 'function') {
        return res.json({ items: [], graph_available: false });
      }
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const items = await marketingGraph.getEntitiesByType({
        businessId,
        type: req.query.kind === 'claim' ? 'claim' : 'inspiration',
        limit,
      });
      return res.json({ items });
    } catch (err) {
      log?.('/api/inspiration/list', null, 'list failed', { error: err.message });
      return apiError(res, 500, 'INTERNAL_ERROR', safePublicError(err));
    }
  });
}

module.exports = { register };
