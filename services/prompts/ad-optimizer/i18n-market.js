'use strict';

/**
 * services/prompts/ad-optimizer/i18n-market.js
 * ----------------------------------------------------------------------------
 * International market layer — region detection, CPM/CPC benchmarks, currency
 * handling, language-aware copy QA, timezone defaults, holiday calendar.
 *
 * Detected from businesses.location + primary_language + service_area (already
 * collected at onboarding). All thresholds are SMB-calibrated, not enterprise.
 *
 * Sources for benchmarks (2026):
 *   - Meta Ads Manager average CPM/CPC by country (publicly reported)
 *   - WordStream 2026 industry benchmarks
 *   - Statista regional ad spend reports
 *
 * Numbers ARE NOT exact — they are tier-bands the auditor uses to decide
 * "is this campaign cheap/normal/expensive for this region?"
 * ----------------------------------------------------------------------------
 */

// --- Region tier definitions (CPM/CPC bands in USD-equivalent) ----------------
// Tiers map countries to spend-bracket expectations. The auditor uses these to
// decide whether a campaign's CPM/CPC is high, normal, or low for the market.

const REGION_TIERS = {
  ULTRA_HIGH: {
    countries: ['US', 'CA', 'AU', 'NZ', 'CH', 'NO', 'SG'],
    cpm_band_usd: [10, 25],   // $10-25 normal, >25 expensive, <10 cheap
    cpc_band_usd: [0.6, 1.8],
    healthy_ctr_pct: 0.9,     // anything >= this is fine
    frequency_concern: 2.5,   // >= this raises flag
    frequency_alarm: 3.5,     // >= this requires action
  },
  HIGH: {
    countries: ['UK', 'GB', 'IE', 'DE', 'NL', 'SE', 'DK', 'FI', 'AT', 'BE', 'LU', 'IS', 'JP', 'KR'],
    cpm_band_usd: [7, 18],
    cpc_band_usd: [0.4, 1.4],
    healthy_ctr_pct: 1.0,
    frequency_concern: 2.8,
    frequency_alarm: 4.0,
  },
  MID: {
    countries: ['FR', 'IT', 'ES', 'PT', 'CZ', 'PL', 'HU', 'GR', 'IL', 'AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'CL', 'UY', 'CR', 'PA'],
    cpm_band_usd: [4, 12],
    cpc_band_usd: [0.25, 1.0],
    healthy_ctr_pct: 1.1,
    frequency_concern: 3.0,
    frequency_alarm: 4.5,
  },
  LOW: {
    countries: ['BR', 'MX', 'AR', 'CO', 'PE', 'EC', 'TR', 'RO', 'BG', 'RS', 'HR', 'SK', 'SI', 'EE', 'LV', 'LT', 'ZA', 'EG', 'MA', 'TN', 'JO', 'LB'],
    cpm_band_usd: [2, 7],
    cpc_band_usd: [0.12, 0.55],
    healthy_ctr_pct: 1.3,
    frequency_concern: 3.5,
    frequency_alarm: 5.0,
  },
  ULTRA_LOW: {
    countries: ['AL', 'XK', 'MK', 'BA', 'ME', 'MD', 'UA', 'GE', 'AM', 'AZ', 'IN', 'PK', 'BD', 'LK', 'NP', 'PH', 'ID', 'VN', 'TH', 'KH', 'LA', 'MM', 'NG', 'KE', 'GH', 'UG', 'TZ', 'DZ'],
    cpm_band_usd: [0.5, 4],
    cpc_band_usd: [0.04, 0.30],
    healthy_ctr_pct: 1.5,
    frequency_concern: 4.0,
    frequency_alarm: 6.0,
  },
};

// --- Currency table (per ISO-4217) -------------------------------------------
// Static fallback rates against USD. Live FX should be injected by caller via
// `liveRates` arg if available. Used for converting daily_budget +
// recommendation values back to user's local currency.

const CURRENCY_TABLE = {
  USD: { symbol: '$',   to_usd: 1.0,        decimals: 2 },
  EUR: { symbol: '€',   to_usd: 1.07,       decimals: 2 },
  GBP: { symbol: '£',   to_usd: 1.27,       decimals: 2 },
  CAD: { symbol: 'C$',  to_usd: 0.74,       decimals: 2 },
  AUD: { symbol: 'A$',  to_usd: 0.66,       decimals: 2 },
  CHF: { symbol: 'CHF', to_usd: 1.13,       decimals: 2 },
  JPY: { symbol: '¥',   to_usd: 0.0067,     decimals: 0 },
  KRW: { symbol: '₩',   to_usd: 0.00073,    decimals: 0 },
  CNY: { symbol: '¥',   to_usd: 0.14,       decimals: 2 },
  INR: { symbol: '₹',   to_usd: 0.012,      decimals: 2 },
  IDR: { symbol: 'Rp',  to_usd: 0.000064,   decimals: 0 },
  PHP: { symbol: '₱',   to_usd: 0.018,      decimals: 2 },
  THB: { symbol: '฿',   to_usd: 0.029,      decimals: 2 },
  VND: { symbol: '₫',   to_usd: 0.000040,   decimals: 0 },
  MYR: { symbol: 'RM',  to_usd: 0.22,       decimals: 2 },
  SGD: { symbol: 'S$',  to_usd: 0.74,       decimals: 2 },
  HKD: { symbol: 'HK$', to_usd: 0.13,       decimals: 2 },
  TWD: { symbol: 'NT$', to_usd: 0.031,      decimals: 2 },
  BRL: { symbol: 'R$',  to_usd: 0.20,       decimals: 2 },
  MXN: { symbol: 'Mex$', to_usd: 0.058,     decimals: 2 },
  ARS: { symbol: '$',   to_usd: 0.0011,     decimals: 0 },
  CLP: { symbol: '$',   to_usd: 0.0010,     decimals: 0 },
  COP: { symbol: '$',   to_usd: 0.00025,    decimals: 0 },
  PEN: { symbol: 'S/',  to_usd: 0.27,       decimals: 2 },
  TRY: { symbol: '₺',   to_usd: 0.029,      decimals: 2 },
  RUB: { symbol: '₽',   to_usd: 0.011,      decimals: 2 },
  UAH: { symbol: '₴',   to_usd: 0.024,      decimals: 2 },
  PLN: { symbol: 'zł',  to_usd: 0.25,       decimals: 2 },
  CZK: { symbol: 'Kč',  to_usd: 0.043,      decimals: 2 },
  HUF: { symbol: 'Ft',  to_usd: 0.0027,     decimals: 0 },
  RON: { symbol: 'lei', to_usd: 0.22,       decimals: 2 },
  BGN: { symbol: 'лв',  to_usd: 0.55,       decimals: 2 },
  HRK: { symbol: 'kn',  to_usd: 0.14,       decimals: 2 },
  RSD: { symbol: 'дин', to_usd: 0.0091,     decimals: 0 },
  ALL: { symbol: 'L',   to_usd: 0.011,      decimals: 0 },
  MKD: { symbol: 'ден', to_usd: 0.017,      decimals: 0 },
  BAM: { symbol: 'KM',  to_usd: 0.55,       decimals: 2 },
  AED: { symbol: 'د.إ', to_usd: 0.27,       decimals: 2 },
  SAR: { symbol: '﷼',   to_usd: 0.27,       decimals: 2 },
  ILS: { symbol: '₪',   to_usd: 0.27,       decimals: 2 },
  EGP: { symbol: '£',   to_usd: 0.020,      decimals: 2 },
  ZAR: { symbol: 'R',   to_usd: 0.054,      decimals: 2 },
  NGN: { symbol: '₦',   to_usd: 0.00065,    decimals: 0 },
  KES: { symbol: 'Sh',  to_usd: 0.0078,     decimals: 0 },
  NOK: { symbol: 'kr',  to_usd: 0.094,      decimals: 2 },
  SEK: { symbol: 'kr',  to_usd: 0.095,      decimals: 2 },
  DKK: { symbol: 'kr',  to_usd: 0.143,      decimals: 2 },
  ISK: { symbol: 'kr',  to_usd: 0.0072,     decimals: 0 },
  NZD: { symbol: 'NZ$', to_usd: 0.61,       decimals: 2 },
};

// --- Country → primary currency + locale + timezone -------------------------
// One row per ISO country code we support. Defaults are best-known facts.

const COUNTRY_DEFAULTS = {
  US: { currency: 'USD', locale: 'en-US', tz: 'America/New_York', langs: ['en'] },
  CA: { currency: 'CAD', locale: 'en-CA', tz: 'America/Toronto',  langs: ['en','fr'] },
  GB: { currency: 'GBP', locale: 'en-GB', tz: 'Europe/London',    langs: ['en'] },
  UK: { currency: 'GBP', locale: 'en-GB', tz: 'Europe/London',    langs: ['en'] },
  IE: { currency: 'EUR', locale: 'en-IE', tz: 'Europe/Dublin',    langs: ['en'] },
  AU: { currency: 'AUD', locale: 'en-AU', tz: 'Australia/Sydney', langs: ['en'] },
  NZ: { currency: 'NZD', locale: 'en-NZ', tz: 'Pacific/Auckland', langs: ['en'] },
  DE: { currency: 'EUR', locale: 'de-DE', tz: 'Europe/Berlin',    langs: ['de'] },
  FR: { currency: 'EUR', locale: 'fr-FR', tz: 'Europe/Paris',     langs: ['fr'] },
  IT: { currency: 'EUR', locale: 'it-IT', tz: 'Europe/Rome',      langs: ['it'] },
  ES: { currency: 'EUR', locale: 'es-ES', tz: 'Europe/Madrid',    langs: ['es'] },
  PT: { currency: 'EUR', locale: 'pt-PT', tz: 'Europe/Lisbon',    langs: ['pt'] },
  NL: { currency: 'EUR', locale: 'nl-NL', tz: 'Europe/Amsterdam', langs: ['nl'] },
  BE: { currency: 'EUR', locale: 'nl-BE', tz: 'Europe/Brussels',  langs: ['nl','fr'] },
  AT: { currency: 'EUR', locale: 'de-AT', tz: 'Europe/Vienna',    langs: ['de'] },
  CH: { currency: 'CHF', locale: 'de-CH', tz: 'Europe/Zurich',    langs: ['de','fr','it'] },
  SE: { currency: 'SEK', locale: 'sv-SE', tz: 'Europe/Stockholm', langs: ['sv'] },
  NO: { currency: 'NOK', locale: 'nb-NO', tz: 'Europe/Oslo',      langs: ['nb'] },
  DK: { currency: 'DKK', locale: 'da-DK', tz: 'Europe/Copenhagen',langs: ['da'] },
  FI: { currency: 'EUR', locale: 'fi-FI', tz: 'Europe/Helsinki',  langs: ['fi'] },
  PL: { currency: 'PLN', locale: 'pl-PL', tz: 'Europe/Warsaw',    langs: ['pl'] },
  CZ: { currency: 'CZK', locale: 'cs-CZ', tz: 'Europe/Prague',    langs: ['cs'] },
  HU: { currency: 'HUF', locale: 'hu-HU', tz: 'Europe/Budapest',  langs: ['hu'] },
  RO: { currency: 'RON', locale: 'ro-RO', tz: 'Europe/Bucharest', langs: ['ro'] },
  BG: { currency: 'BGN', locale: 'bg-BG', tz: 'Europe/Sofia',     langs: ['bg'] },
  GR: { currency: 'EUR', locale: 'el-GR', tz: 'Europe/Athens',    langs: ['el'] },
  TR: { currency: 'TRY', locale: 'tr-TR', tz: 'Europe/Istanbul',  langs: ['tr'] },
  HR: { currency: 'EUR', locale: 'hr-HR', tz: 'Europe/Zagreb',    langs: ['hr'] },
  RS: { currency: 'RSD', locale: 'sr-RS', tz: 'Europe/Belgrade',  langs: ['sr'] },
  AL: { currency: 'ALL', locale: 'sq-AL', tz: 'Europe/Tirane',    langs: ['sq'] },
  XK: { currency: 'EUR', locale: 'sq-XK', tz: 'Europe/Belgrade',  langs: ['sq','sr'] },
  MK: { currency: 'MKD', locale: 'mk-MK', tz: 'Europe/Skopje',    langs: ['mk','sq'] },
  BA: { currency: 'BAM', locale: 'bs-BA', tz: 'Europe/Sarajevo',  langs: ['bs','hr','sr'] },
  ME: { currency: 'EUR', locale: 'sr-ME', tz: 'Europe/Podgorica', langs: ['sr'] },
  UA: { currency: 'UAH', locale: 'uk-UA', tz: 'Europe/Kyiv',      langs: ['uk'] },
  BR: { currency: 'BRL', locale: 'pt-BR', tz: 'America/Sao_Paulo',langs: ['pt'] },
  MX: { currency: 'MXN', locale: 'es-MX', tz: 'America/Mexico_City', langs: ['es'] },
  AR: { currency: 'ARS', locale: 'es-AR', tz: 'America/Argentina/Buenos_Aires', langs: ['es'] },
  CL: { currency: 'CLP', locale: 'es-CL', tz: 'America/Santiago', langs: ['es'] },
  CO: { currency: 'COP', locale: 'es-CO', tz: 'America/Bogota',   langs: ['es'] },
  PE: { currency: 'PEN', locale: 'es-PE', tz: 'America/Lima',     langs: ['es'] },
  AE: { currency: 'AED', locale: 'ar-AE', tz: 'Asia/Dubai',       langs: ['ar','en'] },
  SA: { currency: 'SAR', locale: 'ar-SA', tz: 'Asia/Riyadh',      langs: ['ar'] },
  IL: { currency: 'ILS', locale: 'he-IL', tz: 'Asia/Jerusalem',   langs: ['he','en'] },
  EG: { currency: 'EGP', locale: 'ar-EG', tz: 'Africa/Cairo',     langs: ['ar'] },
  ZA: { currency: 'ZAR', locale: 'en-ZA', tz: 'Africa/Johannesburg', langs: ['en','af'] },
  NG: { currency: 'NGN', locale: 'en-NG', tz: 'Africa/Lagos',     langs: ['en'] },
  KE: { currency: 'KES', locale: 'en-KE', tz: 'Africa/Nairobi',   langs: ['en','sw'] },
  IN: { currency: 'INR', locale: 'en-IN', tz: 'Asia/Kolkata',     langs: ['en','hi'] },
  PH: { currency: 'PHP', locale: 'en-PH', tz: 'Asia/Manila',      langs: ['en','tl'] },
  ID: { currency: 'IDR', locale: 'id-ID', tz: 'Asia/Jakarta',     langs: ['id'] },
  VN: { currency: 'VND', locale: 'vi-VN', tz: 'Asia/Ho_Chi_Minh', langs: ['vi'] },
  TH: { currency: 'THB', locale: 'th-TH', tz: 'Asia/Bangkok',     langs: ['th'] },
  MY: { currency: 'MYR', locale: 'ms-MY', tz: 'Asia/Kuala_Lumpur',langs: ['ms','en'] },
  SG: { currency: 'SGD', locale: 'en-SG', tz: 'Asia/Singapore',   langs: ['en','zh'] },
  JP: { currency: 'JPY', locale: 'ja-JP', tz: 'Asia/Tokyo',       langs: ['ja'] },
  KR: { currency: 'KRW', locale: 'ko-KR', tz: 'Asia/Seoul',       langs: ['ko'] },
};

// --- RTL languages -----------------------------------------------------------
const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);

// --- Holiday calendars (key dates per region for seasonal awareness) ---------
// Format: ISO month-day. Year-bound holidays (Easter, Eid, Lunar NY) use a
// year-keyed sub-table; for v1 we only encode fixed-date holidays. Caller can
// extend at runtime via setHolidayCalendar().
const HOLIDAYS_FIXED = {
  US: ['01-01','07-04','11-11','12-25','12-31'],
  CA: ['01-01','07-01','12-25','12-26'],
  GB: ['01-01','12-25','12-26'],
  UK: ['01-01','12-25','12-26'],
  AU: ['01-01','01-26','12-25','12-26'],
  DE: ['01-01','05-01','10-03','12-25','12-26'],
  FR: ['01-01','05-01','05-08','07-14','11-11','12-25'],
  IT: ['01-01','04-25','05-01','06-02','12-25','12-26'],
  ES: ['01-01','01-06','05-01','08-15','10-12','11-01','12-06','12-08','12-25'],
  PT: ['01-01','04-25','05-01','06-10','12-25'],
  NL: ['01-01','04-27','05-05','12-25','12-26'],
  PL: ['01-01','01-06','05-01','05-03','08-15','11-01','11-11','12-25','12-26'],
  CZ: ['01-01','05-01','05-08','07-05','07-06','09-28','10-28','11-17','12-24','12-25','12-26'],
  HU: ['01-01','03-15','05-01','08-20','10-23','11-01','12-25','12-26'],
  TR: ['01-01','04-23','05-01','05-19','07-15','08-30','10-29'],
  RS: ['01-01','01-02','01-07','02-15','02-16','05-01','05-02','11-11'],
  HR: ['01-01','01-06','05-01','06-22','06-25','08-05','08-15','10-08','11-01','12-25','12-26'],
  AL: ['01-01','01-02','03-14','03-22','05-01','10-19','11-22','11-28','11-29','12-08','12-25'],
  XK: ['01-01','02-17','04-09','05-01','05-09','06-15'],
  MK: ['01-01','01-07','04-24','05-01','05-24','08-02','09-08','10-11','10-23','12-08'],
  BA: ['01-01','01-02','03-01','05-01','05-02','11-25'],
  BR: ['01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'],
  MX: ['01-01','02-05','03-21','05-01','09-16','11-20','12-25'],
  AR: ['01-01','03-24','04-02','05-01','05-25','06-20','07-09','12-08','12-25'],
  AE: ['01-01','12-02','12-03'],
  SA: ['09-23'],
  IL: [], // primarily Jewish-calendar — handled separately
  EG: ['01-07','01-25','04-25','05-01','06-30','07-23','10-06'],
  IN: ['01-26','08-15','10-02','12-25'],
  PH: ['01-01','04-09','05-01','06-12','08-21','11-30','12-25','12-30','12-31'],
  ID: ['01-01','08-17','12-25'],
  VN: ['01-01','04-30','05-01','09-02'],
  TH: ['01-01','04-06','04-13','04-14','04-15','05-01','08-12','12-05','12-10','12-31'],
  ZA: ['01-01','03-21','04-27','05-01','06-16','08-09','09-24','12-16','12-25','12-26'],
  NG: ['01-01','05-01','05-29','10-01','12-25','12-26'],
  KE: ['01-01','05-01','06-01','10-20','12-12','12-25','12-26'],
  JP: ['01-01','02-11','02-23','04-29','05-03','05-04','05-05','11-03','11-23','12-23'],
  KR: ['01-01','03-01','05-05','06-06','08-15','10-03','10-09','12-25'],
  SG: ['01-01','05-01','08-09','12-25'],
  MY: ['01-01','05-01','08-31','09-16','12-25'],
};

// --- Public functions --------------------------------------------------------

/**
 * Detect business country from arbitrary location string OR onboarding fields.
 * Returns ISO 3166-1 alpha-2 country code or null if undetectable.
 */
function detectCountry(business) {
  if (!business) return null;
  const explicit = business.country_code || business.country;
  if (explicit && typeof explicit === 'string' && explicit.length === 2) {
    return explicit.toUpperCase();
  }
  const loc = String(business.location || '').toLowerCase();
  if (!loc) return null;
  // Map well-known city/country names → ISO codes (most common SMB markets)
  const tokens = [
    ['albania','AL'],['tirana','AL'],['shkoder','AL'],['vlore','AL'],['durres','AL'],
    ['kosovo','XK'],['pristina','XK'],['prishtina','XK'],['kosova','XK'],
    ['macedonia','MK'],['skopje','MK'],['north macedonia','MK'],
    ['serbia','RS'],['belgrade','RS'],['novi sad','RS'],
    ['croatia','HR'],['zagreb','HR'],['split','HR'],
    ['montenegro','ME'],['podgorica','ME'],
    ['bosnia','BA'],['sarajevo','BA'],
    ['greece','GR'],['athens','GR'],['thessaloniki','GR'],
    ['italy','IT'],['rome','IT'],['milan','IT'],['naples','IT'],
    ['germany','DE'],['berlin','DE'],['munich','DE'],['hamburg','DE'],
    ['france','FR'],['paris','FR'],['lyon','FR'],['marseille','FR'],
    ['spain','ES'],['madrid','ES'],['barcelona','ES'],['valencia','ES'],
    ['portugal','PT'],['lisbon','PT'],['porto','PT'],
    ['netherlands','NL'],['amsterdam','NL'],['rotterdam','NL'],
    ['belgium','BE'],['brussels','BE'],
    ['switzerland','CH'],['zurich','CH'],['geneva','CH'],
    ['austria','AT'],['vienna','AT'],
    ['sweden','SE'],['stockholm','SE'],
    ['norway','NO'],['oslo','NO'],
    ['denmark','DK'],['copenhagen','DK'],
    ['finland','FI'],['helsinki','FI'],
    ['poland','PL'],['warsaw','PL'],['krakow','PL'],
    ['czech','CZ'],['prague','CZ'],
    ['hungary','HU'],['budapest','HU'],
    ['romania','RO'],['bucharest','RO'],
    ['bulgaria','BG'],['sofia','BG'],
    ['turkey','TR'],['istanbul','TR'],['ankara','TR'],['izmir','TR'],
    ['ukraine','UA'],['kyiv','UA'],['kiev','UA'],['lviv','UA'],
    ['united states','US'],['usa','US'],['new york','US'],['los angeles','US'],['chicago','US'],['miami','US'],['houston','US'],['phoenix','US'],['dallas','US'],
    ['canada','CA'],['toronto','CA'],['vancouver','CA'],['montreal','CA'],
    ['united kingdom','GB'],['uk','GB'],['england','GB'],['london','GB'],['manchester','GB'],['birmingham','GB'],['scotland','GB'],['glasgow','GB'],['edinburgh','GB'],
    ['ireland','IE'],['dublin','IE'],
    ['australia','AU'],['sydney','AU'],['melbourne','AU'],['brisbane','AU'],['perth','AU'],
    ['new zealand','NZ'],['auckland','NZ'],['wellington','NZ'],
    ['brazil','BR'],['sao paulo','BR'],['rio','BR'],['rio de janeiro','BR'],['brasilia','BR'],
    ['mexico','MX'],['mexico city','MX'],['guadalajara','MX'],['monterrey','MX'],
    ['argentina','AR'],['buenos aires','AR'],
    ['colombia','CO'],['bogota','CO'],['medellin','CO'],
    ['chile','CL'],['santiago','CL'],
    ['peru','PE'],['lima','PE'],
    ['emirates','AE'],['uae','AE'],['dubai','AE'],['abu dhabi','AE'],
    ['saudi','SA'],['riyadh','SA'],['jeddah','SA'],
    ['israel','IL'],['tel aviv','IL'],['jerusalem','IL'],
    ['egypt','EG'],['cairo','EG'],['alexandria','EG'],
    ['south africa','ZA'],['johannesburg','ZA'],['cape town','ZA'],
    ['nigeria','NG'],['lagos','NG'],['abuja','NG'],
    ['kenya','KE'],['nairobi','KE'],
    ['india','IN'],['mumbai','IN'],['delhi','IN'],['bangalore','IN'],['bengaluru','IN'],
    ['philippines','PH'],['manila','PH'],['cebu','PH'],
    ['indonesia','ID'],['jakarta','ID'],['surabaya','ID'],
    ['vietnam','VN'],['hanoi','VN'],['ho chi minh','VN'],['saigon','VN'],
    ['thailand','TH'],['bangkok','TH'],
    ['malaysia','MY'],['kuala lumpur','MY'],
    ['singapore','SG'],
    ['japan','JP'],['tokyo','JP'],['osaka','JP'],
    ['korea','KR'],['seoul','KR'],
  ];
  for (const [needle, code] of tokens) {
    if (loc.includes(needle)) return code;
  }
  return null;
}

/**
 * Get the region tier definition for a country code.
 * Returns the MID tier as fallback (safest assumption for unknown markets).
 */
function tierForCountry(countryCode) {
  if (!countryCode) return REGION_TIERS.MID;
  const c = countryCode.toUpperCase();
  for (const tier of Object.values(REGION_TIERS)) {
    if (tier.countries.includes(c)) return tier;
  }
  return REGION_TIERS.MID;
}

/**
 * Build the full market profile a campaign auditor needs.
 * Single entry point — call this once at audit start.
 */
function buildMarketProfile(business, opts = {}) {
  const country = detectCountry(business);
  const tier    = tierForCountry(country);
  const defaults = country ? COUNTRY_DEFAULTS[country] : null;
  const currency = (business?.currency || defaults?.currency || 'USD').toUpperCase();
  const locale   = business?.locale   || defaults?.locale  || 'en-US';
  const timezone = business?.timezone || defaults?.tz      || 'UTC';
  const primaryLang = String(business?.primary_language || defaults?.langs?.[0] || 'en').toLowerCase().slice(0,2);

  const fxRates = opts.liveRates || {};
  const fx = CURRENCY_TABLE[currency] || CURRENCY_TABLE.USD;

  return {
    country,
    tier_name: country
      ? Object.entries(REGION_TIERS).find(([_, t]) => t.countries.includes(country))?.[0] || 'MID'
      : 'MID',
    cpm_band_usd: tier.cpm_band_usd,
    cpc_band_usd: tier.cpc_band_usd,
    healthy_ctr_pct: tier.healthy_ctr_pct,
    frequency_concern: tier.frequency_concern,
    frequency_alarm: tier.frequency_alarm,
    currency,
    currency_symbol: fx.symbol,
    currency_to_usd: fxRates[currency] || fx.to_usd,
    currency_decimals: fx.decimals,
    locale,
    timezone,
    primary_language: primaryLang,
    is_rtl: RTL_LANGS.has(primaryLang),
    holidays_fixed: country ? (HOLIDAYS_FIXED[country] || []) : [],
  };
}

/**
 * Convert a number from one currency to another using profile rates.
 */
function convertCurrency(amount, fromCurrency, toCurrency, liveRates) {
  if (!Number.isFinite(amount)) return null;
  const f = (liveRates?.[fromCurrency]) ?? CURRENCY_TABLE[fromCurrency]?.to_usd ?? 1;
  const t = (liveRates?.[toCurrency])   ?? CURRENCY_TABLE[toCurrency]?.to_usd   ?? 1;
  if (!t) return null;
  return (amount * f) / t;
}

/**
 * Format a number using the business's currency + locale.
 */
function formatMoney(amount, currency, locale) {
  if (!Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat(locale || 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: CURRENCY_TABLE[currency]?.decimals ?? 2,
    }).format(amount);
  } catch {
    const sym = CURRENCY_TABLE[currency]?.symbol || currency + ' ';
    return `${sym}${amount.toFixed(CURRENCY_TABLE[currency]?.decimals ?? 2)}`;
  }
}

/**
 * Convert a daily-spend number to its USD-equivalent (used by checks).
 */
function toUsd(amount, currency, liveRates) {
  return convertCurrency(amount, currency, 'USD', liveRates);
}

/**
 * Detect language of a piece of ad copy. Cheap heuristic — used only for
 * routing into language-aware QA, not for any user-facing text.
 */
function detectLanguage(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase();
  // Very rough — sufficient for QA routing.
  if (/[؀-ۿ]/.test(text)) return 'ar';
  if (/[֐-׿]/.test(text)) return 'he';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[぀-ゟ゠-ヿ]/.test(text)) return 'ja';
  if (/[가-힯]/.test(text)) return 'ko';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';
  if (/\b(dhe|për|është|nuk|jeni|tashmë)\b/.test(t)) return 'sq';
  if (/\b(che|della|sono|gli|degli)\b/.test(t)) return 'it';
  if (/\b(que|para|esto|todos|nuestro)\b/.test(t)) return 'es';
  if (/\b(que|pour|nous|tout|notre)\b/.test(t)) return 'fr';
  if (/\b(und|der|die|das|nicht|sein)\b/.test(t)) return 'de';
  if (/\b(de|do|para|com|você)\b/.test(t)) return 'pt';
  if (/\b(en|de|het|niet|maar)\b/.test(t)) return 'nl';
  if (/\b(och|att|som|för|inte)\b/.test(t)) return 'sv';
  return 'en';
}

module.exports = {
  REGION_TIERS,
  CURRENCY_TABLE,
  COUNTRY_DEFAULTS,
  HOLIDAYS_FIXED,
  RTL_LANGS,
  detectCountry,
  tierForCountry,
  buildMarketProfile,
  convertCurrency,
  formatMoney,
  toUsd,
  detectLanguage,
};
