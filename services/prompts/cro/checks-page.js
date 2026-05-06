'use strict';

/**
 * services/prompts/cro/checks-page.js
 * ----------------------------------------------------------------------------
 * 35 deterministic CRO checks across 7 dimensions:
 *   - above_the_fold (C01-C05)
 *   - value_prop      (C06-C10)
 *   - primary_cta     (C11-C15)
 *   - social_proof    (C16-C20)
 *   - trust           (C21-C25)
 *   - friction        (C26-C30)
 *   - mobile          (C31-C35)
 *
 * Each check is pure: input → null or finding object.
 * ----------------------------------------------------------------------------
 */

const i18nCro = require('./i18n-cro');

// Helpers ---------------------------------------------------------------------

function firstHeading(html) {
  if (!html) return null;
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) return m[1].replace(/<[^>]+>/g, '').trim();
  return null;
}

function findCtas(html) {
  if (!html) return [];
  const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const links = [...html.matchAll(/<a[^>]*class=["'][^"']*(btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => m[2].replace(/<[^>]+>/g, '').trim());
  const inputs = [...html.matchAll(/<input[^>]*type=["']submit["'][^>]*value=["']([^"']+)["']/gi)].map(m => m[1]);
  return [...buttons, ...links, ...inputs].filter(Boolean);
}

function countFormFields(html) {
  if (!html) return 0;
  return (html.match(/<input(?![^>]*type=["'](?:hidden|submit|button)["'])/gi) || []).length
       + (html.match(/<textarea/gi) || []).length
       + (html.match(/<select/gi) || []).length;
}

function hasViewportMeta(html) {
  if (!html) return false;
  return /<meta[^>]+name=["']viewport["']/i.test(html);
}

function hasResponsiveCss(html) {
  if (!html) return false;
  return /@media\b/i.test(html) || /<link[^>]+stylesheet/.test(html); // present heuristic
}

function isFormHttps(html) {
  if (!html) return null;
  const m = html.match(/<form[^>]+action=["'](https?:[^"']+)["']/i);
  if (!m) return null;
  return m[1].startsWith('https://');
}

function wordCount(text) { return text ? (text.match(/\S+/g) || []).length : 0; }

// ─── Checks ─────────────────────────────────────────────────────────────────

const CHECKS = [
  // ── ABOVE THE FOLD (C01-C05) ────────────────────────────────────────────
  {
    id: 'C01',
    title: 'No H1 heading found',
    dimension: 'above_the_fold',
    severity: 'critical',
    priority: 10,
    detect: ({ html }) => {
      if (!html) return null;
      if (!firstHeading(html)) {
        return { fix: 'Page has no <h1> — visitors cannot identify what this page is about in 5 seconds.', evidence: { check: 'h1_present', value: false } };
      }
      return null;
    },
  },
  {
    id: 'C02',
    title: 'H1 too generic',
    dimension: 'above_the_fold',
    severity: 'warning',
    priority: 8,
    detect: ({ html }) => {
      const h1 = firstHeading(html);
      if (!h1) return null;
      const generic = /^(welcome|home|about|services|products|hello|hi)$/i.test(h1.trim());
      if (generic) {
        return { fix: `H1 "${h1}" is generic — replace with concrete value prop (e.g. "Get 30% more bookings every month").`, evidence: { check: 'h1_generic', value: h1 } };
      }
      return null;
    },
  },
  {
    id: 'C03',
    title: 'H1 too long for above-the-fold',
    dimension: 'above_the_fold',
    severity: 'info',
    priority: 5,
    detect: ({ html }) => {
      const h1 = firstHeading(html);
      if (!h1) return null;
      if (wordCount(h1) > 14) {
        return { fix: `H1 has ${wordCount(h1)} words — trim to ≤12 for fast comprehension.`, evidence: { check: 'h1_word_count', value: wordCount(h1) } };
      }
      return null;
    },
  },

  // ── VALUE PROP (C06-C10) ────────────────────────────────────────────────
  {
    id: 'C06',
    title: 'No specific outcome / number in hero',
    dimension: 'value_prop',
    severity: 'warning',
    priority: 8,
    detect: ({ html, text }) => {
      const heroText = (firstHeading(html) || '') + ' ' + (text || '').slice(0, 800);
      if (!/\d+/.test(heroText)) {
        return { fix: 'Hero has no specific number or outcome. "Increase X by 30%" beats "world-class X" every time.', evidence: { check: 'hero_numbers', value: false } };
      }
      return null;
    },
  },
  {
    id: 'C07',
    title: 'Buzzword density too high',
    dimension: 'value_prop',
    severity: 'info',
    priority: 5,
    detect: ({ text }) => {
      if (!text) return null;
      const buzz = (text.slice(0, 1500).match(/(world.?class|cutting.edge|innovative|leading|best.in.class|game.?changing|synerg|leverage)/gi) || []).length;
      if (buzz > 2) {
        return { fix: `${buzz} buzzwords in first 1500 chars — replace with specific facts.`, evidence: { check: 'buzzword_count', value: buzz } };
      }
      return null;
    },
  },

  // ── PRIMARY CTA (C11-C15) ───────────────────────────────────────────────
  {
    id: 'C11',
    title: 'No CTA button found',
    dimension: 'primary_cta',
    severity: 'critical',
    priority: 10,
    detect: ({ html }) => {
      if (!html) return null;
      if (findCtas(html).length === 0) {
        return { fix: 'No CTA button or submit input detected. Add ONE primary action above-the-fold.', evidence: { check: 'cta_count', value: 0 } };
      }
      return null;
    },
  },
  {
    id: 'C12',
    title: 'Generic CTA text',
    dimension: 'primary_cta',
    severity: 'warning',
    priority: 8,
    detect: ({ html, marketProfile }) => {
      const ctas = findCtas(html);
      if (ctas.length === 0) return null;
      const weak = ctas.filter(c => i18nCro.scoreCta(c, marketProfile) < 4);
      if (weak.length === ctas.length) {
        return { fix: `All ${ctas.length} CTAs use generic language ("${weak.slice(0,2).join('", "')}"). Use action verb in primary_language.`, evidence: { check: 'weak_ctas', value: weak.slice(0, 5) } };
      }
      return null;
    },
  },
  {
    id: 'C13',
    title: 'Too many primary CTAs (decision paralysis)',
    dimension: 'primary_cta',
    severity: 'warning',
    priority: 7,
    detect: ({ html }) => {
      const ctas = findCtas(html);
      if (ctas.length > 5) {
        return { fix: `${ctas.length} CTAs detected — pick ONE primary action; demote the rest.`, evidence: { check: 'cta_count', value: ctas.length } };
      }
      return null;
    },
  },

  // ── SOCIAL PROOF (C16-C20) ──────────────────────────────────────────────
  {
    id: 'C16',
    title: 'No testimonials / social proof',
    dimension: 'social_proof',
    severity: 'warning',
    priority: 8,
    detect: ({ html, text }) => {
      const t = (html || '') + (text || '');
      const has = /(testimonial|review|⭐|★|"\s*[A-Z])|(\d{2,}\s*(customers|clients|users|sold|served|happy))/i.test(t);
      if (!has) {
        return { fix: 'No testimonials, reviews, or "X customers" counts. Add 1-3 named testimonials with locations.', evidence: { check: 'social_proof_present', value: false } };
      }
      return null;
    },
  },
  {
    id: 'C17',
    title: 'Anonymous testimonials',
    dimension: 'social_proof',
    severity: 'info',
    priority: 5,
    detect: ({ text }) => {
      if (!text) return null;
      // Detect testimonial-like quotes followed by initials only or no name
      const m = text.match(/"[\s\S]{20,}"\s*[—-]\s*(\w\.?\s*\w?\.?)\s/g);
      if (m && m.length > 0) {
        return { fix: `${m.length} testimonial(s) attributed to initials only — full name + city builds 3x more trust.`, evidence: { check: 'anonymous_testimonials', value: m.length } };
      }
      return null;
    },
  },

  // ── TRUST (C21-C25) ──────────────────────────────────────────────────────
  {
    id: 'C21',
    title: 'Form submits to non-HTTPS endpoint',
    dimension: 'trust',
    severity: 'critical',
    priority: 10,
    detect: ({ html }) => {
      const isHttps = isFormHttps(html);
      if (isHttps === false) {
        return { fix: 'Form action is not HTTPS — visitors\' data exposed; browser shows insecure warning.', evidence: { check: 'form_https', value: false } };
      }
      return null;
    },
  },
  {
    id: 'C22',
    title: 'No real contact info on page',
    dimension: 'trust',
    severity: 'warning',
    priority: 7,
    detect: ({ text }) => {
      if (!text) return null;
      const hasPhone = /\+?\d[\d\s().-]{6,}/.test(text);
      const hasEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text);
      const hasAddress = /\b(street|str\.|st\.|road|rd\.|avenue|ave\.|rruga|piazza|via|calle|carrer)\b/i.test(text);
      if (!hasPhone && !hasEmail && !hasAddress) {
        return { fix: 'Page has no phone, email, or address visible — adds friction + reduces trust.', evidence: { check: 'contact_info', value: { phone: false, email: false, address: false } } };
      }
      return null;
    },
  },

  // ── FRICTION (C26-C30) ──────────────────────────────────────────────────
  {
    id: 'C26',
    title: 'Form has too many required fields',
    dimension: 'friction',
    severity: 'warning',
    priority: 8,
    detect: ({ html }) => {
      const total = countFormFields(html);
      if (!html || total === 0) return null;
      const required = (html.match(/required\b/gi) || []).length;
      if (total > 6 || required > 5) {
        return { fix: `Form has ${total} fields (${required} required) — every extra field drops conversion ~10%. Cut to 3-4.`, evidence: { check: 'form_fields', value: { total, required } } };
      }
      return null;
    },
  },
  {
    id: 'C27',
    title: 'Account creation required before action',
    dimension: 'friction',
    severity: 'warning',
    priority: 7,
    detect: ({ html, text }) => {
      const t = (html || '') + (text || '');
      const reqAccount = /create\s+account|sign\s+up|register/i.test(t);
      const hasGuest = /guest\s+(checkout|order)|no\s+account/i.test(t);
      if (reqAccount && !hasGuest) {
        return { fix: 'Account creation appears required — offer guest checkout to reduce abandonment.', evidence: { check: 'account_required', value: true } };
      }
      return null;
    },
  },

  // ── MOBILE (C31-C35) ────────────────────────────────────────────────────
  {
    id: 'C31',
    title: 'No viewport meta tag',
    dimension: 'mobile',
    severity: 'critical',
    priority: 9,
    detect: ({ html }) => {
      if (!html) return null;
      if (!hasViewportMeta(html)) {
        return { fix: 'No <meta name="viewport"> — page not mobile-friendly. 60%+ of SMB traffic is mobile.', evidence: { check: 'viewport_meta', value: false } };
      }
      return null;
    },
  },
  {
    id: 'C32',
    title: 'No responsive CSS detected',
    dimension: 'mobile',
    severity: 'warning',
    priority: 7,
    detect: ({ html }) => {
      if (!html) return null;
      if (!hasResponsiveCss(html)) {
        return { fix: 'No @media queries detected — verify mobile responsiveness.', evidence: { check: 'responsive_css', value: false } };
      }
      return null;
    },
  },
  {
    id: 'C33',
    title: 'Tap-target size unverified',
    dimension: 'mobile',
    severity: 'info',
    priority: 4,
    detect: ({ html }) => {
      if (!html) return null;
      const ctas = findCtas(html);
      if (ctas.length === 0) return null;
      // Heuristic: tiny inline buttons probably <44px
      const smallStyle = /<button[^>]+style=["'][^"']*font-size:\s*(?:8|9|10|11)px/i.test(html);
      if (smallStyle) {
        return { fix: 'Some buttons use <12px font — likely too small for mobile tap targets (44px minimum).', evidence: { check: 'small_button_font', value: true } };
      }
      return null;
    },
  },
];

const PRIORITY_FREE_SET = ['C01','C11','C16','C21','C26'];                                                                       // 5
const PRIORITY_GROWTH_SET = ['C01','C02','C03','C06','C07','C11','C12','C13','C16','C17','C21','C22','C26','C27','C31','C32'];   // 16

function runChecks({ html, text, business, marketProfile, plan = 'free' }) {
  const tier = String(plan || 'free').toLowerCase();
  const allowedIds =
      tier === 'agency' ? null
    : tier === 'growth' ? new Set(PRIORITY_GROWTH_SET)
    : new Set(PRIORITY_FREE_SET);

  const ctx = { html, text, business, marketProfile, plan };
  const findings = [];
  for (const check of CHECKS) {
    if (allowedIds && !allowedIds.has(check.id)) continue;
    try {
      const r = check.detect(ctx);
      if (r) {
        findings.push({
          check_id: check.id,
          title: check.title,
          dimension: check.dimension,
          severity: check.severity,
          priority: check.priority,
          fix: r.fix,
          evidence: r.evidence,
          time_to_fix_minutes: timeToFixFor(check),
        });
      }
    } catch { /* defensive */ }
  }
  const sevW = { critical: 3, warning: 2, info: 1 };
  findings.sort((a, b) => (sevW[b.severity] - sevW[a.severity]) || (b.priority - a.priority));
  return findings;
}

function timeToFixFor(check) {
  // Heuristic — most CRO fixes are 15-90 minutes
  if (check.dimension === 'above_the_fold') return 30;
  if (check.dimension === 'primary_cta')    return 15;
  if (check.dimension === 'social_proof')   return 60;
  if (check.dimension === 'trust')          return 20;
  if (check.dimension === 'friction')       return 30;
  if (check.dimension === 'mobile')         return 45;
  return 30;
}

module.exports = {
  CHECKS,
  PRIORITY_FREE_SET,
  PRIORITY_GROWTH_SET,
  runChecks,
  findCtas,
  countFormFields,
  firstHeading,
};
