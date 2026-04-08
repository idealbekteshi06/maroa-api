'use strict';

const KOSOVO_ALBANIA_CITIES = ['tiranë','tirana','durrës','shkodër','vlorë','elbasan','korçë','fier',
  'prishtinë','pristina','prizren','ferizaj','pejë','mitrovicë','gjakovë','gjilan','vushtrri','podujeva',
  'suharekë','malishevë','drenas','lipjan','kaçanik','shtërpce','deçan','istog','klinë','rahovec',
  'podgoricë','shkup','skopje','tetovë','gostivar','ohër','bitola','struga'];

function validateGeneratedContent(content, profile, taskType) {
  if (!content || typeof content !== 'string') return { valid: true, issues: [], quality_score: 50 };
  const issues = [];
  const contentLower = content.toLowerCase();

  // Rule 1: No unauthorized cities
  const adAreas = Array.isArray(profile?.ad_targeting_area) ? profile.ad_targeting_area.map(c => c.toLowerCase()) : [];
  const locs = Array.isArray(profile?.physical_locations) ? profile.physical_locations : [];
  const allowedCities = [...adAreas, ...locs.map(l => (l.city || '').toLowerCase()), ...locs.map(l => (l.neighborhood || '').toLowerCase())].filter(Boolean);
  if (allowedCities.length > 0) {
    for (const city of KOSOVO_ALBANIA_CITIES) {
      if (contentLower.includes(city) && !allowedCities.some(a => a.includes(city) || city.includes(a))) {
        issues.push(`Contains unauthorized city: ${city}`);
      }
    }
  }

  // Rule 2: Language check
  if (profile?.primary_language === 'Albanian') {
    const engWords = (content.match(/\b(the|and|but|is|are|was|were|have|has|this|that|with|from|your|our|their)\b/gi) || []).length;
    if (engWords > 8) issues.push('Content appears to be in English but Albanian is required');
  }

  // Rule 3: Placeholder text
  const placeholders = ['[business name]','[your business]','[insert','lorem ipsum','example.com','yourbusiness','[city]','[service]','[name]','[product]'];
  for (const ph of placeholders) {
    if (contentLower.includes(ph)) issues.push(`Contains placeholder: ${ph}`);
  }

  // Rule 4: Minimum length
  if (taskType === 'social_post' && content.length < 50) issues.push('Social post too short');
  if (taskType === 'email' && content.length < 100) issues.push('Email too short');

  // Quality score
  const quality_score = calculateQualityScore(content, profile, taskType);

  return { valid: issues.length === 0, issues, quality_score };
}

function calculateQualityScore(content, profile, taskType) {
  if (!content) return 0;
  let score = 60;
  const cl = content.toLowerCase();

  if (profile?.business_name && cl.includes(profile.business_name.toLowerCase())) score += 10;
  const city = (Array.isArray(profile?.physical_locations) ? profile.physical_locations : [])[0]?.city;
  if (city && cl.includes(city.toLowerCase())) score += 10;
  const ctaWords = ['kontakto','rezervo','vizito','thirr','regjistrohu','porosit','blej','call','book','visit','contact','order'];
  if (ctaWords.some(w => cl.includes(w))) score += 5;
  if (/\d+%|\d+\s*€|falas|free|zbritje|discount|ofertë/.test(cl)) score += 5;
  if (content.includes('#')) score += 3;
  if (content.includes('!') || content.includes('?')) score += 2;
  if (content.length > 200) score += 5;

  return Math.min(100, score);
}

module.exports = { validateGeneratedContent, calculateQualityScore };
