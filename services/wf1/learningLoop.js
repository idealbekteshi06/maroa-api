/*
 * services/wf1/learningLoop.js
 * ----------------------------------------------------------------------------
 * Runs 48h after each published asset:
 *   1. Fetch engagement data from the platform via existing Meta/LinkedIn/TikTok/Twitter APIs
 *   2. Write content_performance row
 *   3. Classify as winner / on_target / under / failed
 *   4. Update learning_patterns:
 *        - winners (lift ≥ 1.5x baseline): reinforce hook_pattern, format, emotion, posting time
 *        - anti-patterns (≤ 0.5x baseline): mark as drag
 *        - hashtag bank: roll up per-platform reach per tag
 *        - prediction_accuracy: mean absolute error between predicted_quality_score and actual engagement_rate
 *
 * This closes the learning loop the spec mandates — "gets smarter every week".
 * ----------------------------------------------------------------------------
 */

'use strict';

function createLearningLoop({ sbGet, sbPost, sbPatch, apiRequest, logger }) {
  // ── Fetch engagement from platform ────────────────────────────────────
  async function fetchMetaInsights({ business, post }) {
    const token = business.meta_access_token;
    if (!token || !post.platform_post_id) return null;
    // Instagram media insights
    if (/instagram/.test(post.platform)) {
      const url = `https://graph.facebook.com/v19.0/${post.platform_post_id}?fields=id,like_count,comments_count,insights.metric(reach,impressions,saved,shares)&access_token=${token}`;
      const r = await apiRequest('GET', url, {});
      if (r.status !== 200) return null;
      const insights = (r.body.insights?.data || []).reduce((acc, i) => {
        acc[i.name] = i.values?.[0]?.value || 0;
        return acc;
      }, {});
      const likes = r.body.like_count || 0;
      const comments = r.body.comments_count || 0;
      const reach = insights.reach || 0;
      const impressions = insights.impressions || 0;
      const saved = insights.saved || 0;
      const shares = insights.shares || 0;
      const engagement = likes + comments + saved + shares;
      return {
        impressions,
        reach,
        engagement_count: engagement,
        engagement_rate: reach ? engagement / reach : 0,
        raw: r.body,
      };
    }
    // Facebook page post insights
    if (post.platform === 'facebook') {
      const url = `https://graph.facebook.com/v19.0/${post.platform_post_id}?fields=id,reactions.summary(true),comments.summary(true),shares,insights.metric(post_impressions_unique,post_impressions)&access_token=${token}`;
      const r = await apiRequest('GET', url, {});
      if (r.status !== 200) return null;
      const reach = r.body.insights?.data?.find(i => i.name === 'post_impressions_unique')?.values?.[0]?.value || 0;
      const impressions = r.body.insights?.data?.find(i => i.name === 'post_impressions')?.values?.[0]?.value || 0;
      const reactions = r.body.reactions?.summary?.total_count || 0;
      const comments = r.body.comments?.summary?.total_count || 0;
      const shares = r.body.shares?.count || 0;
      const engagement = reactions + comments + shares;
      return {
        impressions,
        reach,
        engagement_count: engagement,
        engagement_rate: reach ? engagement / reach : 0,
        raw: r.body,
      };
    }
    return null;
  }

  async function fetchLinkedInInsights({ business, post }) {
    const token = business.linkedin_access_token;
    if (!token || !post.platform_post_id) return null;
    // LinkedIn insights API requires company pages; personal UGC doesn't
    // expose all metrics. For now return null — will add when org pages wired.
    return null;
  }

  async function fetchTwitterInsights({ business, post }) {
    const token = business.twitter_access_token;
    if (!token || !post.platform_post_id) return null;
    const url = `https://api.twitter.com/2/tweets/${post.platform_post_id}?tweet.fields=public_metrics`;
    const r = await apiRequest('GET', url, { Authorization: `Bearer ${token}` });
    if (r.status !== 200) return null;
    const m = r.body.data?.public_metrics || {};
    const engagement = (m.like_count || 0) + (m.reply_count || 0) + (m.retweet_count || 0) + (m.quote_count || 0);
    return {
      impressions: m.impression_count || 0,
      reach: m.impression_count || 0,
      engagement_count: engagement,
      engagement_rate: m.impression_count ? engagement / m.impression_count : 0,
      raw: r.body,
    };
  }

  async function fetchTikTokInsights({ business, post }) {
    // TikTok API returns insights via /v2/research/user/info/ — requires research scope
    return null;
  }

  async function fetchByPlatform({ business, post }) {
    switch (post.platform) {
      case 'facebook':
      case 'instagram_feed':
      case 'instagram_reel':
      case 'instagram_story':
        return fetchMetaInsights({ business, post });
      case 'linkedin':
        return fetchLinkedInInsights({ business, post });
      case 'twitter':
        return fetchTwitterInsights({ business, post });
      case 'tiktok':
        return fetchTikTokInsights({ business, post });
      default:
        return null;
    }
  }

  // ── Compute baseline for vs-baseline multiplier ───────────────────────
  async function getAccountBaseline({ businessId, platform }) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const rows = await sbGet(
      'content_performance',
      `business_id=eq.${businessId}&platform=eq.${encodeURIComponent(platform)}&measured_at=gte.${encodeURIComponent(since)}&select=engagement_rate`
    ).catch(() => []);
    if (!rows.length) return 0.02; // 2% default baseline (industry avg)
    const avg = rows.reduce((s, r) => s + Number(r.engagement_rate || 0), 0) / rows.length;
    return avg || 0.02;
  }

  // ── Write learning_patterns upsert ────────────────────────────────────
  async function upsertLearningPattern({ businessId, patternType, platform, trait, lift, drag, metadata = {} }) {
    // Upsert by composite unique key: (business_id, pattern_type, platform, trait)
    const encTrait = encodeURIComponent(trait);
    const encPatternType = encodeURIComponent(patternType);
    const encPlatform = platform ? encodeURIComponent(platform) : null;
    const filter = encPlatform
      ? `business_id=eq.${businessId}&pattern_type=eq.${encPatternType}&platform=eq.${encPlatform}&trait=eq.${encTrait}`
      : `business_id=eq.${businessId}&pattern_type=eq.${encPatternType}&platform=is.null&trait=eq.${encTrait}`;

    const existing = await sbGet('learning_patterns', `${filter}&select=id,sample_size,lift,drag,metadata`).catch(() => []);

    if (existing[0]) {
      const row = existing[0];
      const newSample = (row.sample_size || 0) + 1;
      const newLift = lift != null
        ? ((Number(row.lift || 0) * (row.sample_size || 1)) + lift) / newSample
        : row.lift;
      const newDrag = drag != null
        ? ((Number(row.drag || 0) * (row.sample_size || 1)) + drag) / newSample
        : row.drag;
      await sbPatch('learning_patterns', `id=eq.${row.id}`, {
        lift: newLift,
        drag: newDrag,
        sample_size: newSample,
        last_seen_at: new Date().toISOString(),
        metadata: { ...(row.metadata || {}), ...metadata },
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    } else {
      await sbPost('learning_patterns', {
        business_id: businessId,
        pattern_type: patternType,
        platform,
        trait,
        lift: lift || null,
        drag: drag || null,
        sample_size: 1,
        metadata,
      }).catch(() => {});
    }
  }

  // ── Measure a single post ────────────────────────────────────────────
  async function measurePost({ postId }) {
    const [postRows] = await Promise.all([
      sbGet('content_posts', `id=eq.${postId}&select=*`),
    ]);
    const post = postRows[0];
    if (!post) throw new Error(`Post not found: ${postId}`);
    if (post.performance_measured_at) {
      return { alreadyMeasured: true };
    }

    const [assetRows, bizRows] = await Promise.all([
      sbGet('content_assets', `id=eq.${post.asset_id}&select=*`),
      sbGet('businesses', `id=eq.${post.business_id}&select=*`),
    ]);
    const asset = assetRows[0];
    const business = bizRows[0];
    if (!asset || !business) throw new Error('Missing asset or business');

    const conceptRows = await sbGet('content_concepts', `id=eq.${asset.concept_id}&select=*`);
    const concept = conceptRows[0];

    const metrics = await fetchByPlatform({ business, post });
    if (!metrics) {
      // Mark as measured but empty — don't retry forever
      await sbPatch('content_posts', `id=eq.${postId}`, {
        performance_measured_at: new Date().toISOString(),
      }).catch(() => {});
      return { ok: false, reason: 'no_metrics_available' };
    }

    const baseline = await getAccountBaseline({ businessId: post.business_id, platform: post.platform });
    const vsBaseline = baseline > 0 ? metrics.engagement_rate / baseline : 1;
    const hoursSincePost = (Date.now() - new Date(post.posted_at).getTime()) / 3600000;

    let classification = 'on_target';
    if (vsBaseline >= 1.5) classification = 'winner';
    else if (vsBaseline <= 0.5) classification = 'under';
    if (metrics.engagement_count === 0) classification = 'failed';

    // Write perf row
    await sbPost('content_performance', {
      business_id: post.business_id,
      post_id: postId,
      asset_id: post.asset_id,
      platform: post.platform,
      hours_since_post: hoursSincePost,
      impressions: metrics.impressions || 0,
      reach: metrics.reach || 0,
      engagement_count: metrics.engagement_count || 0,
      engagement_rate: metrics.engagement_rate,
      vs_account_baseline: vsBaseline,
      classification,
      raw: metrics.raw,
    }).catch(() => {});

    // Update learning patterns
    if (concept && asset) {
      if (classification === 'winner') {
        await upsertLearningPattern({
          businessId: post.business_id,
          patternType: 'winning',
          platform: post.platform,
          trait: `hook_pattern:${asset.hook_pattern || 'unknown'}`,
          lift: vsBaseline,
          metadata: { hook: asset.hook, format: concept.format, emotion: concept.emotion },
        });
        await upsertLearningPattern({
          businessId: post.business_id,
          patternType: 'winning',
          platform: post.platform,
          trait: `format:${concept.format}`,
          lift: vsBaseline,
          metadata: { hook: asset.hook },
        });
        await upsertLearningPattern({
          businessId: post.business_id,
          patternType: 'winning',
          platform: post.platform,
          trait: `emotion:${concept.emotion}`,
          lift: vsBaseline,
        });
        // Hashtag bank
        for (const tag of asset.hashtags || []) {
          await upsertLearningPattern({
            businessId: post.business_id,
            patternType: 'hashtag_bank',
            platform: post.platform,
            trait: tag,
            lift: vsBaseline,
            metadata: { avgReach: metrics.reach },
          });
        }
      } else if (classification === 'under' || classification === 'failed') {
        await upsertLearningPattern({
          businessId: post.business_id,
          patternType: 'anti',
          platform: post.platform,
          trait: `hook_pattern:${asset.hook_pattern || 'unknown'}`,
          drag: 1 - vsBaseline,
          metadata: { example: asset.hook, reason: `underperformed vs baseline (${vsBaseline.toFixed(2)}x)` },
        });
      }

      // Prediction accuracy: compare predicted_quality_score to actual engagement_rate percentile
      const predicted = Number(asset.predicted_quality_score || 0);
      const actualRelative = Math.min(100, Math.round(vsBaseline * 50));
      const mae = Math.abs(predicted - actualRelative);
      await upsertLearningPattern({
        businessId: post.business_id,
        patternType: 'prediction_accuracy',
        platform: null,
        trait: 'global',
        lift: mae, // stored as running average via upsert logic
        metadata: { last_mae: mae },
      });
    }

    // Mark measured
    await sbPatch('content_posts', `id=eq.${postId}`, {
      performance_measured_at: new Date().toISOString(),
    }).catch(() => {});

    // Event
    await sbPost('events', {
      business_id: post.business_id,
      kind: 'wf1.performance.measured',
      workflow: '1_daily_content',
      payload: {
        post_id: postId,
        asset_id: post.asset_id,
        classification,
        vs_baseline: vsBaseline,
        engagement_rate: metrics.engagement_rate,
      },
      severity: classification === 'winner' ? 'success' : classification === 'failed' ? 'warn' : 'info',
    }).catch(() => {});

    return { ok: true, classification, vsBaseline };
  }

  // ── Sweeper: find all due posts, measure them ────────────────────────
  async function sweepDuePosts({ limit = 25 } = {}) {
    const now = new Date().toISOString();
    const rows = await sbGet(
      'content_posts',
      `performance_measured_at=is.null&performance_check_at=lte.${encodeURIComponent(now)}&order=performance_check_at.asc&limit=${limit}&select=id,business_id`
    ).catch(() => []);

    const results = [];
    for (const row of rows) {
      try {
        const r = await measurePost({ postId: row.id });
        results.push({ postId: row.id, ...r });
      } catch (e) {
        logger?.error('/wf1/learningLoop', row.business_id, 'measure failed', e, { post_id: row.id });
        results.push({ postId: row.id, ok: false, error: e.message });
      }
    }
    return { measured: results.length, results };
  }

  // ── Read learning state (for frontend /wf1-learning-state endpoint) ──
  async function getLearningState(businessId) {
    const [winners, antis, hashtags, accuracy] = await Promise.all([
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.winning&order=lift.desc&limit=15&select=trait,lift,sample_size`
      ).catch(() => []),
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.anti&order=drag.desc&limit=10&select=trait,drag,sample_size`
      ).catch(() => []),
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.hashtag_bank&order=lift.desc&limit=25&select=trait,platform,lift,sample_size,metadata`
      ).catch(() => []),
      sbGet(
        'learning_patterns',
        `business_id=eq.${businessId}&pattern_type=eq.prediction_accuracy&select=lift,sample_size`
      ).catch(() => []),
    ]);

    return {
      winningPatterns: (winners || []).map(w => ({
        trait: w.trait,
        lift: Number(w.lift || 0),
        sampleSize: w.sample_size || 0,
      })),
      antiPatterns: (antis || []).map(a => ({
        trait: a.trait,
        drag: Number(a.drag || 0),
        sampleSize: a.sample_size || 0,
      })),
      hashtagBank: (hashtags || []).map(h => ({
        tag: h.trait,
        platform: h.platform || 'all',
        avgReach: Number(h.metadata?.avgReach || 0),
        usages: h.sample_size || 0,
      })),
      predictionAccuracy: {
        mae: Number(accuracy[0]?.lift || 0),
        sampleSize: accuracy[0]?.sample_size || 0,
      },
    };
  }

  return { measurePost, sweepDuePosts, getLearningState, upsertLearningPattern };
}

module.exports = createLearningLoop;
