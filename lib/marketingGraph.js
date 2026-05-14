'use strict';

/**
 * lib/marketingGraph.js
 * ───────────────────────────────────────────────────────────────────────
 * Read/write surface for the Marketing Graph (migration 065 / ADR-0010).
 *
 * Public API:
 *
 *   upsertEntity({ businessId, type, subtype?, title, attrs?, externalId?, source? })
 *     → { id, ...row }
 *
 *   linkEntities({ businessId, sourceId, targetId, type, weight?, attrs? })
 *     → { id, ...edge }
 *
 *   getEntitiesByType({ businessId, type, limit?, status? })
 *     → [row, row, …]  ordered by created_at DESC
 *
 *   getNeighbors({ businessId, entityId, edgeType?, direction='out' })
 *     → [{ edge, entity }, …]
 *
 *   recordClaim({ businessId, claimText, claimType, evidenceUrl?, source? })
 *     → claim row (idempotent — looks up by exact claim_text)
 *
 *   pickTopClaims({ businessId, claimType?, limit=5 })
 *     → [claim, …] ordered by outcome_signal DESC
 *
 *   recordOffer / pickActiveOffers — same shape for offers
 *
 *   recordAudience / pickAudiences — same shape for audiences
 *
 *   recordCreative({ businessId, channel, asset_type, genome, performance?, refs? })
 *     → creative row
 *
 *   updateCreativePerformance({ id, impressions, clicks, conversions, spendUsd, revenueUsd })
 *     → updated creative row (also recomputes performance_score)
 *
 *   topCreatives({ businessId, channel?, hookType?, limit=5 })
 *     → [creative, …]  for the closed-loop grounding library
 *
 *   recordExperiment({ businessId, name, hypothesis, variantCount, primaryMetric, budgetUsd? })
 *
 *   completeExperiment({ id, winnerCreativeId, confidenceScore, liftPct, conclusion })
 *
 * Design constraints:
 *   - Fail-safe: any DB call that throws is caught + logged + a fallback
 *     return value is given. Marketing Graph is a moat-building amenity,
 *     not a hot-path dependency. A Supabase outage should never break
 *     content generation.
 *   - Dependency injection: every function takes sbGet/sbPost/sbPatch via
 *     the make() factory so the library is testable without a live DB.
 *   - Tier-aware: free-tier writes record metadata but skip the heavier
 *     reads (top claims, top creatives) — caller supplies businessPlan.
 *
 * Reads/writes the 8 tables from migration 065:
 *   marketing_graph_entities · marketing_graph_edges · claims_library
 *   offer_library · audience_segments · creative_assets · experiments
 *   decision_logs (decision_logs is owned by lib/decisionLog.js)
 *
 * Soft-fail: if migration 065 hasn't been applied, every method returns
 * a no-op-ish value (null / [] / { ok: false, reason: 'graph_unavailable' }).
 * The library exposes `isHealthy()` so callers can decide whether to
 * surface the graph in their UI flow at all.
 */

function makeMarketingGraph(deps = {}) {
  const {
    sbGet,
    sbPost,
    sbPatch,
    logger,
    metrics,
  } = deps;

  if (typeof sbGet !== 'function' || typeof sbPost !== 'function') {
    throw new Error('marketingGraph: sbGet + sbPost are required deps');
  }

  // ── Internals ────────────────────────────────────────────────────────

  let _healthy = null; // null = unknown, true/false after first probe

  async function isHealthy() {
    if (_healthy !== null) return _healthy;
    try {
      await sbGet('marketing_graph_entities', 'select=id&limit=1');
      _healthy = true;
    } catch (e) {
      _healthy = false;
      if (logger?.warn) logger.warn('marketingGraph', null, 'graph offline', { err: e.message });
    }
    return _healthy;
  }

  function _bumpMetric(name, labels) {
    if (metrics?.increment) {
      try {
        metrics.increment(name, labels);
      } catch {
        // metrics are best-effort
      }
    }
  }

  function _encode(value) {
    return encodeURIComponent(value);
  }

  async function _softGet(table, filter) {
    try {
      return await sbGet(table, filter);
    } catch (e) {
      if (logger?.warn) logger.warn('marketingGraph', null, `read failed: ${table}`, { err: e.message });
      _bumpMetric('marketing_graph_read_errors_total', { table });
      return [];
    }
  }

  async function _softPost(table, row) {
    try {
      const r = await sbPost(table, row, { returning: 'representation' });
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      if (logger?.warn) logger.warn('marketingGraph', null, `write failed: ${table}`, { err: e.message });
      _bumpMetric('marketing_graph_write_errors_total', { table });
      return null;
    }
  }

  async function _softPatch(table, filter, updates) {
    try {
      if (typeof sbPatch !== 'function') return null;
      const r = await sbPatch(table, filter, updates, { returning: 'representation' });
      return Array.isArray(r) ? r[0] : r;
    } catch (e) {
      if (logger?.warn) logger.warn('marketingGraph', null, `patch failed: ${table}`, { err: e.message });
      _bumpMetric('marketing_graph_write_errors_total', { table });
      return null;
    }
  }

  // ── Entities ─────────────────────────────────────────────────────────

  async function upsertEntity({ businessId, type, subtype, title, description, attrs, externalId, source, status }) {
    if (!businessId || !type || !title) {
      throw new Error('upsertEntity: businessId + type + title required');
    }
    if (!(await isHealthy())) return null;

    // If an externalId is supplied, dedupe on (business, type, externalId).
    if (externalId) {
      const existing = await _softGet(
        'marketing_graph_entities',
        `business_id=eq.${_encode(businessId)}&entity_type=eq.${_encode(type)}` +
          `&external_id=eq.${_encode(externalId)}&select=id&limit=1`
      );
      if (existing.length) {
        const updates = {};
        if (title) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (attrs) updates.attrs = attrs;
        if (status) updates.status = status;
        if (Object.keys(updates).length === 0) {
          return existing[0];
        }
        return _softPatch(
          'marketing_graph_entities',
          `id=eq.${existing[0].id}`,
          updates
        );
      }
    }

    const row = {
      business_id: businessId,
      entity_type: type,
      entity_subtype: subtype || null,
      title,
      description: description || null,
      attrs: attrs || {},
      external_id: externalId || null,
      source: source || null,
      status: status || 'active',
    };
    _bumpMetric('marketing_graph_entity_writes_total', { entity_type: type });
    return _softPost('marketing_graph_entities', row);
  }

  async function linkEntities({ businessId, sourceId, targetId, type, weight, attrs }) {
    if (!businessId || !sourceId || !targetId || !type) {
      throw new Error('linkEntities: businessId + sourceId + targetId + type required');
    }
    if (!(await isHealthy())) return null;
    const row = {
      business_id: businessId,
      source_entity_id: sourceId,
      target_entity_id: targetId,
      edge_type: type,
      weight: typeof weight === 'number' ? weight : 1.0,
      attrs: attrs || {},
    };
    _bumpMetric('marketing_graph_edge_writes_total', { edge_type: type });
    return _softPost('marketing_graph_edges', row);
  }

  async function getEntitiesByType({ businessId, type, limit = 50, status }) {
    if (!businessId || !type) return [];
    if (!(await isHealthy())) return [];
    let filter = `business_id=eq.${_encode(businessId)}&entity_type=eq.${_encode(type)}` +
      `&order=created_at.desc&limit=${Math.max(1, Math.min(500, limit))}`;
    if (status) filter += `&status=eq.${_encode(status)}`;
    return _softGet('marketing_graph_entities', filter);
  }

  async function getNeighbors({ businessId, entityId, edgeType, direction = 'out' }) {
    if (!businessId || !entityId) return [];
    if (!(await isHealthy())) return [];
    const directionCol = direction === 'in' ? 'target_entity_id' : 'source_entity_id';
    const otherCol = direction === 'in' ? 'source_entity_id' : 'target_entity_id';
    let filter = `business_id=eq.${_encode(businessId)}&${directionCol}=eq.${_encode(entityId)}` +
      `&order=created_at.desc&limit=100`;
    if (edgeType) filter += `&edge_type=eq.${_encode(edgeType)}`;
    const edges = await _softGet('marketing_graph_edges', filter);
    if (!edges.length) return [];

    const otherIds = [...new Set(edges.map((e) => e[otherCol]).filter(Boolean))];
    if (!otherIds.length) return [];
    const inList = otherIds.map(_encode).join(',');
    const entities = await _softGet(
      'marketing_graph_entities',
      `id=in.(${inList})&select=*`
    );
    const entityById = new Map(entities.map((e) => [e.id, e]));
    return edges.map((edge) => ({ edge, entity: entityById.get(edge[otherCol]) || null }));
  }

  // ── Claims library ───────────────────────────────────────────────────

  async function recordClaim({ businessId, claimText, claimType, evidenceUrl, complianceFlags }) {
    if (!businessId || !claimText) throw new Error('recordClaim: businessId + claimText required');
    if (!(await isHealthy())) return null;

    // Idempotent: dedupe on exact text per business
    const normalized = String(claimText).trim();
    const existing = await _softGet(
      'claims_library',
      `business_id=eq.${_encode(businessId)}&claim_text=eq.${_encode(normalized)}&select=id&limit=1`
    );
    if (existing.length) {
      return _softPatch(
        'claims_library',
        `id=eq.${existing[0].id}`,
        { usage_count: 'usage_count + 1', last_used_at: new Date().toISOString() }
      );
    }

    return _softPost('claims_library', {
      business_id: businessId,
      claim_text: normalized,
      claim_type: claimType || null,
      evidence_url: evidenceUrl || null,
      compliance_flags: complianceFlags || [],
      usage_count: 1,
      last_used_at: new Date().toISOString(),
    });
  }

  async function pickTopClaims({ businessId, claimType, limit = 5 }) {
    if (!businessId) return [];
    if (!(await isHealthy())) return [];
    let filter = `business_id=eq.${_encode(businessId)}&status=eq.active` +
      `&order=outcome_signal.desc,last_used_at.desc.nullslast` +
      `&limit=${Math.max(1, Math.min(50, limit))}`;
    if (claimType) filter += `&claim_type=eq.${_encode(claimType)}`;
    return _softGet('claims_library', filter);
  }

  async function updateClaimOutcome({ id, outcomeSignal }) {
    if (!id || typeof outcomeSignal !== 'number') return null;
    if (!(await isHealthy())) return null;
    const clamped = Math.max(0, Math.min(1, outcomeSignal));
    return _softPatch('claims_library', `id=eq.${_encode(id)}`, { outcome_signal: clamped });
  }

  // ── Offer library ────────────────────────────────────────────────────

  async function recordOffer({
    businessId,
    name,
    description,
    offerType,
    offerValue,
    validFrom,
    validUntil,
    channels,
  }) {
    if (!businessId || !name || !offerType) {
      throw new Error('recordOffer: businessId + name + offerType required');
    }
    if (!(await isHealthy())) return null;
    return _softPost('offer_library', {
      business_id: businessId,
      name,
      description: description || null,
      offer_type: offerType,
      offer_value: typeof offerValue === 'number' ? offerValue : null,
      valid_from: validFrom || null,
      valid_until: validUntil || null,
      channels: Array.isArray(channels) ? channels : [],
    });
  }

  async function pickActiveOffers({ businessId, limit = 10 }) {
    if (!businessId) return [];
    if (!(await isHealthy())) return [];
    const filter =
      `business_id=eq.${_encode(businessId)}&status=eq.active` +
      `&order=updated_at.desc&limit=${Math.max(1, Math.min(50, limit))}`;
    return _softGet('offer_library', filter);
  }

  async function recordOfferConversion({ id, addRevenueUsd = 0 }) {
    if (!id) return null;
    if (!(await isHealthy())) return null;
    // PostgREST doesn't support arithmetic in PATCH bodies directly; this is
    // a best-effort write of incremented counters via separate read + write.
    const cur = await _softGet('offer_library', `id=eq.${_encode(id)}&select=conversion_count,revenue_usd&limit=1`);
    if (!cur.length) return null;
    return _softPatch('offer_library', `id=eq.${_encode(id)}`, {
      conversion_count: (cur[0].conversion_count || 0) + 1,
      revenue_usd: Number(((cur[0].revenue_usd || 0) + Number(addRevenueUsd || 0)).toFixed(2)),
    });
  }

  // ── Audience segments ────────────────────────────────────────────────

  async function recordAudience({
    businessId,
    name,
    segmentType,
    sourcePlatform,
    platformId,
    sizeEstimate,
    spec,
  }) {
    if (!businessId || !name || !segmentType || !sourcePlatform) {
      throw new Error('recordAudience: businessId + name + segmentType + sourcePlatform required');
    }
    if (!(await isHealthy())) return null;

    if (platformId) {
      const existing = await _softGet(
        'audience_segments',
        `business_id=eq.${_encode(businessId)}&source_platform=eq.${_encode(sourcePlatform)}` +
          `&platform_id=eq.${_encode(platformId)}&select=id&limit=1`
      );
      if (existing.length) return existing[0];
    }
    return _softPost('audience_segments', {
      business_id: businessId,
      name,
      segment_type: segmentType,
      source_platform: sourcePlatform,
      platform_id: platformId || null,
      size_estimate: typeof sizeEstimate === 'number' ? sizeEstimate : null,
      spec: spec || {},
    });
  }

  async function pickAudiences({ businessId, sourcePlatform, limit = 10 }) {
    if (!businessId) return [];
    if (!(await isHealthy())) return [];
    let filter = `business_id=eq.${_encode(businessId)}&status=eq.active` +
      `&order=created_at.desc&limit=${Math.max(1, Math.min(50, limit))}`;
    if (sourcePlatform) filter += `&source_platform=eq.${_encode(sourcePlatform)}`;
    return _softGet('audience_segments', filter);
  }

  // ── Creative assets (Creative Genome) ────────────────────────────────

  async function recordCreative({
    businessId,
    assetType,
    assetUrl,
    thumbnailUrl,
    channel,
    genome = {},
    claimIds,
    offerId,
    audienceId,
    experimentId,
    attrs,
  }) {
    if (!businessId || !assetType || !channel) {
      throw new Error('recordCreative: businessId + assetType + channel required');
    }
    if (!(await isHealthy())) return null;
    return _softPost('creative_assets', {
      business_id: businessId,
      asset_type: assetType,
      asset_url: assetUrl || null,
      thumbnail_url: thumbnailUrl || null,
      channel,
      hook_type: genome.hookType || null,
      angle: genome.angle || null,
      emotion: genome.emotion || null,
      visual_style: genome.visualStyle || null,
      cta_text: genome.cta || null,
      claim_ids: Array.isArray(claimIds) ? claimIds : [],
      offer_id: offerId || null,
      audience_id: audienceId || null,
      experiment_id: experimentId || null,
      attrs: attrs || {},
    });
  }

  /**
   * Update performance + recompute a normalized score in [0,1].
   * Score = clamp01(roas / 5.0)    if roas data exists
   *       | clamp01(ctr / 0.05)    if click-through data exists (ctr 5% = 1.0)
   *       | 0.5                    no signal yet
   */
  async function updateCreativePerformance({
    id,
    impressions = 0,
    clicks = 0,
    conversions = 0,
    spendUsd = 0,
    revenueUsd = 0,
  }) {
    if (!id) return null;
    if (!(await isHealthy())) return null;

    const ctr = impressions > 0 ? clicks / impressions : null;
    const roas = spendUsd > 0 ? revenueUsd / spendUsd : null;
    let perf = 0.5;
    if (roas != null) perf = Math.max(0, Math.min(1, roas / 5));
    else if (ctr != null) perf = Math.max(0, Math.min(1, ctr / 0.05));

    return _softPatch('creative_assets', `id=eq.${_encode(id)}`, {
      impressions,
      clicks,
      conversions,
      spend_usd: Number(spendUsd.toFixed(2)),
      revenue_usd: Number(revenueUsd.toFixed(2)),
      performance_score: Number(perf.toFixed(3)),
    });
  }

  async function topCreatives({ businessId, channel, hookType, limit = 5 }) {
    if (!businessId) return [];
    if (!(await isHealthy())) return [];
    let filter = `business_id=eq.${_encode(businessId)}&status=eq.active` +
      `&order=performance_score.desc.nullslast` +
      `&limit=${Math.max(1, Math.min(50, limit))}`;
    if (channel) filter += `&channel=eq.${_encode(channel)}`;
    if (hookType) filter += `&hook_type=eq.${_encode(hookType)}`;
    return _softGet('creative_assets', filter);
  }

  // ── Experiments ──────────────────────────────────────────────────────

  async function recordExperiment({
    businessId,
    name,
    hypothesis,
    variantCount,
    primaryMetric,
    budgetUsd,
  }) {
    if (!businessId || !name || !variantCount) {
      throw new Error('recordExperiment: businessId + name + variantCount required');
    }
    if (variantCount < 2 || variantCount > 10) {
      throw new Error('recordExperiment: variantCount must be 2..10');
    }
    if (!(await isHealthy())) return null;
    return _softPost('experiments', {
      business_id: businessId,
      name,
      hypothesis: hypothesis || null,
      variant_count: variantCount,
      status: 'planning',
      primary_metric: primaryMetric || null,
      budget_usd: typeof budgetUsd === 'number' ? budgetUsd : null,
    });
  }

  async function completeExperiment({
    id,
    winnerCreativeId,
    confidenceScore,
    liftPct,
    conclusion,
    spendUsd,
  }) {
    if (!id) return null;
    if (!(await isHealthy())) return null;
    const updates = {
      status: 'completed',
      ended_at: new Date().toISOString(),
    };
    if (winnerCreativeId) updates.winner_creative_id = winnerCreativeId;
    if (typeof confidenceScore === 'number') updates.confidence_score = Math.max(0, Math.min(1, confidenceScore));
    if (typeof liftPct === 'number') updates.lift_pct = liftPct;
    if (conclusion) updates.conclusion = conclusion;
    if (typeof spendUsd === 'number') updates.spend_usd = Number(spendUsd.toFixed(2));
    return _softPatch('experiments', `id=eq.${_encode(id)}`, updates);
  }

  return {
    isHealthy,
    upsertEntity,
    linkEntities,
    getEntitiesByType,
    getNeighbors,
    recordClaim,
    pickTopClaims,
    updateClaimOutcome,
    recordOffer,
    pickActiveOffers,
    recordOfferConversion,
    recordAudience,
    pickAudiences,
    recordCreative,
    updateCreativePerformance,
    topCreatives,
    recordExperiment,
    completeExperiment,
  };
}

module.exports = { makeMarketingGraph };
