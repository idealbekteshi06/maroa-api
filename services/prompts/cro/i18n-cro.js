'use strict';

/**
 * services/prompts/cro/i18n-cro.js
 * ----------------------------------------------------------------------------
 * CRO international layer.
 *
 *   - Per-language CTA conventions (action verb position, formality register)
 *   - Per-locale date/number/currency formatting
 *   - RTL flag for Arabic/Hebrew/Persian/Urdu
 *   - "Generic CTA" detection per language (Submit, Send, Continue → bad in
 *     every language)
 * ----------------------------------------------------------------------------
 */

const adI18n = require('../ad-optimizer/i18n-market');

// Action verbs per language — used to score whether a CTA reads as imperative
// vs passive. Imperatives convert better.
const CTA_IMPERATIVE_VERBS = {
  en: ['get','start','try','book','buy','order','claim','join','download','watch','learn','see','find','request','grab','reserve','schedule','contact','call'],
  es: ['comprar','obtener','probar','reservar','solicitar','empezar','descargar','ver','contactar','llamar','escribir','consultar'],
  fr: ['obtenir','commencer','essayer','réserver','demander','acheter','télécharger','voir','contacter','appeler','écrire'],
  de: ['holen','starten','testen','buchen','anfragen','kaufen','herunterladen','ansehen','kontaktieren','anrufen','schreiben'],
  it: ['ottenere','iniziare','provare','prenotare','richiedere','comprare','scaricare','vedere','contattare','chiamare','scrivere'],
  pt: ['obter','começar','experimentar','reservar','solicitar','comprar','baixar','ver','contatar','ligar','escrever','adquirir'],
  nl: ['krijg','begin','probeer','boek','vraag','koop','download','bekijk','contact','bel','schrijf'],
  sv: ['få','börja','testa','boka','begär','köp','ladda','se','kontakta','ring','skriv'],
  pl: ['uzyskaj','rozpocznij','spróbuj','zarezerwuj','poproś','kup','pobierz','zobacz','skontaktuj','zadzwoń','napisz'],
  tr: ['al','başla','dene','rezerve','iste','satın','indir','gör','iletişime','ara','yaz'],
  ar: ['احصل','ابدأ','جرب','احجز','اطلب','اشتر','حمّل','شاهد','تواصل','اتصل','اكتب'],
  he: ['קבל','התחל','נסה','הזמן','בקש','קנה','הורד','ראה','צור','התקשר','כתוב'],
  hi: ['प्राप्त','शुरू','आजमाएं','बुक','अनुरोध','खरीदें','डाउनलोड','देखें','संपर्क','कॉल','लिखें'],
  ja: ['始める','試す','予約','申し込む','購入','ダウンロード','見る','問い合わせ','電話','書く'],
  ko: ['시작','시도','예약','신청','구매','다운로드','보기','문의','전화','쓰기'],
  sq: ['merr','fillo','provo','rezervo','kërko','blej','shkarko','shih','kontakto','telefono','shkruaj'],
  sr: ['nabavi','počni','probaj','rezerviši','traži','kupi','preuzmi','pogledaj','kontaktiraj','pozovi','piši'],
  hr: ['nabavi','započni','probaj','rezerviraj','zatraži','kupi','preuzmi','pogledaj','kontaktiraj','nazovi','piši'],
  ru: ['получить','начать','попробовать','забронировать','запросить','купить','скачать','посмотреть','связаться','позвонить','написать'],
  uk: ['отримати','почати','спробувати','забронювати','запитати','купити','завантажити','побачити','звʼязатися','зателефонувати','написати'],
};

// Generic / weak CTA terms to flag in EVERY language
const WEAK_CTA_TERMS = {
  en: ['submit','send','click here','continue','next','ok','go','more','learn more','read more'],
  es: ['enviar','continuar','siguiente','aceptar','más','leer más'],
  fr: ['envoyer','continuer','suivant','plus','en savoir plus','lire plus'],
  de: ['absenden','weiter','nächster','mehr','mehr erfahren'],
  it: ['invia','continua','successivo','altro','scopri di più','leggi di più'],
  pt: ['enviar','continuar','próximo','mais','saiba mais','leia mais'],
  sq: ['dërgo','vazhdo','tjetra','më shumë','mëso më shumë'],
  ar: ['إرسال','متابعة','التالي','المزيد'],
};

const RTL_LANGS = new Set(['ar','he','fa','ur']);

/**
 * Build CRO market profile (extends ad-optimizer profile with CRO-specific
 * fields).
 */
function buildCroMarketProfile(business) {
  const base = adI18n.buildMarketProfile(business);
  const lang = base.primary_language || 'en';
  return {
    ...base,
    cta_imperative_verbs: CTA_IMPERATIVE_VERBS[lang] || CTA_IMPERATIVE_VERBS.en,
    weak_cta_terms: WEAK_CTA_TERMS[lang] || WEAK_CTA_TERMS.en,
    text_direction: RTL_LANGS.has(lang) ? 'rtl' : 'ltr',
  };
}

/**
 * Score a CTA string. Returns 0-10.
 * Imperative + specific + concise + action-verb in language → high score.
 */
function scoreCta(text, marketProfile) {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return 0;
  let score = 5; // baseline

  // Penalty: weak / generic
  for (const weak of (marketProfile?.weak_cta_terms || WEAK_CTA_TERMS.en)) {
    if (trimmed.includes(weak.toLowerCase())) score -= 4;
  }
  // Bonus: imperative verb in language (start = +3, contained = +2 — handles
  // German "Jetzt buchen" / Italian "Prenota ora" / Albanian "Rezervo tani" etc.)
  const verbs = marketProfile?.cta_imperative_verbs || CTA_IMPERATIVE_VERBS.en;
  let verbBonus = 0;
  for (const verb of verbs) {
    const v = verb.toLowerCase();
    if (trimmed.startsWith(v)) { verbBonus = Math.max(verbBonus, 3); break; }
    if (new RegExp(`\\b${v}`, 'i').test(trimmed)) { verbBonus = Math.max(verbBonus, 2); }
  }
  score += verbBonus;
  // Bonus: first-person ("Get my", "Book my")
  if (/\b(my|me|mine)\b/i.test(trimmed)) score += 1;
  // Penalty: too long
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (words > 5) score -= 1;
  if (words > 8) score -= 2;
  // Penalty: question mark (rarely converts)
  if (trimmed.endsWith('?')) score -= 1;

  return Math.max(0, Math.min(10, score));
}

module.exports = {
  CTA_IMPERATIVE_VERBS,
  WEAK_CTA_TERMS,
  RTL_LANGS,
  buildCroMarketProfile,
  scoreCta,
};
