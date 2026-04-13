/*
 * services/wf4/index.js
 * ----------------------------------------------------------------------------
 * Workflow #4 — Reviews & Reputation engine.
 * ----------------------------------------------------------------------------
 */

'use strict';

const {
  buildReviewClassificationPrompt,
  buildReviewResponsePrompt,
  buildReviewRequestPrompt,
  buildDisputePrompt,
  WF4_GUARDRAILS,
} = require('../prompts/workflow_4_reviews.js');
const { buildBrandContext } = require('../wf1/brandContext.js');

function createWf4(deps) {
  const { sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, sendEmail, sendWhatsApp } = deps;

  async function resolveBrandContext(businessId) {
    const [b, p] = await Promise.all([
      sbGet('businesses', `id=eq.${businessId}&select=*`).catch(() => []),
      sbGet('business_profiles', `user_id=eq.${businessId}&select=*`).catch(() => []),
    ]);
    if (!b[0]) throw new Error('Business not found');
    return buildBrandContext({ business: b[0], profile: p[0] || {} });
  }

  async function classifyReview({ businessId, reviewId }) {
    const reviewRows = await sbGet('reviews', `id=eq.${reviewId}&business_id=eq.${businessId}&select=*`);
    const review = reviewRows[0];
    if (!review) throw new Error('Review not found');
    const brandContext = await resolveBrandContext(businessId);
    const { system, user } = buildReviewClassificationPrompt(brandContext, review);
    const raw = await callClaude(user, 'claude-haiku-4-5', 800, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};
    const patch = {
      category: parsed.category || 'neutral',
      urgency: parsed.urgency || 'medium',
      sentiment: Number(parsed.sentiment || 0),
      topics: parsed.topics || [],
      authenticity_score: Number(parsed.authenticityScore || 100),
      is_suspicious: !!parsed.isSuspicious,
      legal_flags: parsed.legalFlags || [],
      language: parsed.language || 'en',
    };
    await sbPatch('reviews', `id=eq.${reviewId}`, patch).catch(() => {});
    return parsed;
  }

  async function generateResponse({ businessId, reviewId, regenerate }) {
    const [reviewRows, brandContext] = await Promise.all([
      sbGet('reviews', `id=eq.${reviewId}&business_id=eq.${businessId}&select=*`),
      resolveBrandContext(businessId),
    ]);
    const review = reviewRows[0];
    if (!review) throw new Error('Review not found');

    const { system, user } = buildReviewResponsePrompt(brandContext, review);
    const raw = await callClaude(user, 'claude-sonnet-4-5', 1500, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};
    const drafts = Array.isArray(parsed.drafts) ? parsed.drafts : [parsed];

    // Deactivate previous drafts if regenerating
    if (regenerate) {
      await sbPatch('review_responses', `review_id=eq.${reviewId}`, { is_active: false }).catch(() => {});
    }

    const saved = [];
    for (const d of drafts.filter(Boolean)) {
      const row = await sbPost('review_responses', {
        business_id: businessId,
        review_id: reviewId,
        body: d.body || '',
        signature_name: d.signatureName || '',
        signature_title: d.signatureTitle || '',
        personalization_score: Number(d.personalizationScore || 0),
        brand_voice_match_score: Number(d.brandVoiceMatchScore || 0),
        word_count: d.wordCount || ((d.body || '').split(/\s+/).length),
        psychology_levers: d.psychologyLevers || [],
        predicted_impact: d.predictedImpact || 'goodwill',
        is_active: true,
      }).catch(() => null);
      if (row) saved.push(row);
    }

    await sbPatch('reviews', `id=eq.${reviewId}`, { response_status: 'awaiting_approval' }).catch(() => {});

    return {
      drafts: saved.map(r => ({
        id: r.id,
        body: r.body,
        signatureName: r.signature_name,
        signatureTitle: r.signature_title,
        personalizationScore: Number(r.personalization_score || 0),
        brandVoiceMatchScore: Number(r.brand_voice_match_score || 0),
        psychologyLevers: r.psychology_levers || [],
        predictedImpact: r.predicted_impact || 'goodwill',
      })),
    };
  }

  async function publishResponse({ businessId, reviewId, draftId, editedBody }) {
    const draftRows = await sbGet('review_responses', `id=eq.${draftId}&business_id=eq.${businessId}&select=*`);
    const draft = draftRows[0];
    if (!draft) throw new Error('Draft not found');

    const finalBody = editedBody || draft.body;
    // Platform API publish would go here (GBP, FB, Trustpilot). For now, mark as published.
    await sbPatch('review_responses', `id=eq.${draftId}`, {
      body: finalBody,
      published_at: new Date().toISOString(),
    });
    await sbPatch('reviews', `id=eq.${reviewId}`, { response_status: 'responded' });
    await sbPost('events', {
      business_id: businessId,
      kind: 'wf4.response.published',
      workflow: '4_reviews',
      payload: { review_id: reviewId, draft_id: draftId },
      severity: 'success',
    }).catch(() => {});
    return { publishedAt: new Date().toISOString() };
  }

  async function disputeReview({ businessId, reviewId }) {
    const brandContext = await resolveBrandContext(businessId);
    const reviewRows = await sbGet('reviews', `id=eq.${reviewId}&business_id=eq.${businessId}&select=*`);
    const review = reviewRows[0];
    if (!review) throw new Error('Review not found');

    const { system, user } = buildDisputePrompt(brandContext, review);
    const raw = await callClaude(user, 'claude-sonnet-4-5', 1000, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};

    const row = await sbPost('review_disputes', {
      business_id: businessId,
      review_id: reviewId,
      reason: parsed.reason || 'violation_of_platform_policy',
      justification: parsed.justification || '',
      outcome: 'pending',
    });
    await sbPatch('reviews', `id=eq.${reviewId}`, { response_status: 'disputed' });
    return { disputeId: row.id, submittedAt: row.submitted_at };
  }

  async function ignoreReview({ businessId, reviewId, reason }) {
    await sbPatch('reviews', `id=eq.${reviewId}&business_id=eq.${businessId}`, {
      response_status: 'ignored',
    });
    await sbPost('events', {
      business_id: businessId,
      kind: 'wf4.review.ignored',
      workflow: '4_reviews',
      payload: { review_id: reviewId, reason },
      severity: 'info',
    }).catch(() => {});
    return { ok: true };
  }

  async function requestReview(data) {
    const {
      businessId, customerId, customerName, customerContact, channel, platform,
      triggerKind, productOrService, staffMember,
    } = data;
    const brandContext = await resolveBrandContext(businessId);
    const { system, user } = buildReviewRequestPrompt(brandContext, {
      channel, customerName, productOrService, staffMember, triggerKind, platform,
    });
    const raw = await callClaude(user, 'claude-sonnet-4-5', 800, { system, businessId, returnRaw: true });
    const parsed = extractJSON(raw) || {};

    const row = await sbPost('review_requests', {
      business_id: businessId,
      customer_id: customerId || null,
      customer_name: customerName,
      customer_email: customerContact?.email || null,
      customer_phone: customerContact?.phone || null,
      channel,
      platform,
      trigger_kind: triggerKind,
      product_or_service: productOrService || null,
      staff_member: staffMember || null,
      sent_at: new Date().toISOString(),
      status: 'sent',
    });

    try {
      if (channel === 'email' && customerContact?.email && sendEmail) {
        await sendEmail(customerContact.email, parsed.subject || `Quick favor?`, parsed.body || '');
      } else if ((channel === 'whatsapp' || channel === 'sms') && customerContact?.phone && sendWhatsApp) {
        await sendWhatsApp(customerContact.phone, parsed.body || '');
      }
    } catch (e) {
      logger?.warn('/wf4/requestReview', businessId, 'send failed', { error: e.message });
    }

    return { requestId: row.id };
  }

  async function listReviews({ businessId, category, platform, responseStatus, limit = 50, cursor, q }) {
    let query = `business_id=eq.${businessId}&order=posted_at.desc.nullslast&limit=${limit}&select=*`;
    if (category) query += `&category=eq.${encodeURIComponent(category)}`;
    if (platform) query += `&platform=eq.${encodeURIComponent(platform)}`;
    if (responseStatus) query += `&response_status=eq.${encodeURIComponent(responseStatus)}`;
    if (cursor) query += `&posted_at=lt.${encodeURIComponent(cursor)}`;
    const rows = await sbGet('reviews', query).catch(() => []);
    const counts = { positive: 0, neutral: 0, negative: 0, critical: 0 };
    for (const r of rows) {
      const c = r.category || 'neutral';
      if (counts[c] != null) counts[c]++;
    }
    const pending = rows.filter(r => (r.response_status || 'pending') === 'pending').length;
    return {
      items: rows.map(r => rowToReviewRow(r)),
      nextCursor: rows.length === limit ? rows[rows.length - 1].posted_at : null,
      counts,
      pendingResponseCount: pending,
    };
  }

  async function getReview({ businessId, reviewId }) {
    const [reviewRows, responses] = await Promise.all([
      sbGet('reviews', `id=eq.${reviewId}&business_id=eq.${businessId}&select=*`),
      sbGet('review_responses', `review_id=eq.${reviewId}&order=created_at.desc&select=*`),
    ]);
    const r = reviewRows[0];
    if (!r) throw new Error('Review not found');
    return {
      ...rowToReviewRow(r),
      reviewerAccountAgeDays: r.reviewer_account_age_days,
      reviewerReviewCount: r.reviewer_review_count,
      reviewerLocation: r.reviewer_location,
      transactionVerified: r.transaction_verified,
      draftedResponses: responses.map(d => ({
        id: d.id,
        body: d.body,
        signatureName: d.signature_name,
        signatureTitle: d.signature_title,
        personalizationScore: Number(d.personalization_score || 0),
        brandVoiceMatchScore: Number(d.brand_voice_match_score || 0),
        wordCount: d.word_count || 0,
        psychologyLevers: d.psychology_levers || [],
        predictedImpact: d.predicted_impact || 'goodwill',
        isActive: !!d.is_active,
        createdAt: d.created_at,
      })),
    };
  }

  async function getReputationSnapshot({ businessId }) {
    const since = new Date(Date.now() - 365 * 86400000).toISOString();
    const rows = await sbGet('reviews', `business_id=eq.${businessId}&created_at=gte.${encodeURIComponent(since)}&select=platform,rating,category,sentiment,posted_at,response_status,topics,body`).catch(() => []);
    const byPlatform = new Map();
    const sentimentTimeline = new Map();
    const posTheme = new Map();
    const negTheme = new Map();

    for (const r of rows) {
      const p = r.platform;
      const rec = byPlatform.get(p) || { sum: 0, count: 0, respCount: 0 };
      rec.sum += Number(r.rating || 0);
      rec.count++;
      if (r.response_status === 'responded') rec.respCount++;
      byPlatform.set(p, rec);

      const day = (r.posted_at || r.created_at || '').slice(0, 10);
      const slot = sentimentTimeline.get(day) || { positive: 0, neutral: 0, negative: 0 };
      if (r.category === 'positive') slot.positive++;
      else if (r.category === 'neutral') slot.neutral++;
      else if (r.category === 'negative' || r.category === 'critical') slot.negative++;
      sentimentTimeline.set(day, slot);

      for (const t of r.topics || []) {
        const map = (r.category === 'positive') ? posTheme : negTheme;
        const entry = map.get(t) || { count: 0, sample: r.body || '' };
        entry.count++;
        map.set(t, entry);
      }
    }

    return {
      byPlatform: [...byPlatform.entries()].map(([platform, rec]) => ({
        platform,
        currentAvgRating: rec.count ? rec.sum / rec.count : 0,
        reviewCount: rec.count,
        monthlyVelocity: rec.count / 12,
        trajectory3m: 0,
        trajectory6m: 0,
        trajectory12m: 0,
        responseRate: rec.count ? rec.respCount / rec.count : 0,
        avgResponseTimeHours: 0,
      })),
      sentimentTimeline: [...sentimentTimeline.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({ date, ...v })),
      topPositiveThemes: [...posTheme.entries()].slice(0, 5).map(([theme, v]) => ({ theme, count: v.count, sampleQuote: v.sample.slice(0, 140) })),
      topNegativeThemes: [...negTheme.entries()].slice(0, 5).map(([theme, v]) => ({ theme, count: v.count, sampleQuote: v.sample.slice(0, 140) })),
      benchmarks: { industryAvgRating: 4.0, topCompetitorAvgRating: 4.3, directionVsIndustry: 'flat' },
      topComplaintsForOps: [...negTheme.keys()].slice(0, 5),
    };
  }

  async function getTestimonialLibrary(businessId) {
    const rows = await sbGet('testimonial_library', `business_id=eq.${businessId}&order=created_at.desc&select=*`).catch(() => []);
    return {
      items: rows.map(r => ({
        reviewId: r.review_id,
        platform: r.platform,
        reviewerName: r.reviewer_name,
        rating: Number(r.rating || 0),
        quote: r.quote,
        permissionStatus: r.permission_status || 'not_requested',
        usedIn: r.used_in || [],
      })),
    };
  }

  async function requestTestimonialPermission({ businessId, reviewId }) {
    // Create or update testimonial_library row with permission requested
    const existing = await sbGet('testimonial_library', `business_id=eq.${businessId}&review_id=eq.${reviewId}&select=id`).catch(() => []);
    if (existing[0]) {
      await sbPatch('testimonial_library', `id=eq.${existing[0].id}`, { permission_status: 'requested' });
    } else {
      const reviewRows = await sbGet('reviews', `id=eq.${reviewId}&select=platform,reviewer_name,rating,body`);
      const r = reviewRows[0] || {};
      await sbPost('testimonial_library', {
        business_id: businessId,
        review_id: reviewId,
        platform: r.platform,
        reviewer_name: r.reviewer_name,
        rating: r.rating,
        quote: (r.body || '').slice(0, 280),
        permission_status: 'requested',
      });
    }
    return { ok: true };
  }

  return {
    classifyReview,
    generateResponse,
    publishResponse,
    disputeReview,
    ignoreReview,
    requestReview,
    listReviews,
    getReview,
    getReputationSnapshot,
    getTestimonialLibrary,
    requestTestimonialPermission,
  };
}

function rowToReviewRow(r) {
  return {
    id: r.id,
    platform: r.platform,
    reviewerName: r.reviewer_name,
    reviewerProfileUrl: r.reviewer_profile_url,
    rating: Number(r.rating || 0),
    title: r.title,
    body: r.body,
    language: r.language || 'en',
    postedAt: r.posted_at || r.created_at,
    category: r.category || 'neutral',
    urgency: r.urgency || 'medium',
    sentiment: Number(r.sentiment || 0),
    topics: r.topics || [],
    authenticityScore: Number(r.authenticity_score || 100),
    isSuspicious: !!r.is_suspicious,
    legalFlags: r.legal_flags || [],
    responseStatus: r.response_status || 'pending',
    slaDeadline: r.sla_deadline,
  };
}

module.exports = createWf4;
