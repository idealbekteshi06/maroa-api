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
 * Kosovo/Albania holidays + seasonal context
 */
function getKosovoAlbaniaHolidays(date) {
  const holidays = {
    '01-01': 'Viti i Ri', '01-07': 'Krishtlindjet Ortodokse', '02-17': 'Dita e Pavarësisë së Kosovës',
    '03-08': 'Dita e Gruas', '04-09': 'Dita e Kushtetutës', '05-01': 'Dita e Punës',
    '05-09': 'Dita e Evropës', '06-01': 'Dita e Fëmijëve', '06-12': 'Dita e Paqes',
    '11-28': 'Dita e Flamurit', '11-29': 'Dita e Çlirimit', '12-25': 'Krishtlindjet', '12-31': 'Nata e Vitit të Ri'
  };
  const upcoming = [];
  const d = new Date(date);
  for (let i = 0; i <= 14; i++) {
    const check = new Date(d); check.setDate(check.getDate() + i);
    const key = `${String(check.getMonth()+1).padStart(2,'0')}-${String(check.getDate()).padStart(2,'0')}`;
    if (holidays[key]) upcoming.push(`${holidays[key]} (${i === 0 ? 'today' : 'in ' + i + ' days'})`);
  }
  return upcoming;
}

function getSeason(date) {
  const m = (date || new Date()).getMonth() + 1;
  if (m >= 3 && m <= 5) return 'spring'; if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn'; return 'winter';
}

function getAudiencePsychology(businessType, gender, ageMin) {
  const type = (businessType || '').toLowerCase();
  if (type.includes('fitness') || type.includes('gym')) return 'transformation desire, achievement motivation, social comparison, before/after framing';
  if (type.includes('restaurant') || type.includes('food') || type.includes('cafe')) return 'sensory language, social experience, FOMO, tradition and comfort';
  if (type.includes('beauty') || type.includes('salon')) return 'confidence boost, self-image improvement, luxury aspiration, visible results';
  if (type.includes('retail') || type.includes('shop')) return 'value perception, exclusivity, trend awareness, social proof';
  if (type.includes('medical') || type.includes('health') || type.includes('dental')) return 'trust and safety, expert credibility, relief from worry, family protection';
  if (type.includes('real estate') || type.includes('property')) return 'aspiration, security, investment thinking, lifestyle upgrade';
  if (type.includes('education') || type.includes('tutor')) return 'growth mindset, future potential, parental pride, career advancement';
  return 'trust building, value demonstration, social proof, local connection';
}

/**
 * Build the master system prompt for Claude
 * @param {Object} p - profile data from business_profiles table
 * @param {string} taskType - 'social_post' | 'paid_ad' | 'email' | 'sms' | 'image' | 'content_calendar' | 'general'
 * @returns {string} Complete system prompt
 */
function buildMasterPrompt(p, taskType = 'general') {
  // Safe array helper
  const arr = v => Array.isArray(v) ? v : [];
  const ja = v => arr(v).filter(Boolean).join(', ');

  // Core references used throughout
  const locs = arr(p.physical_locations);
  const primaryCity = locs[0]?.city || 'local area';
  const neighborhood = locs[0]?.neighborhood || '';
  const locationStr = locs.map(l => l.neighborhood ? `${l.neighborhood}, ${l.city}` : l.city).join(' | ') || primaryCity;
  const prods = arr(p.products);
  const tones = arr(p.tone_keywords);
  const toneStr = tones.length > 0 ? tones.join(', ') : 'professional, warm';
  const adArea = arr(p.ad_targeting_area);
  const serviceArea = arr(p.service_area);
  const competitors = arr(p.competitors);
  const painPoints = arr(p.pain_points).length ? arr(p.pain_points) : (p.pain_point ? [p.pain_point] : []);
  const objections = arr(p.objections);
  const busyMonths = arr(p.busy_months);

  // International context
  let intlCtx = '';
  let countryName = '';
  try { const ci = require('./countryIntelligence'); const cd = ci.getCountryIntelligence(ci.detectCountry(p)); countryName = cd.name; intlCtx = ci.buildInternationalContext(p); } catch {}

  let base = `You are the AI marketing engine for ${p.business_name || 'this business'}, a ${p.business_type || 'local business'} based in ${primaryCity}.

═══ BUSINESS IDENTITY ═══
Business: ${p.business_name || 'Unknown'}
Type: ${p.business_type || 'Local business'}
${p.business_description ? `Description: ${p.business_description}` : ''}
Stage: ${p.business_stage || p.business_age || 'established'}
USP: ${p.usp || 'not specified'}
${p.tagline ? `Tagline: ${p.tagline}` : ''}
${arr(p.brand_values).length ? `Brand Values: ${ja(p.brand_values)}` : ''}
Operation: ${p.operation_model || 'location_based'}

═══ LOCATION & MARKET ═══
City: ${primaryCity}${neighborhood ? ` (${neighborhood})` : ''}
Country: ${countryName || p.country || 'Kosovo'}
Serves: ${serviceArea.length > 0 ? serviceArea.join(', ') : locationStr}
Ad targeting: ${adArea.length > 0 ? adArea.join(', ') : locationStr}
⚠️ NEVER mention any city/location NOT listed above.

═══ TARGET AUDIENCE ═══
Age: ${p.audience_age_min || 18}–${p.audience_age_max || 65} | Gender: ${p.audience_gender || 'mixed'}
Who: ${p.audience_description || 'local customers'}
${p.desired_outcome ? `Their #1 desire: ${p.desired_outcome}` : ''}
${painPoints.length ? `Pain points:\n${painPoints.map((pp, i) => `  ${i+1}. ${pp}`).join('\n')}` : ''}
${p.customer_language ? `Their exact words: "${p.customer_language}"` : ''}
${objections.length ? `Objections to address:\n${objections.map((o, i) => `  ${i+1}. ${o}`).join('\n')}` : ''}
Avg spend: ${p.avg_spend || p.avg_customer_spend || 'not specified'}
${ja(p.acquisition_channels) ? `How they find us: ${ja(p.acquisition_channels)}` : ''}

═══ PRODUCTS & SERVICES ═══
${prods.length > 0
  ? prods.map(pr => `- ${pr.name}${pr.price ? ' (' + pr.price + ')' : ''}: ${pr.description || ''}${pr.is_bestseller ? ' ★ BESTSELLER' : ''}${pr.is_most_profitable ? ' 💰 MOST PROFITABLE' : ''}`).join('\n')
  : '- No products listed'}
Current offer: ${p.current_offer || 'none'}
${p.seasonal_offers ? `Seasonal offers: ${p.seasonal_offers}` : ''}
${p.what_we_dont_offer ? `We DON'T offer: ${p.what_we_dont_offer}` : ''}

═══ BRAND VOICE ═══
Tone: ${toneStr}
${p.language_formality ? `Formality: ${p.language_formality}` : ''}
${ja(p.brand_personality) ? `Personality: ${ja(p.brand_personality)}` : ''}
${ja(p.words_always_use) ? `ALWAYS use: ${ja(p.words_always_use)}` : ''}
${p.never_do || ja(p.words_never_use) ? `NEVER say: ${p.never_do || ja(p.words_never_use)}` : ''}
${p.emoji_usage ? `Emoji: ${p.emoji_usage}` : ''}
${p.content_love_example ? `Style to emulate: "${p.content_love_example}"` : ''}
${p.content_hate_example ? `Style to AVOID: "${p.content_hate_example}"` : ''}
Language: Write ONLY in ${p.primary_language || 'English'}.

═══ GOALS & STRATEGY ═══
Primary goal: ${p.primary_goal || 'grow business'}
${p.secondary_goal ? `Secondary: ${p.secondary_goal}` : ''}
${p.success_metric ? `Success metric: ${p.success_metric}` : ''}
Monthly budget: ${p.monthly_budget || 'not specified'}
${p.biggest_challenge ? `Biggest challenge: ${p.biggest_challenge}` : ''}
Ads experience: ${p.ads_experience || 'beginner'}
⚠️ Never suggest strategies above ${p.monthly_budget || 'their'} budget.

═══ PLATFORMS & CONTENT ═══
${ja(p.active_platforms) ? `Active on: ${ja(p.active_platforms)}` : ''}
${p.primary_platform ? `Primary: ${p.primary_platform}` : ''}
${p.content_worked ? `What works: ${p.content_worked}` : ''}
${p.content_flopped ? `What flopped: ${p.content_flopped}` : ''}
${p.website_url ? `Website: ${p.website_url}` : ''}
${p.booking_link ? `Booking: ${p.booking_link}` : ''}

═══ COMPETITIVE POSITION ═══
${competitors.length ? `Competitors: ${competitors.map(c => typeof c === 'string' ? c : c.name).filter(Boolean).join(', ')}` : ''}
${p.competitor_weaknesses ? `Their weaknesses: ${p.competitor_weaknesses}` : ''}
${p.why_customers_choose_us ? `Why customers choose US: ${p.why_customers_choose_us}` : ''}
${p.we_do_better ? `We excel at: ${p.we_do_better}` : ''}
${p.they_do_better ? `They excel at: ${p.they_do_better} — avoid head-to-head here` : ''}
${p.price_comparison ? `Price position: ${p.price_comparison}` : ''}
${ja(p.competitors_never_mention) ? `NEVER mention: ${ja(p.competitors_never_mention)}` : ''}

═══ OPERATIONS ═══
Hours: ${buildHoursSummary(p.business_hours)}
${ja(p.busiest_days) ? `Busiest days: ${ja(p.busiest_days)} — promote before these` : ''}
${ja(p.quietest_days) ? `Quietest days: ${ja(p.quietest_days)} — run specials` : ''}
Seasonal: ${p.seasonal || p.seasonality_description || 'year_round'}${busyMonths.length ? ', busy: ' + busyMonths.join(', ') : ''}
${p.upcoming_events ? `Upcoming events: ${p.upcoming_events}` : ''}
${ja(p.best_posting_time) ? `Best posting times: ${ja(p.best_posting_time)}` : ''}

${intlCtx}
═══ TIMING ═══
Today: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
Season: ${getSeason(new Date())}
Upcoming holidays: ${getKosovoAlbaniaHolidays(new Date()).join(', ') || 'none in next 14 days'}

═══ AUDIENCE PSYCHOLOGY ═══
Triggers: ${getAudiencePsychology(p.business_type, p.audience_gender, p.audience_age_min)}

═══ SENSITIVE TOPICS ═══
${p.sensitive_topics ? `NEVER mention: ${p.sensitive_topics}` : ''}
${ja(p.never_show) ? `Never show in images: ${ja(p.never_show)}` : ''}

═══ ABSOLUTE RULES ═══
1. Use exact name "${p.business_name}" — never abbreviate or change
2. Only mention locations in: ${adArea.length ? adArea.join(', ') : primaryCity}
3. Write in ${p.primary_language || 'English'} — no exceptions
4. Tone: ${toneStr} — every word must match
5. ${p.never_do || ja(p.words_never_use) ? `Never: ${p.never_do || ja(p.words_never_use)}` : 'No restrictions specified'}
6. Serve goal: ${p.primary_goal || 'grow business'}
7. Use real product names and prices from the list
8. ${p.desired_outcome ? `Address desire: "${p.desired_outcome}"` : 'Address customer needs'}
9. ${p.customer_language ? `Use customer words: "${p.customer_language}"` : 'Use natural audience language'}`;

  const taskPrompts = {
    social_post: `\n\n═══ TASK: SOCIAL MEDIA POST ═══
${p.primary_platform ? `Focus platform: ${p.primary_platform}` : `Platform: Instagram/Facebook`}
Include local hashtags for ${primaryCity}.
${p.content_worked ? `Replicate what works: ${p.content_worked}` : ''}
${p.content_flopped ? `Avoid: ${p.content_flopped}` : ''}
CTA: specific action${p.booking_link ? ` → ${p.booking_link}` : p.website_url ? ` → ${p.website_url}` : ''}.
Tone: ${toneStr}. ${p.emoji_usage === 'heavy' ? 'Use plenty of emojis.' : p.emoji_usage === 'none' ? 'No emojis.' : '2-4 emojis.'}`,

    paid_ad: `\n\n═══ TASK: PAID ADVERTISEMENT ═══
Target: ${adArea.length > 0 ? adArea.join(', ') : primaryCity} — EXACTLY these locations.
Audience: ${p.audience_age_min || 18}–${p.audience_age_max || 65}, ${p.audience_gender || 'mixed'}.
Budget: ${p.monthly_budget || 'modest'}.
Focus: ${p.usp || 'main value'} + ${p.why_customers_choose_us || p.we_do_better || 'our strengths'}.
Offer: ${p.current_offer || 'main service'}.
${painPoints[0] ? `Hook with pain: "${painPoints[0]}"` : ''}
${p.desired_outcome ? `Promise outcome: "${p.desired_outcome}"` : ''}
Meta headline: max 40 chars. Body: max 125 chars.`,

    email: `\n\n═══ TASK: EMAIL CAMPAIGN ═══
${painPoints[0] ? `Subject addresses: "${painPoints[0]}"` : ''}
Offer: ${p.current_offer || 'main service'}.
${p.has_email_list ? `List size: ${p.email_list_size || 'active list'}` : ''}
Length: 150-200 words. Tone: ${toneStr}.
${p.booking_link ? `CTA link: ${p.booking_link}` : ''}`,

    sms: `\n\n═══ TASK: SMS ═══
Max 160 chars. Direct. ${p.primary_language || 'English'}.
CTA for: ${p.primary_goal || 'action'}.${p.booking_link ? ` Link: ${p.booking_link}` : ''}`,

    image: `\n\n═══ TASK: IMAGE ═══
Local feel: ${primaryCity}. Mood: ${toneStr}.
${ja(p.brand_colors) ? `Colors: ${ja(p.brand_colors)}` : ''}
${p.visual_style ? `Style: ${p.visual_style}` : ''}
${ja(p.never_show) ? `Never show: ${ja(p.never_show)}` : ''}`,

    content_calendar: `\n\n═══ TASK: CONTENT CALENDAR ═══
Season: ${p.seasonal || 'year_round'}.${busyMonths.length ? ' Busy: ' + busyMonths.join(', ') : ''}
Goal: ${p.primary_goal}. Budget: ${p.monthly_budget || 'modest'}.
${p.posting_frequency_goal ? `Target: ${p.posting_frequency_goal}` : ''}
${ja(p.active_platforms) ? `Platforms: ${ja(p.active_platforms)}` : ''}`,

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
async function buildMasterPromptWithSkills(profile, taskType, getEmbedding, pineconeQuery, buildIntelligenceCtx, getMemoryCtx, extraContext = '') {
  const basePrompt = buildMasterPrompt(profile, taskType) + (extraContext ? '\n\n' + extraContext : '');

  let skillsSection = '';
  try {
    // Try Pinecone first
    const { getRelevantSkills, getAllSkillKnowledge } = require('./marketingKnowledgeBase');
    let skills = [];
    try { skills = await getRelevantSkills(getEmbedding, pineconeQuery, taskType, profile.business_type, profile.primary_goal, 2); } catch {}

    // Fallback: pick skills directly from code if Pinecone returned nothing
    if (!skills.length) {
      const allSkills = getAllSkillKnowledge();
      const taskTypeMap = { social_post: ['social_content_strategy','copywriting_principles'], paid_ad: ['ad_creative_frameworks','paid_ads_strategy'], email: ['email_sequence_strategy','copywriting_principles'], content_calendar: ['content_strategy','social_content_strategy'], sales_pitch: ['copywriting_principles','marketing_psychology'], lead_magnet: ['content_strategy','marketing_psychology'], launch: ['launch_strategy','content_strategy'], general: ['marketing_psychology','copywriting_principles'] };
      const relevantIds = taskTypeMap[taskType] || taskTypeMap.general;
      skills = allSkills.filter(s => relevantIds.includes(s.id)).map(s => ({ name: s.name, content: s.content.slice(0, 1500), score: 0.9 }));
    }

    if (skills.length) {
      skillsSection = `\n\n═══ EXPERT MARKETING FRAMEWORKS TO APPLY ═══\n${skills.slice(0, 2).map(s =>
        `[${s.name.toUpperCase()}]\n${s.content}`
      ).join('\n\n')}\n═══ APPLY THESE FRAMEWORKS ═══`;
    }
  } catch {}

  let intelligenceSection = '';
  try {
    if (typeof buildIntelligenceCtx === 'function') {
      const ctx = await buildIntelligenceCtx(profile.user_id);
      if (ctx) intelligenceSection = '\n\n' + ctx;
    }
  } catch {}

  let memorySection = '';
  try {
    if (typeof getMemoryCtx === 'function') {
      const mem = await getMemoryCtx(profile.user_id);
      if (mem) memorySection = '\n' + mem;
    }
  } catch {}

  return basePrompt + skillsSection + intelligenceSection + memorySection;
}

module.exports = {
  buildMasterPrompt,
  buildMasterPromptWithSkills,
  calculateProfileScore,
  getMissingFields,
  validateBeforeGeneration,
  buildHoursSummary,
  getKosovoAlbaniaHolidays,
  getSeason,
  getAudiencePsychology
};
