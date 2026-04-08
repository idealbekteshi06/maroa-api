'use strict';

const COUNTRY_INTELLIGENCE = {
  XK: { name: 'Kosovo', languages: ['Albanian','Serbian'], default_language: 'Albanian', currency: 'EUR', symbol: '€', tz: 'Europe/Belgrade', platforms: { primary: ['facebook','instagram'], messaging: ['whatsapp','viber'] }, hours: [8,12,19,20], days: [2,3,4], traits: ['price_sensitive','community_focused','trust_relationships','mobile_first'], holidays: [{d:'02-17',n:'Kosovo Independence Day',o:'high'},{d:'03-08',n:"Women's Day",o:'high'},{d:'05-01',n:'Labour Day',o:'medium'},{d:'11-28',n:'Albanian Flag Day',o:'high'},{d:'12-25',n:'Christmas',o:'high'},{d:'01-01',n:'New Year',o:'high'}], culture: ['family_values','local_pride','religious_diversity'], regs: [] },
  AL: { name: 'Albania', languages: ['Albanian'], default_language: 'Albanian', currency: 'ALL', symbol: 'L', tz: 'Europe/Tirane', platforms: { primary: ['facebook','instagram'], messaging: ['whatsapp','viber'] }, hours: [8,12,19,21], days: [2,3,4,5], traits: ['price_sensitive','brand_conscious','social_proof'], holidays: [{d:'11-28',n:'Independence Day',o:'high'},{d:'11-29',n:'Liberation Day',o:'high'},{d:'01-01',n:'New Year',o:'high'}], culture: ['hospitality','family_values','local_pride'], regs: [] },
  US: { name: 'United States', languages: ['English'], default_language: 'English', currency: 'USD', symbol: '$', tz: 'America/New_York', platforms: { primary: ['instagram','tiktok','facebook'], messaging: ['sms','email'] }, hours: [9,12,17,19], days: [2,3,4], traits: ['convenience','review_driven','brand_loyal'], holidays: [{d:'02-14',n:"Valentine's Day",o:'high'},{d:'07-04',n:'Independence Day',o:'high'},{d:'11-28',n:'Black Friday',o:'critical'},{d:'12-25',n:'Christmas',o:'critical'},{d:'01-01',n:'New Year',o:'high'}], culture: ['direct_communication','diversity_inclusion'], regs: ['ftc_disclosure','can_spam'] },
  GB: { name: 'United Kingdom', languages: ['English'], default_language: 'English', currency: 'GBP', symbol: '£', tz: 'Europe/London', platforms: { primary: ['instagram','facebook','tiktok'], messaging: ['whatsapp','sms'] }, hours: [8,12,17,20], days: [2,3,4], traits: ['quality_over_price','subtle_marketing','humour'], holidays: [{d:'12-25',n:'Christmas',o:'critical'},{d:'11-28',n:'Black Friday',o:'critical'}], culture: ['subtle_selling','gdpr'], regs: ['gdpr','asa'] },
  AE: { name: 'UAE', languages: ['Arabic','English'], default_language: 'Arabic', currency: 'AED', symbol: 'AED', tz: 'Asia/Dubai', platforms: { primary: ['instagram','snapchat','tiktok'], messaging: ['whatsapp'] }, hours: [9,13,20,21], days: [0,1,2], traits: ['luxury','brand_conscious','visual_first'], holidays: [{d:'12-02',n:'UAE National Day',o:'critical'}], culture: ['no_alcohol','modest_imagery','ramadan_sensitivity','halal'], regs: ['nmc'] },
  DE: { name: 'Germany', languages: ['German'], default_language: 'German', currency: 'EUR', symbol: '€', tz: 'Europe/Berlin', platforms: { primary: ['instagram','facebook','youtube'], messaging: ['whatsapp','email'] }, hours: [7,12,17,19], days: [2,3,4], traits: ['quality','privacy_conscious','skeptical_of_hype'], holidays: [{d:'10-03',n:'Unity Day',o:'medium'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['no_exaggeration','gdpr','formal_default','factual_only'], regs: ['gdpr','uwg'] },
  TR: { name: 'Turkey', languages: ['Turkish'], default_language: 'Turkish', currency: 'TRY', symbol: '₺', tz: 'Europe/Istanbul', platforms: { primary: ['instagram','twitter','youtube'], messaging: ['whatsapp'] }, hours: [9,13,20,22], days: [2,3,4,5], traits: ['social_proof','influencer_trust','price_conscious'], holidays: [{d:'10-29',n:'Republic Day',o:'critical'},{d:'04-23',n:'Sovereignty Day',o:'high'}], culture: ['ramadan','turkish_pride','family','hospitality'], regs: [] },
  SA: { name: 'Saudi Arabia', languages: ['Arabic'], default_language: 'Arabic', currency: 'SAR', symbol: 'SAR', tz: 'Asia/Riyadh', platforms: { primary: ['snapchat','instagram','twitter'], messaging: ['whatsapp'] }, hours: [10,14,20,22], days: [0,1,2], traits: ['luxury','young_population','brand_loyal'], holidays: [{d:'09-23',n:'National Day',o:'critical'}], culture: ['no_alcohol','halal','arabic_first','ramadan_very_important'], regs: ['gcam'] },
  FR: { name: 'France', languages: ['French'], default_language: 'French', currency: 'EUR', symbol: '€', tz: 'Europe/Paris', platforms: { primary: ['instagram','facebook','tiktok'], messaging: ['whatsapp','sms'] }, hours: [8,12,18,20], days: [2,3,4], traits: ['quality','aesthetic','brand_heritage'], holidays: [{d:'07-14',n:'Bastille Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['gdpr','elegance','no_aggressive_selling'], regs: ['gdpr','arpp'] },
  IT: { name: 'Italy', languages: ['Italian'], default_language: 'Italian', currency: 'EUR', symbol: '€', tz: 'Europe/Rome', platforms: { primary: ['instagram','facebook','tiktok'], messaging: ['whatsapp'] }, hours: [8,13,18,21], days: [2,3,4], traits: ['design_conscious','food_culture','regional_pride'], holidays: [{d:'12-25',n:'Christmas',o:'critical'}], culture: ['gdpr','regional_identity','craftsmanship'], regs: ['gdpr'] },
  BR: { name: 'Brazil', languages: ['Portuguese'], default_language: 'Portuguese', currency: 'BRL', symbol: 'R$', tz: 'America/Sao_Paulo', platforms: { primary: ['instagram','whatsapp','tiktok'], messaging: ['whatsapp'] }, hours: [9,12,18,21], days: [2,3,4,5], traits: ['social','price_sensitive','emotional','visual'], holidays: [{d:'09-07',n:'Independence Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['warm_friendly','family','diversity'], regs: [] },
  IN: { name: 'India', languages: ['Hindi','English'], default_language: 'English', currency: 'INR', symbol: '₹', tz: 'Asia/Kolkata', platforms: { primary: ['instagram','youtube','whatsapp'], messaging: ['whatsapp'] }, hours: [8,12,18,21], days: [1,2,3,4,5], traits: ['value_for_money','festival_driven','family_decisions'], holidays: [{d:'08-15',n:'Independence Day',o:'high'},{d:'10-20',n:'Diwali',o:'critical'}], culture: ['religious_sensitivity','regional_diversity','family_values'], regs: ['asci'] },
  ES: { name: 'Spain', languages: ['Spanish'], default_language: 'Spanish', currency: 'EUR', symbol: '€', tz: 'Europe/Madrid', platforms: { primary: ['instagram','facebook','tiktok'], messaging: ['whatsapp'] }, hours: [9,14,19,21], days: [2,3,4], traits: ['social','family','lifestyle'], holidays: [{d:'10-12',n:'National Day',o:'medium'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['gdpr','regional_identity','siesta_timing'], regs: ['gdpr'] },
  NL: { name: 'Netherlands', languages: ['Dutch'], default_language: 'Dutch', currency: 'EUR', symbol: '€', tz: 'Europe/Amsterdam', platforms: { primary: ['instagram','facebook','linkedin'], messaging: ['whatsapp'] }, hours: [8,12,17,20], days: [2,3,4], traits: ['direct','practical','quality'], holidays: [{d:'04-27',n:"King's Day",o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['gdpr','direct_honest','sustainable'], regs: ['gdpr'] },
  PL: { name: 'Poland', languages: ['Polish'], default_language: 'Polish', currency: 'PLN', symbol: 'zł', tz: 'Europe/Warsaw', platforms: { primary: ['facebook','instagram','tiktok'], messaging: ['whatsapp','messenger'] }, hours: [8,12,18,20], days: [2,3,4], traits: ['price_sensitive','community','family'], holidays: [{d:'11-11',n:'Independence Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['gdpr','family_values','catholic_traditions'], regs: ['gdpr'] },
  RO: { name: 'Romania', languages: ['Romanian'], default_language: 'Romanian', currency: 'RON', symbol: 'lei', tz: 'Europe/Bucharest', platforms: { primary: ['facebook','instagram'], messaging: ['whatsapp'] }, hours: [8,12,18,20], days: [2,3,4], traits: ['price_sensitive','community','aspirational'], holidays: [{d:'12-01',n:'National Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['gdpr','hospitality','family'], regs: ['gdpr'] },
  GR: { name: 'Greece', languages: ['Greek'], default_language: 'Greek', currency: 'EUR', symbol: '€', tz: 'Europe/Athens', platforms: { primary: ['facebook','instagram'], messaging: ['whatsapp','viber'] }, hours: [9,13,19,21], days: [2,3,4], traits: ['social','community','tourism_aware'], holidays: [{d:'03-25',n:'Independence Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['gdpr','mediterranean_warmth','tourism'], regs: ['gdpr'] },
  CH: { name: 'Switzerland', languages: ['German','French','Italian'], default_language: 'German', currency: 'CHF', symbol: 'CHF', tz: 'Europe/Zurich', platforms: { primary: ['instagram','facebook','linkedin'], messaging: ['whatsapp'] }, hours: [7,12,17,19], days: [2,3,4], traits: ['quality','precision','privacy'], holidays: [{d:'08-01',n:'National Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['multilingual','quality_focus','privacy'], regs: ['gdpr_equivalent'] },
  MK: { name: 'North Macedonia', languages: ['Macedonian','Albanian'], default_language: 'Macedonian', currency: 'MKD', symbol: 'ден', tz: 'Europe/Skopje', platforms: { primary: ['facebook','instagram'], messaging: ['viber','whatsapp'] }, hours: [8,12,19,20], days: [2,3,4], traits: ['community','price_sensitive','family'], holidays: [{d:'09-08',n:'Independence Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['family_values','community','multicultural'], regs: [] },
  ME: { name: 'Montenegro', languages: ['Montenegrin','Serbian'], default_language: 'Montenegrin', currency: 'EUR', symbol: '€', tz: 'Europe/Podgorica', platforms: { primary: ['facebook','instagram'], messaging: ['viber','whatsapp'] }, hours: [8,12,19,20], days: [2,3,4], traits: ['tourism_aware','community','family'], holidays: [{d:'05-21',n:'Independence Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['hospitality','family','tourism'], regs: [] },
  RS: { name: 'Serbia', languages: ['Serbian'], default_language: 'Serbian', currency: 'RSD', symbol: 'дин', tz: 'Europe/Belgrade', platforms: { primary: ['facebook','instagram'], messaging: ['viber','whatsapp'] }, hours: [8,12,19,20], days: [2,3,4], traits: ['community','family','price_sensitive'], holidays: [{d:'02-15',n:'Statehood Day',o:'high'},{d:'12-25',n:'Christmas',o:'critical'}], culture: ['hospitality','family','community'], regs: [] },
};

const CITY_COUNTRY_MAP = {
  'prishtinë':'XK','prishtina':'XK','prizren':'XK','pejë':'XK','ferizaj':'XK','gjakovë':'XK','gjilan':'XK','mitrovicë':'XK','vushtrri':'XK','podujeva':'XK',
  'tiranë':'AL','tirana':'AL','durrës':'AL','vlorë':'AL','shkodër':'AL','elbasan':'AL','korçë':'AL','fier':'AL',
  'new york':'US','los angeles':'US','chicago':'US','houston':'US','miami':'US','san francisco':'US','seattle':'US','boston':'US','austin':'US','dallas':'US',
  'london':'GB','manchester':'GB','birmingham':'GB','glasgow':'GB','edinburgh':'GB','liverpool':'GB','bristol':'GB','leeds':'GB',
  'dubai':'AE','abu dhabi':'AE','sharjah':'AE',
  'berlin':'DE','munich':'DE','hamburg':'DE','frankfurt':'DE','cologne':'DE','düsseldorf':'DE','stuttgart':'DE',
  'istanbul':'TR','ankara':'TR','izmir':'TR','antalya':'TR','bursa':'TR',
  'riyadh':'SA','jeddah':'SA','dammam':'SA','mecca':'SA','medina':'SA',
  'paris':'FR','lyon':'FR','marseille':'FR','toulouse':'FR','nice':'FR',
  'rome':'IT','milan':'IT','naples':'IT','turin':'IT','florence':'IT',
  'são paulo':'BR','rio de janeiro':'BR','brasilia':'BR','salvador':'BR',
  'mumbai':'IN','delhi':'IN','bangalore':'IN','hyderabad':'IN','chennai':'IN','kolkata':'IN',
  'madrid':'ES','barcelona':'ES','valencia':'ES','seville':'ES',
  'amsterdam':'NL','rotterdam':'NL','utrecht':'NL','the hague':'NL',
  'warsaw':'PL','krakow':'PL','gdansk':'PL','wroclaw':'PL',
  'bucharest':'RO','cluj-napoca':'RO','timișoara':'RO',
  'athens':'GR','thessaloniki':'GR',
  'zurich':'CH','geneva':'CH','bern':'CH','basel':'CH',
  'skopje':'MK','bitola':'MK','ohrid':'MK',
  'podgorica':'ME','budva':'ME',
  'belgrade':'RS','novi sad':'RS','niš':'RS',
};

function detectCountry(profile) {
  if (profile?.country && COUNTRY_INTELLIGENCE[profile.country]) return profile.country;
  const city = (profile?.physical_locations?.[0]?.city || '').toLowerCase();
  return CITY_COUNTRY_MAP[city] || 'US';
}

function getCountryIntelligence(code) { return COUNTRY_INTELLIGENCE[code] || COUNTRY_INTELLIGENCE['US']; }

function getUpcomingHolidays(code, daysAhead = 14) {
  const c = getCountryIntelligence(code);
  const today = new Date();
  return c.holidays.map(h => {
    const [m, d] = h.d.split('-').map(Number);
    let target = new Date(today.getFullYear(), m - 1, d);
    if (target < today) target = new Date(today.getFullYear() + 1, m - 1, d);
    const daysUntil = Math.ceil((target - today) / 86400000);
    return daysUntil <= daysAhead ? { ...h, daysUntil, name: h.n, opportunity: h.o } : null;
  }).filter(Boolean).sort((a, b) => a.daysUntil - b.daysUntil);
}

function getOptimalTime(code, bizType, platform) {
  const c = getCountryIntelligence(code);
  const now = new Date();
  let hours = [...c.hours];
  const t = (bizType || '').toLowerCase();
  if (t.includes('restaurant') || t.includes('cafe')) hours = [11, 12, 17, 18, 19];
  if (t.includes('fitness') || t.includes('gym')) hours = [6, 7, 12, 17, 20];
  for (let off = 0; off <= 3; off++) {
    const d = new Date(now); d.setDate(d.getDate() + off);
    if (d.getDay() === 0 && !c.days.includes(0)) continue;
    for (const h of hours) {
      if (off === 0 && h <= now.getHours()) continue;
      d.setHours(h, 0, 0, 0); return d.toISOString();
    }
  }
  const tmrw = new Date(now); tmrw.setDate(tmrw.getDate() + 1); tmrw.setHours(9, 0, 0, 0);
  return tmrw.toISOString();
}

function buildInternationalContext(profile) {
  const code = detectCountry(profile);
  const c = getCountryIntelligence(code);
  const holidays = getUpcomingHolidays(code, 14);
  return `\n═══ MARKET: ${c.name.toUpperCase()} ═══
Currency: ${c.symbol} | Language: ${profile.primary_language || c.default_language}
Top platforms: ${c.platforms.primary.join(', ')} | Messaging: ${c.platforms.messaging.join(', ')}
Consumer traits: ${c.traits.map(t => t.replace(/_/g, ' ')).join(', ')}
Peak hours: ${c.hours.map(h => h + ':00').join(', ')}
Cultural rules: ${c.culture.map(r => r.replace(/_/g, ' ')).join(', ')}
${c.regs.length ? 'Ad regulations: ' + c.regs.join(', ') : ''}
${holidays.length ? 'Upcoming holidays: ' + holidays.map(h => `${h.name} in ${h.daysUntil}d`).join(', ') : 'No major holidays soon'}
All content must feel local and authentic for the ${c.name} market.\n`;
}

const LANG_INSTRUCTIONS = {
  Albanian: 'Write in Albanian (Shqip). Natural marketing language.',
  English: 'Write in fluent English.',
  Arabic: 'Write in Arabic (العربية). Culturally sensitive.',
  German: 'Write in German (Deutsch). Precise, factual, use "Sie".',
  French: 'Write in French (Français). Elegant, no aggressive selling.',
  Turkish: 'Write in Turkish (Türkçe). Warm, community tone.',
  Portuguese: 'Write in Brazilian Portuguese. Warm, emotional.',
  Italian: 'Write in Italian (Italiano). Aesthetic, passionate.',
  Serbian: 'Write in Serbian (Srpski). Respectful, community.',
  Hindi: 'Write in Hindi with English brand terms. Family-focused.',
  Spanish: 'Write in Spanish (Español).',
  Dutch: 'Write in Dutch (Nederlands). Direct, practical.',
  Polish: 'Write in Polish (Polski). Warm, professional.',
  Romanian: 'Write in Romanian (Română). Warm, aspirational.',
  Greek: 'Write in Greek (Ελληνικά). Warm Mediterranean.',
  Macedonian: 'Write in Macedonian (Македонски).',
  Montenegrin: 'Write in Montenegrin.'
};

function getLangInstruction(lang, code) {
  return LANG_INSTRUCTIONS[lang] || LANG_INSTRUCTIONS[getCountryIntelligence(code).default_language] || LANG_INSTRUCTIONS['English'];
}

module.exports = { COUNTRY_INTELLIGENCE, detectCountry, getCountryIntelligence, getUpcomingHolidays, getOptimalTime, buildInternationalContext, getLangInstruction, CITY_COUNTRY_MAP };
