'use strict';

/**
 * Premium XML-structured brand context renderer — used ONLY by WF1.
 * ---------------------------------------------------------------------------
 * Other workflows continue using foundation.js renderBrandContext() (flat text).
 * This file produces a richer, XML-structured context block that leverages
 * Anthropic's native XML parsing for better prompt grounding.
 *
 * Design principles:
 *   - Graceful degradation: empty fields are omitted entirely (no blank tags)
 *   - XML tags give Claude clear boundaries for each context section
 *   - Sections ordered by strategic importance: identity → positioning → voice
 *     → audience → competition → economics → strategy → performance memory
 * ---------------------------------------------------------------------------
 */

function renderPremiumBrandContext(ctx) {
  const safe = (v) => (v === undefined || v === null || v === '') ? null : String(v);
  const safeArr = (v) => Array.isArray(v) && v.length ? v : null;
  const wrap = (tag, value) => value !== null ? `<${tag}>${value}</${tag}>` : '';
  const wrapList = (tag, arr) => arr ? `<${tag}>${arr.join(', ')}</${tag}>` : '';

  const sections = [];

  // ═══ IDENTITY ═══
  const identityParts = [
    wrap('business_name', safe(ctx.businessName)),
    wrap('industry', safe(ctx.industry)),
    wrap('business_type', safe(ctx.businessType)),
    wrap('business_model', safe(ctx.businessModel)),
    wrap('description', safe(ctx.businessDescription)?.slice(0, 500)),
    wrap('tagline', safe(ctx.tagline)),
    wrap('website', safe(ctx.websiteUrl)),
    wrap('marketing_stage', safe(ctx.marketingStage)),
    wrap('narrative_arc', safe(ctx.narrativeArc)),
  ].filter(Boolean).join('\n  ');
  if (identityParts) sections.push(`<brand_identity>\n  ${identityParts}\n</brand_identity>`);

  // ═══ POSITIONING ═══
  const positioningParts = [
    wrap('unique_selling_proposition', safe(ctx.uniqueSellingProposition)),
    wrap('we_do_better_than_competitors', safe(ctx.weDoBetter)),
    wrap('competitors_advantage_over_us', safe(ctx.theyDoBetter)),
    wrap('current_offer', safe(ctx.currentOffer)),
  ].filter(Boolean).join('\n  ');
  if (positioningParts) sections.push(`<positioning>\n  ${positioningParts}\n</positioning>`);

  // ═══ VOICE ═══
  const voiceParts = [
    wrap('tone', safe(ctx.brandVoice?.tone)),
    wrapList('preferred_vocabulary', safeArr(ctx.brandVoice?.vocabulary)),
    wrapList('banned_words_strict_never_use', safeArr(ctx.bannedWords)),
  ].filter(Boolean).join('\n  ');
  if (voiceParts) sections.push(`<voice>\n  ${voiceParts}\n</voice>`);

  // ═══ AUDIENCE ═══
  const audienceParts = [];
  if (ctx.ageMin || ctx.ageMax) {
    audienceParts.push(`<age_range>${ctx.ageMin || 18}-${ctx.ageMax || 65}</age_range>`);
  }
  if (ctx.gender && ctx.gender !== 'mixed' && ctx.gender !== 'all') {
    audienceParts.push(`<gender>${ctx.gender}</gender>`);
  }
  if (safeArr(ctx.audienceInterests)) {
    audienceParts.push(`<interests_and_tone_keywords>${ctx.audienceInterests.join(', ')}</interests_and_tone_keywords>`);
  }
  if (ctx.painPointsFull) {
    audienceParts.push(`<pain_points>${String(ctx.painPointsFull).slice(0, 600)}</pain_points>`);
  }
  if (ctx.dreamCustomer) {
    audienceParts.push(`<dream_customer_profile>${String(ctx.dreamCustomer).slice(0, 600)}</dream_customer_profile>`);
  }
  // Personas from the original brandContext
  if (ctx.audience?.personas?.length) {
    const personaXML = ctx.audience.personas.map(p => {
      const parts = [
        `<name>${p.name}</name>`,
        `<jtbd>${p.jtbd}</jtbd>`,
        p.painPoints?.length ? `<pain_points>${p.painPoints.join('; ')}</pain_points>` : '',
      ].filter(Boolean).join(' ');
      return `  <persona>${parts}</persona>`;
    }).join('\n');
    audienceParts.push(personaXML);
  }
  if (audienceParts.length) sections.push(`<audience>\n  ${audienceParts.join('\n  ')}\n</audience>`);

  // ═══ COMPETITIVE LANDSCAPE ═══
  const compParts = [];
  if (Array.isArray(ctx.competitors) && ctx.competitors.length) {
    const compXML = ctx.competitors.map(c => {
      const parts = [
        c.name ? `<name>${c.name}</name>` : '',
        c.website ? `<website>${c.website}</website>` : '',
        c.position ? `<position>${c.position}</position>` : '',
      ].filter(Boolean).join(' ');
      return `  <competitor>${parts}</competitor>`;
    }).join('\n');
    compParts.push(compXML);
  }
  if (ctx.theyDoBetter) compParts.push(`  <what_they_do_better>${ctx.theyDoBetter}</what_they_do_better>`);
  if (ctx.weDoBetter) compParts.push(`  <what_we_do_better>${ctx.weDoBetter}</what_we_do_better>`);
  if (compParts.length) sections.push(`<competitive_landscape>\n${compParts.join('\n')}\n</competitive_landscape>`);

  // ═══ PRODUCTS & OFFERS ═══
  if (safeArr(ctx.products)) {
    const prodXML = ctx.products.slice(0, 10).map(p => {
      if (typeof p === 'string') return `  <product>${p}</product>`;
      return `  <product><name>${p.name || p.title || 'Product'}</name>${p.price ? ` <price>${p.price}</price>` : ''}${p.description ? ` <description>${String(p.description).slice(0, 200)}</description>` : ''}</product>`;
    }).join('\n');
    sections.push(`<products>\n${prodXML}\n</products>`);
  }

  // ═══ BUSINESS ECONOMICS ═══
  const econParts = [];
  if (ctx.monthlyBudget) econParts.push(`<monthly_budget>${ctx.monthlyBudget}</monthly_budget>`);
  if (ctx.avgOrderValue) econParts.push(`<avg_order_value>${ctx.avgOrderValue}</avg_order_value>`);
  if (ctx.ltv) econParts.push(`<ltv_target>${ctx.ltv}</ltv_target>`);
  if (ctx.cacTarget) econParts.push(`<cac_ceiling>${ctx.cacTarget}</cac_ceiling>`);
  if (econParts.length) sections.push(`<business_economics>\n  ${econParts.join('\n  ')}\n</business_economics>`);

  // ═══ STRATEGY ═══
  const stratParts = [];
  if (ctx.primaryMarketingGoal) stratParts.push(`<primary_goal>${ctx.primaryMarketingGoal}</primary_goal>`);
  if (ctx.adsExperience) stratParts.push(`<ads_experience>${ctx.adsExperience}</ads_experience>`);
  if (safeArr(ctx.activePlatforms)) stratParts.push(`<active_platforms>${ctx.activePlatforms.join(', ')}</active_platforms>`);
  if (ctx.postingFrequency && ctx.postingFrequency !== 'auto') stratParts.push(`<posting_preference>${ctx.postingFrequency}</posting_preference>`);
  if (safeArr(ctx.primaryMarkets)) stratParts.push(`<markets>${ctx.primaryMarkets.join(', ')}</markets>`);
  if (safeArr(ctx.primaryLanguages)) stratParts.push(`<languages>${ctx.primaryLanguages.join(', ')}</languages>`);
  if (ctx.seasonal && ctx.seasonal !== 'year_round') {
    stratParts.push(`<seasonality>${ctx.seasonal}${safeArr(ctx.busyMonths) ? ` (busy: ${ctx.busyMonths.join(', ')})` : ''}</seasonality>`);
  }
  if (safeArr(ctx.contentPillars)) {
    stratParts.push(`<content_pillars>${ctx.contentPillars.map(p => `${p.name} (${p.allocation}%)`).join(' | ')}</content_pillars>`);
  }
  if (stratParts.length) sections.push(`<strategic_context>\n  ${stratParts.join('\n  ')}\n</strategic_context>`);

  // ═══ PERFORMANCE MEMORY ═══
  if (ctx.bestPerformingThemes || ctx.worstPerformingThemes) {
    const perfParts = [];
    if (safeArr(ctx.bestPerformingThemes)) perfParts.push(`<winning_themes>${ctx.bestPerformingThemes.join(', ')}</winning_themes>`);
    if (safeArr(ctx.worstPerformingThemes)) perfParts.push(`<anti_themes>${ctx.worstPerformingThemes.join(', ')}</anti_themes>`);
    if (perfParts.length) sections.push(`<performance_memory>\n  ${perfParts.join('\n  ')}\n</performance_memory>`);
  }

  return sections.join('\n\n');
}

module.exports = { renderPremiumBrandContext };
