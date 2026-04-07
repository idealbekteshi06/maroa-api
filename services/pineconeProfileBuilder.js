'use strict';

const { buildMasterPrompt, buildHoursSummary } = require('./masterPromptBuilder');

/**
 * Build and store structured brand profile in Pinecone
 * @param {string} userId - business user ID
 * @param {Object} profileData - full profile from business_profiles
 * @param {Function} getEmbedding - function to generate embeddings
 * @param {Function} pineconeUpsert - function to upsert to Pinecone
 */
async function buildAndStorePineconeProfile(userId, profileData, getEmbedding, pineconeUpsert) {
  const locs = Array.isArray(profileData.physical_locations) ? profileData.physical_locations : [];
  const prods = Array.isArray(profileData.products) ? profileData.products : [];
  const tones = Array.isArray(profileData.tone_keywords) ? profileData.tone_keywords : [];
  const serviceArea = Array.isArray(profileData.service_area) ? profileData.service_area : [];
  const adArea = Array.isArray(profileData.ad_targeting_area) ? profileData.ad_targeting_area : [];
  const busyMonths = Array.isArray(profileData.busy_months) ? profileData.busy_months : [];

  // Build metadata for retrieval
  const metadata = {
    business_id: userId,
    business_name: profileData.business_name || '',
    business_type: profileData.business_type || '',
    primary_city: locs[0]?.city || '',
    all_locations: locs.map(l => l.neighborhood ? `${l.neighborhood}, ${l.city}` : l.city).join(' | '),
    operation_model: profileData.operation_model || '',
    service_area: serviceArea.join(', '),
    ad_targeting_area: adArea.join(', '),
    primary_language: profileData.primary_language || 'Albanian',
    audience: `${profileData.audience_age_min || 18}-${profileData.audience_age_max || 65} years, ${profileData.audience_gender || 'mixed'}, ${profileData.audience_description || ''}`,
    pain_point: profileData.pain_point || '',
    products: prods.map(p => `${p.name}: ${p.description || ''}${p.price ? ' (' + p.price + ')' : ''}`).join(' | '),
    bestseller: prods.find(p => p.is_bestseller)?.name || prods[0]?.name || '',
    current_offer: profileData.current_offer || 'none',
    primary_goal: profileData.primary_goal || '',
    monthly_budget: profileData.monthly_budget || '',
    tone: tones.join(', '),
    never_do: profileData.never_do || '',
    we_do_better: profileData.we_do_better || '',
    they_do_better: profileData.they_do_better || '',
    usp: profileData.usp || '',
    tagline: profileData.tagline || '',
    business_hours_summary: buildHoursSummary(profileData.business_hours),
    seasonal: profileData.seasonal || 'year_round',
    busy_months: busyMonths.join(', '),
    type: 'business_profile'
  };

  // Build rich text for embedding
  const textForEmbedding = [
    `Business: ${metadata.business_name} — ${metadata.business_type}`,
    `Location: ${metadata.all_locations}`,
    `Serves: ${metadata.service_area || metadata.all_locations}`,
    `Ad targeting: ${metadata.ad_targeting_area || metadata.all_locations}`,
    `Language: ${metadata.primary_language}`,
    `Audience: ${metadata.audience}`,
    `Customer problem: ${metadata.pain_point}`,
    `Products: ${metadata.products}`,
    `Best seller: ${metadata.bestseller}`,
    `Current offer: ${metadata.current_offer}`,
    `Goal: ${metadata.primary_goal}`,
    `Budget: ${metadata.monthly_budget}`,
    `Brand voice: ${metadata.tone}`,
    `Never do: ${metadata.never_do}`,
    `We are best at: ${metadata.we_do_better}`,
    `USP: ${metadata.usp}`,
    `Tagline: ${metadata.tagline}`,
    `Hours: ${metadata.business_hours_summary}`,
    `Season: ${metadata.seasonal}, busy months: ${metadata.busy_months}`,
  ].filter(line => !line.endsWith(': ')).join('\n');

  // Generate embedding
  const embedding = await getEmbedding(textForEmbedding);

  // Build master prompt for context vector
  const masterPrompt = buildMasterPrompt(profileData, 'general');

  const contextEmbedding = await getEmbedding(masterPrompt.slice(0, 8000));

  // Upsert both vectors
  await pineconeUpsert([
    {
      id: `profile_${userId}`,
      values: embedding,
      metadata: metadata
    },
    {
      id: `context_${userId}`,
      values: contextEmbedding,
      metadata: {
        business_id: userId,
        type: 'master_prompt',
        text: masterPrompt.slice(0, 30000), // Pinecone metadata limit
        business_name: metadata.business_name,
        primary_city: metadata.primary_city
      }
    }
  ]);

  return { success: true, metadata };
}

module.exports = { buildAndStorePineconeProfile };
