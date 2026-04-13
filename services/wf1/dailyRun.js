/*
 * services/wf1/dailyRun.js
 * ----------------------------------------------------------------------------
 * The daily 06:00 local-time run. Walks all active businesses whose current
 * local hour is 6, and for each:
 *
 *   1. Idempotency check (skip if already ran today)
 *   2. Strategic decision phase
 *   3. For each concept: generate asset (Phase 3 + 4)
 *   4. Enforce autonomy mode:
 *        - full_autopilot:       publish immediately if quality ≥ 95
 *        - hybrid:               publish if ≥ 95, else queue for approval w/ fallback
 *        - approve_everything:   always queue
 *   5. Write approval rows for anything that needs human review
 *
 * This file is the single "daily brain" of WF1, callable from cron and from
 * the /webhook/wf1-run-daily endpoint.
 * ----------------------------------------------------------------------------
 */

'use strict';

function createDailyRun({ sbGet, sbPost, sbPatch, logger, engine, publisher, checkOrchestrationIdempotency, recordOrchestrationTaskRun }) {
  async function shouldRunForBusiness(businessId) {
    // Check local time == 06 in business timezone
    const profileRows = await sbGet(
      'business_profiles',
      `user_id=eq.${businessId}&select=timezone`
    ).catch(() => []);
    const tz = profileRows[0]?.timezone || 'Europe/Belgrade';
    let localHour;
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      });
      localHour = parseInt(fmt.format(new Date()), 10);
    } catch {
      localHour = new Date().getHours();
    }
    return localHour === 6;
  }

  async function runForBusiness({ businessId, force = false }) {
    // Idempotency: one run per business per local day
    const taskName = `wf1_daily:${businessId}`;
    if (!force) {
      const already = await checkOrchestrationIdempotency(businessId, taskName, 22 * 3600000);
      if (already) {
        logger?.info('/wf1/dailyRun', businessId, 'skip: already ran in last 22h');
        return { ok: true, skipped: true, reason: 'already_ran' };
      }
    }

    await recordOrchestrationTaskRun(businessId, taskName, 'WF1 daily run start');

    // Phase 2: strategic decision
    const plan = await engine.runStrategicDecision({ businessId, forceReplan: force });
    if (!plan.concepts.length) {
      logger?.info('/wf1/dailyRun', businessId, 'strategic decision returned 0 concepts — skipping day');
      return { ok: true, skipped: true, reason: 'no_concepts' };
    }

    const { mode, windowHours, config } = await engine.getAutonomyMode(businessId);

    const results = [];
    for (const concept of plan.concepts) {
      try {
        // Phase 3 + 4
        const asset = await engine.generateAssetForConcept({ businessId, conceptId: concept.id });
        if (asset.blocked) {
          results.push({ conceptId: concept.id, action: 'blocked', reasons: asset.reasons });
          continue;
        }

        // Phase 5: autonomy mode routing
        const qs = asset.qualityScore || 0;
        let action = 'queue';
        let publishResult = null;

        if (mode === 'full_autopilot') {
          if (qs >= (config.autoPublishThreshold || 95)) {
            publishResult = await publisher.publishAsset({ assetId: asset.assetId });
            action = publishResult.ok ? 'auto_published' : 'publish_failed';
          } else {
            action = 'queue';
          }
        } else if (mode === 'hybrid') {
          if (qs >= (config.autoPublishThreshold || 95)) {
            publishResult = await publisher.publishAsset({ assetId: asset.assetId });
            action = publishResult.ok ? 'auto_published' : 'publish_failed';
          } else {
            action = 'queue';
          }
        } else {
          action = 'queue';
        }

        if (action === 'queue') {
          // Write approval row with SLA
          const slaAt =
            mode === 'hybrid'
              ? new Date(Date.now() + (windowHours || 4) * 3600000).toISOString()
              : null;
          await sbPost('approvals', {
            business_id: businessId,
            workflow: '1_daily_content',
            entity_type: 'asset',
            entity_id: asset.assetId,
            preview: {
              title: concept.core_idea,
              body: asset.asset?.caption,
              media_url: asset.asset?.media_url || null,
              rationale: concept.why_this_why_now,
              platform: concept.platform,
              quality_score: qs,
            },
            status: 'pending',
            priority: Math.round(qs),
            sla_at: slaAt,
          }).catch(() => {});
        }

        results.push({
          conceptId: concept.id,
          assetId: asset.assetId,
          quality: qs,
          action,
          publish: publishResult,
        });
      } catch (e) {
        logger?.error('/wf1/dailyRun', businessId, 'concept processing failed', e, { concept_id: concept.id });
        results.push({ conceptId: concept.id, action: 'error', error: e.message });
      }
    }

    await sbPost('events', {
      business_id: businessId,
      kind: 'wf1.daily_run.completed',
      workflow: '1_daily_content',
      payload: {
        plan_id: plan.planId,
        plan_date: plan.planDate,
        autonomy_mode: mode,
        concepts_count: plan.concepts.length,
        results,
      },
      severity: 'info',
    }).catch(() => {});

    return { ok: true, planId: plan.planId, results, autonomyMode: mode };
  }

  async function runForAllBusinesses({ force = false } = {}) {
    // Fetch all active businesses
    const bizList = await sbGet(
      'businesses',
      `is_active=eq.true&select=id,business_name&limit=500`
    ).catch(() => []);

    const results = [];
    for (const biz of bizList) {
      if (!force) {
        const should = await shouldRunForBusiness(biz.id);
        if (!should) continue;
      }
      try {
        const r = await runForBusiness({ businessId: biz.id, force });
        results.push({ businessId: biz.id, ...r });
      } catch (e) {
        logger?.error('/wf1/dailyRun', biz.id, 'business run failed', e);
        results.push({ businessId: biz.id, ok: false, error: e.message });
      }
    }
    return { processed: results.length, results };
  }

  // Hybrid fallback: check for expired SLA approvals in hybrid mode, auto-publish
  // if quality ≥ 90 (WF1 AUTONOMY_MODES.hybrid.fallbackThreshold)
  async function processHybridFallbacks() {
    const now = new Date().toISOString();
    const rows = await sbGet(
      'approvals',
      `workflow=eq.1_daily_content&status=eq.pending&sla_at=lte.${encodeURIComponent(now)}&select=id,business_id,entity_id,preview&limit=100`
    ).catch(() => []);

    const results = [];
    for (const approval of rows) {
      const qs = Number(approval.preview?.quality_score || 0);
      if (qs >= 90) {
        try {
          const pub = await publisher.publishAsset({ assetId: approval.entity_id });
          await sbPatch('approvals', `id=eq.${approval.id}`, {
            status: pub.ok ? 'approved' : 'rejected',
            decided_at: new Date().toISOString(),
            decision_reason: pub.ok ? 'SLA fallback auto-approved (quality ≥ 90)' : `Publish failed: ${pub.error}`,
          }).catch(() => {});
          results.push({ approvalId: approval.id, action: 'auto_published', ok: pub.ok });
        } catch (e) {
          results.push({ approvalId: approval.id, action: 'error', error: e.message });
        }
      } else {
        // Expire it (skip) — quality too low for fallback
        await sbPatch('approvals', `id=eq.${approval.id}`, {
          status: 'expired',
          decided_at: new Date().toISOString(),
          decision_reason: `SLA expired, quality ${qs} below fallback threshold 90`,
        }).catch(() => {});
        results.push({ approvalId: approval.id, action: 'expired' });
      }
    }
    return { processed: results.length, results };
  }

  return { runForBusiness, runForAllBusinesses, shouldRunForBusiness, processHybridFallbacks };
}

module.exports = createDailyRun;
