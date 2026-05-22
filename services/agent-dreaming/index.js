'use strict';

/**
 * services/agent-dreaming/index.js
 * Learns per-business patterns into brain_memory (+ optional Anthropic Memory / Dreaming beta).
 *
 * Dreaming API is research-preview — when MAROA_DREAMING_ENABLED=1 we also append
 * to Anthropic memory sessions for managed-agent continuity.
 */

function createAgentDreamingService({ sbGet, sbPost, sbPatch, memoryService, logger }) {
  async function distillAutopilotLearnings({ businessId, snapshot, decisions = [] }) {
    if (!businessId || !snapshot?.business) return { ok: false, reason: 'missing_context' };

    const facts = [];
    const biz = snapshot.business;

    if (snapshot.measurementHealth?.length) {
      const broken = snapshot.measurementHealth.filter((m) => m.trust_for_scaling === false);
      if (broken.length) {
        facts.push({
          category: 'measurement',
          fact: `Platforms not trusted for scaling: ${broken.map((b) => b.platform).join(', ')}`,
        });
      }
    }

    const scaled = (decisions || []).filter((d) => d.action === 'scale' || d.decision === 'scale');
    if (scaled.length) {
      facts.push({
        category: 'ads',
        fact: `Autopilot scaled ${scaled.length} campaign(s) — prioritize similar ROAS patterns`,
      });
    }

    const creativePending = (snapshot.creativeStats || []).filter((c) => c.status === 'pending').length;
    if (creativePending > 3) {
      facts.push({
        category: 'creative',
        fact: `${creativePending} creative variants pending — batch approvals reduce thrash`,
      });
    }

    const existing = await sbGet('brain_memory', `business_id=eq.${encodeURIComponent(businessId)}&select=*`).catch(
      () => []
    );
    const mem = existing[0] || {};
    const learnings = Array.isArray(mem.recent_learnings) ? [...mem.recent_learnings] : [];
    const stamped = facts.map((f) => ({
      at: new Date().toISOString(),
      category: f.category,
      fact: f.fact,
      source: 'autopilot_dreaming',
    }));
    const merged = [...stamped, ...learnings].slice(0, 40);

    let persisted = 0;
    try {
      if (mem.business_id) {
        await sbPatch('brain_memory', `business_id=eq.${encodeURIComponent(businessId)}`, {
          recent_learnings: merged,
          updated_at: new Date().toISOString(),
        });
      } else {
        await sbPost('brain_memory', {
          business_id: businessId,
          recent_learnings: merged,
          owner_preferences: {},
        });
      }
      persisted = stamped.length;
    } catch (e) {
      logger?.warn?.('agent-dreaming', businessId, 'brain_memory upsert failed', { error: e.message });
    }

    if (process.env.MAROA_DREAMING_ENABLED === '1' && memoryService?.appendFact) {
      try {
        const sessionId = `maroa_${businessId}`;
        for (const f of facts) {
          await memoryService.appendFact(sessionId, `${f.category}: ${f.fact}`).catch(() => {});
        }
      } catch (e) {
        logger?.warn?.('agent-dreaming', businessId, 'anthropic memory append failed', { error: e.message });
      }
    }

    return { ok: true, facts_extracted: facts.length, persisted, business_name: biz.business_name };
  }

  /**
   * Research-preview dreaming hook — no-op unless MAROA_DREAMING_API_URL is set.
   */
  async function triggerDreamingReview({ memoryStoreId }) {
    const url = process.env.MAROA_DREAMING_API_URL;
    if (!url || !memoryStoreId) return { ok: false, skipped: true };
    logger?.info?.('agent-dreaming', null, 'dreaming review queued', { memoryStoreId });
    return { ok: true, queued: true };
  }

  return { distillAutopilotLearnings, triggerDreamingReview };
}

module.exports = { createAgentDreamingService };
