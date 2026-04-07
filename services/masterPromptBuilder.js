'use strict';

/**
 * Builds hours summary string from business_hours JSON
 * Input: { mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" }, ... }
 */
function buildHoursSummary(hours) {
  if (!hours || typeof hours !== 'object' || Object.keys(hours).length === 0) return 'Not specified';
  const dayNames = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const parts = [];
  for (const [day, val] of Object.entries(hours)) {
    if (!val || val.closed) continue;
    const name = dayNames[day] || day;
    parts.push(`${name}: ${val.open || '?'}–${val.close || '?'}`);
  }
  return parts.length ? parts.join(', ') : 'Not specified';
}

/**
 * Calculate profile completeness score (0-100)
 */
function calculateProfileScore(p) {
  let score = 0;

  // Identity block (15 pts)
  if (p.business_name) score += 5;
  if (p.business_type) score += 4;
  if (p.business_age) score += 3;
  if (p.usp) score += 3;

  // Location block (25 pts)
  const locs = Array.isArray(p.physical_locations) ? p.physical_locations : [];
  if (locs.length > 0 && locs[0]?.city) score += 10;
  if (p.operation_model) score += 5;
  const adAreas = Array.isArray(p.ad_targeting_area) ? p.ad_targeting_area : [];
  if (adAreas.length > 0) score += 5;
  if (p.primary_language) score += 5;

  // Audience block (15 pts)
  if (p.audience_age_min != null && p.audience_age_max != null) score += 4;
  if (p.audience_gender) score += 3;
  if (p.audience_description) score += 4;
  if (p.pain_point) score += 4;

  // Products block (15 pts)
  const prods = Array.isArray(p.products) ? p.products : [];
  if (prods.length > 0) score += 10;
  if (p.current_offer) score += 5;

  // Goals block (15 pts)
  if (p.primary_goal) score += 6;
  if (p.monthly_budget) score += 5;
  if (p.ads_experience) score += 4;

  // Brand voice block (10 pts)
  const tones = Array.isArray(p.tone_keywords) ? p.tone_keywords : [];
  if (tones.length > 0) score += 6;
  if (p.never_do) score += 4;

  // Operations block (5 pts)
  if (p.business_hours && Object.keys(p.business_hours).length > 0) score += 3;
  if (p.seasonal) score += 2;

  return Math.min(100, score);
}

/**
 * Get missing fields for next unlock threshold
 */
function getMissingFields(p) {
  const missing = [];
  if (!p.business_name) missing.push('business_name');
  if (!p.business_type) missing.push('business_type');
  const locs = Array.isArray(p.physical_locations) ? p.physical_locations : [];
  if (locs.length === 0 || !locs[0]?.city) missing.push('physical_locations');
  if (!p.primary_language) missing.push('primary_language');
  if (!p.operation_model) missing.push('operation_model');
  const adAreas = Array.isArray(p.ad_targeting_area) ? p.ad_targeting_area : [];
  if (adAreas.length === 0) missing.push('ad_targeting_area');
  if (!p.audience_description) missing.push('audience_description');
  if (!p.pain_point) missing.push('pain_point');
  const prods = Array.isArray(p.products) ? p.products : [];
  if (prods.length === 0) missing.push('products');
  if (!p.primary_goal) missing.push('primary_goal');
  if (!p.monthly_budget) missing.push('monthly_budget');
  const tones = Array.isArray(p.tone_keywords) ? p.tone_keywords : [];
  if (tones.length === 0) missing.push('tone_keywords');
  if (!p.never_do) missing.push('never_do');
  if (!p.business_hours || Object.keys(p.business_hours).length === 0) missing.push('business_hours');
  return missing;
}

/**
 * Build the master system prompt for Claude
 * @param {Object} p - profile data from business_profiles table
 * @param {string} taskType - 'social_post' | 'paid_ad' | 'email' | 'sms' | 'image' | 'content_calendar' | 'general'
 * @returns {string} Complete system prompt
 */
function buildMasterPrompt(p, taskType = 'general') {
  const locs = Array.isArray(p.physical_locations) ? p.physical_locations : [];
  const locationStr = locs.map(l => l.neighborhood ? `${l.neighborhood}, ${l.city}` : l.city).join(' | ') || 'local area';
  const primaryCity = locs[0]?.city || 'local area';

  const prods = Array.isArray(p.products) ? p.products : [];
  const productsStr = prods.length > 0
    ? prods.map(prod => `- ${prod.name}${prod.price ? ' (' + prod.price + ')' : ''}: ${prod.description || ''}${prod.is_bestseller ? ' ★ BESTSELLER' : ''}`).join('\n')
    : '- No products listed';

  const tones = Array.isArray(p.tone_keywords) ? p.tone_keywords : [];
  const toneStr = tones.length > 0 ? tones.join(', ') : 'professional, warm';
  const serviceArea = Array.isArray(p.service_area) ? p.service_area : [];
  const adArea = Array.isArray(p.ad_targeting_area) ? p.ad_targeting_area : [];
  const busyMonths = Array.isArray(p.busy_months) ? p.busy_months : [];

  let base = `You are the AI marketing engine for ${p.business_name || 'this business'}, a ${p.business_type || 'local business'} based in ${primaryCity}.

═══ BUSINESS CONTEXT ═══
Business: ${p.business_name || 'Unknown'}
Type: ${p.business_type || 'Local business'} (${p.business_age || 'established'} business)
USP: ${p.usp || 'not specified'}
Tagline: ${p.tagline || 'none'}
Operation model: ${p.operation_model || 'location_based'}
Physical location(s): ${locationStr}

═══ TARGET AREA — STRICTLY ENFORCE ═══
Serves: ${serviceArea.length > 0 ? serviceArea.join(', ') : locationStr}
Ads run in: ${adArea.length > 0 ? adArea.join(', ') : locationStr}
⚠️ RULE: NEVER mention any city or location NOT listed above. Never invent or assume locations.

═══ AUDIENCE ═══
Age: ${p.audience_age_min || 18}–${p.audience_age_max || 65} years
Gender: ${p.audience_gender || 'mixed'}
Who they are: ${p.audience_description || 'local customers'}
Their problem before finding us: ${p.pain_point || 'not specified'}
Average spend: ${p.avg_spend || 'not specified'}

═══ PRODUCTS & SERVICES ═══
${productsStr}
Current offer: ${p.current_offer || 'none'}

═══ GOALS & BUDGET ═══
Primary goal: ${p.primary_goal || 'grow business'}
Monthly budget: ${p.monthly_budget || 'not specified'}
⚠️ RULE: Never suggest strategies that require budget above ${p.monthly_budget || 'their stated budget'}.

═══ BRAND VOICE ═══
Tone: ${toneStr}
NEVER do or say: ${p.never_do || 'nothing specified'}
Language: Write ONLY in ${p.primary_language || 'Albanian'}. This is a strict requirement.

═══ COMPETITIVE POSITION ═══
We are better at: ${p.we_do_better || 'not specified'}
Competitors are better at: ${p.they_do_better || 'not specified'} — do not make claims in these areas

═══ OPERATIONS ═══
Business hours: ${buildHoursSummary(p.business_hours)}
Seasonal: ${p.seasonal || 'year_round'}${busyMonths.length ? ', busy months: ' + busyMonths.join(', ') : ''}

═══ ABSOLUTE RULES ═══
1. Never mention a city or location not listed in TARGET AREA
2. Never suggest budget above ${p.monthly_budget || 'their budget'}
3. Always write in ${p.primary_language || 'Albanian'} — no exceptions
4. Always reflect tone: ${toneStr}
5. Never violate: ${p.never_do || 'nothing specified'}
6. Every piece of content must serve the goal: ${p.primary_goal || 'grow business'}
7. Use exact product names from the list above — never generic descriptions
8. Reference specific neighborhood/area for local targeting when relevant
9. Schedule content based on business hours — never post outside active hours`;

  const taskPrompts = {
    social_post: `\n\n═══ TASK: SOCIAL MEDIA POST ═══
Create engaging social content that feels authentic to the local community.
Include relevant local hashtags for ${primaryCity}.
CTA must be specific — never generic "contact us".
Tone must match: ${toneStr}.`,

    paid_ad: `\n\n═══ TASK: PAID ADVERTISEMENT ═══
Target location: ${adArea.length > 0 ? adArea.join(', ') : locationStr} — USE EXACTLY THESE LOCATIONS ONLY.
Target audience: ${p.audience_age_min || 18}–${p.audience_age_max || 65}, ${p.audience_gender || 'mixed'}.
Budget context: ${p.monthly_budget || 'not specified'} — recommend appropriate bid strategy.
Focus message on: ${p.usp || 'main service'} and ${p.we_do_better || 'our strengths'}.
Offer to highlight: ${p.current_offer || 'main service'}.
Meta headline: max 40 characters. Body: max 125 characters.
DO NOT target or reference any city outside: ${adArea.length > 0 ? adArea.join(', ') : locationStr}.`,

    email: `\n\n═══ TASK: EMAIL CAMPAIGN ═══
Write subject line that addresses pain point: ${p.pain_point || 'customer need'}.
Include offer: ${p.current_offer || 'main service'}.
Language: ${p.primary_language || 'Albanian'} — strict.
Length: 150–200 words. Professional but matching tone: ${toneStr}.`,

    sms: `\n\n═══ TASK: SMS CAMPAIGN ═══
Max 160 characters. Direct and urgent.
Language: ${p.primary_language || 'Albanian'}.
Include clear CTA aligned with goal: ${p.primary_goal || 'grow business'}.`,

    image: `\n\n═══ TASK: IMAGE GENERATION ═══
Style: authentic, local feel for ${primaryCity}.
Mood: ${toneStr}.
Avoid: generic stock photo feel, locations not matching ${primaryCity}.
Business type context: ${p.business_type || 'local business'}.`,

    content_calendar: `\n\n═══ TASK: CONTENT CALENDAR ═══
Plan content that aligns with seasonal context: ${p.seasonal || 'year_round'}.
${busyMonths.length ? 'Busy months to prepare for: ' + busyMonths.join(', ') : ''}
Every post must serve primary goal: ${p.primary_goal || 'grow business'}.
Budget for paid promotion this month: ${p.monthly_budget || 'not specified'}.
Default posting frequency for ${p.business_type || 'local business'}: recommend based on budget and type.`,

    general: ''
  };

  return base + (taskPrompts[taskType] || '');
}

/**
 * Validate profile before content generation
 */
function validateBeforeGeneration(profile, taskType) {
  const errors = [];
  if (!profile) {
    errors.push('Complete your business profile to generate accurate content.');
    return errors;
  }
  const locs = Array.isArray(profile.physical_locations) ? profile.physical_locations : [];
  if (locs.length === 0 || !locs[0]?.city) {
    errors.push('Add your business location in profile settings to generate accurate content.');
  }
  if ((!Array.isArray(profile.ad_targeting_area) || profile.ad_targeting_area.length === 0) && taskType === 'paid_ad') {
    errors.push('Set your ad targeting area in profile settings before creating ads.');
  }
  if (!profile.monthly_budget && taskType === 'paid_ad') {
    errors.push('Set your monthly budget in profile settings to get relevant ad strategies.');
  }
  if (!profile.primary_language) {
    errors.push('Set your business language in profile settings.');
  }
  return errors;
}

/**
 * Build master prompt enhanced with relevant marketing skills from Pinecone.
 * @param {Object} profile - business profile
 * @param {string} taskType - content type
 * @param {Function} getEmbedding - embedding function
 * @param {Function} pineconeQuery - Pinecone query function
 */
async function buildMasterPromptWithSkills(profile, taskType, getEmbedding, pineconeQuery) {
  const basePrompt = buildMasterPrompt(profile, taskType);

  try {
    const { getRelevantSkills } = require('./marketingKnowledgeBase');
    const skills = await getRelevantSkills(
      getEmbedding, pineconeQuery,
      taskType,
      profile.business_type,
      profile.primary_goal,
      2
    );
    if (!skills.length) return basePrompt;

    const skillsSection = `\n\n═══ EXPERT MARKETING FRAMEWORKS TO APPLY ═══\n${skills.map(s =>
      `[${s.name.toUpperCase()} — relevance: ${(s.score * 100).toFixed(0)}%]\n${s.content}`
    ).join('\n\n')}\n\n═══ APPLY THESE FRAMEWORKS TO ALL CONTENT ABOVE ═══`;

    return basePrompt + skillsSection;
  } catch {
    return basePrompt;
  }
}

module.exports = {
  buildMasterPrompt,
  buildMasterPromptWithSkills,
  calculateProfileScore,
  getMissingFields,
  validateBeforeGeneration,
  buildHoursSummary
};
