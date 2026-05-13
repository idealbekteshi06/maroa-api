'use strict';

/**
 * services/prompts/specialists/_helpers.js
 * ---------------------------------------------------------------------------
 * Shared utilities for the 7 specialist mode dispatchers.
 *
 * A "specialist" combines methodology + channel + compliance preferences
 * into a coherent persona that handles a specific marketing job. Where
 * methodologies are atomic ideas (AIDA, Schwartz) and channels are atomic
 * surfaces (TikTok, email), specialists are roles ("direct-response
 * copywriter", "brand-builder") that bundle their preferred tools.
 *
 * The master pipeline (Wave 60 S10) picks ONE specialist per job —
 * different jobs go to different specialists (a YC-pitch landing page
 * goes to the brand-builder, a Black-Friday email goes to the
 * direct-response specialist).
 */

function _normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function _scoreFitForJob(weights, signals) {
  let total = 0;
  let count = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (signals[key] != null) {
      total += weight * signals[key];
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

/**
 * Build a standard specialist module from a declarative spec.
 */
function buildSpecialistModule(spec) {
  const {
    id,
    name,
    description,
    source_citation,
    preferred_methodologies = [],
    preferred_channels = [],
    decision_style,
    prompt_persona,
    manipulation_risk_ceiling = 4,
    job_fit_weights = {},
    extraSegments,
  } = spec;

  function chooseForJob({
    goal,
    funnel_stage,
    channel,
    customer_type,
  } = {}) {
    const signals = {};
    // Channel match
    if (channel) {
      signals.channel_match = preferred_channels.includes(channel) ? 1 : 0;
    }
    // Goal keyword match
    const goalLower = _normalize(goal || '');
    if (job_fit_weights.urgency_goal && /\b(sale|launch|black friday|flash|countdown|deadline|today\s+only)\b/i.test(goalLower)) {
      signals.urgency_goal = 1;
    } else {
      signals.urgency_goal = 0;
    }
    if (job_fit_weights.brand_goal && /\b(brand|story|values|mission|culture|long-term)\b/i.test(goalLower)) {
      signals.brand_goal = 1;
    } else {
      signals.brand_goal = 0;
    }
    if (job_fit_weights.seo_goal && /\b(seo|rank|search|google|organic|article|blog)\b/i.test(goalLower)) {
      signals.seo_goal = 1;
    } else {
      signals.seo_goal = 0;
    }
    if (job_fit_weights.viral_goal && /\b(viral|referral|growth|loop|share|invite)\b/i.test(goalLower)) {
      signals.viral_goal = 1;
    } else {
      signals.viral_goal = 0;
    }
    if (job_fit_weights.retention_goal && (funnel_stage === 'retention' || customer_type === 'existing')) {
      signals.retention_goal = 1;
    } else {
      signals.retention_goal = 0;
    }
    if (job_fit_weights.performance_goal && /\b(roas|ctr|cpa|conversion|optimi[sz]e|a\/b)\b/i.test(goalLower)) {
      signals.performance_goal = 1;
    } else {
      signals.performance_goal = 0;
    }
    // social_goal: tight enough to avoid matching brand "story" / "long-term story".
    // "story" alone overlaps with brand-storytelling — require platform context.
    if (
      job_fit_weights.social_goal &&
      /\b(daily\s+post|feed|reel|caption|tiktok|instagram\s+post|instagram\s+stor|social\s+media)\b/i.test(goalLower)
    ) {
      signals.social_goal = 1;
    } else {
      signals.social_goal = 0;
    }

    const score = _scoreFitForJob(job_fit_weights, signals);
    return { id, name, score, signals, manipulation_risk_ceiling };
  }

  function generateBriefSegments(context = {}) {
    const segments = [];
    segments.push(`SPECIALIST: ${name} — ${description}`);
    if (prompt_persona) segments.push(`PERSONA: ${prompt_persona}`);
    if (decision_style) segments.push(`DECISION STYLE: ${decision_style}`);
    if (preferred_methodologies.length) {
      segments.push(`PRIMARY METHODOLOGIES: ${preferred_methodologies.slice(0, 4).join(', ')}.`);
    }
    if (preferred_channels.length) {
      segments.push(`PRIMARY CHANNELS: ${preferred_channels.slice(0, 4).join(', ')}.`);
    }
    segments.push(`MANIPULATION-RISK CEILING: ${manipulation_risk_ceiling}/10 (output rejected if exceeded).`);
    if (typeof extraSegments === 'function') {
      try {
        const extra = extraSegments(context) || [];
        for (const seg of extra) if (seg) segments.push(seg);
      } catch (e) {
        // soft-fail
      }
    }
    return segments;
  }

  return {
    id,
    name,
    description,
    source_citation,
    preferred_methodologies,
    preferred_channels,
    decision_style,
    prompt_persona,
    manipulation_risk_ceiling,
    job_fit_weights,
    chooseForJob,
    generateBriefSegments,
  };
}

module.exports = {
  _normalize,
  _scoreFitForJob,
  buildSpecialistModule,
};
