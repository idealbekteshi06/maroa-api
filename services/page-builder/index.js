'use strict';

/**
 * services/page-builder/index.js
 * ---------------------------------------------------------------------------
 * Landing Page Generator. Builds deployable landing pages from product info
 * + Soul ID hero image + brand voice anchor + 7 CRO dimensions baked in.
 *
 * Page anatomy (the 7-section spec calibrated for SMB conversion):
 *   1. Hero  — headline (≤8 words), subhead (≤16 words), Soul ID image, CTA
 *   2. Value-prop trio — 3 short benefit cards
 *   3. Social proof — review snippets pulled from VOC
 *   4. Object-handling — 3 most-likely objections + answers
 *   5. Trust strip — credentials, badges, guarantees
 *   6. Final CTA — single CTA, no nav distraction
 *   7. Mobile-optimized layout (60% of SMB traffic is mobile)
 *
 * Public API:
 *   buildPageSpec({ business, brandVoice, vocSnapshot, soulImageUrl, pageType })
 *     → JSON page spec (passes to renderHtml or persists to landing_pages)
 *
 *   renderHtml(spec) → string of static HTML
 *
 *   auditPageSpec(spec) → { score, findings } — runs the 7-dim CRO check
 *                                                 from services/cro
 * ---------------------------------------------------------------------------
 */

const HEADLINE_MAX_WORDS = 8;
const SUBHEAD_MAX_WORDS = 16;
const VALUE_PROP_COUNT = 3;
const OBJECTION_COUNT = 3;

// ─── buildPageSpec — assembles the structured spec from inputs ──────────

function buildPageSpec({ business, brandVoice, vocSnapshot, soulImageUrl, pageType = 'homepage' }) {
  if (!business) {
    return { ok: false, reason: 'business required' };
  }

  // Generate hero from brand voice + business
  const headline = pickHeadline({ business, brandVoice, pageType });
  const subhead = pickSubhead({ business, brandVoice, pageType });
  const cta = pickCta({ business, brandVoice });

  // Value prop trio — pull from brand_voice_anchor.value_propositions
  const valueProps = pickValueProps({ business, brandVoice, count: VALUE_PROP_COUNT });

  // Social proof — pull verbatim from VOC (NEVER invent quotes)
  const socialProof = pickSocialProof({ vocSnapshot, count: 3 });

  // Objection handling — pull from VOC if available, else industry defaults
  const objections = pickObjections({ business, vocSnapshot, count: OBJECTION_COUNT });

  // Trust strip
  const trust = pickTrustStrip({ business });

  return {
    ok: true,
    page_type: pageType,
    sections: [
      {
        type: 'hero',
        headline,
        subhead,
        image_url: soulImageUrl || null,
        cta: { label: cta, url: business.website || '#cta' },
      },
      { type: 'value_props', items: valueProps },
      { type: 'social_proof', quotes: socialProof },
      { type: 'objections', items: objections },
      { type: 'trust_strip', items: trust },
      { type: 'final_cta', label: cta, url: business.website || '#cta' },
    ],
    meta: {
      title: `${business.business_name || 'Welcome'} — ${headline}`.slice(0, 65),
      description: subhead,
      og_image: soulImageUrl || null,
    },
  };
}

// Helper: pick first non-empty value
function firstOf(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function clampWords(s, max) {
  if (!s) return s;
  const words = String(s).trim().split(/\s+/);
  if (words.length <= max) return s;
  return words.slice(0, max).join(' ');
}

function pickHeadline({ business, brandVoice, pageType }) {
  const candidates = [
    brandVoice?.taglines?.[0],
    brandVoice?.value_propositions?.[0]?.headline,
    business?.tagline,
    business?.headline,
    `${business?.business_name || 'Welcome'} — ${pageType === 'lead_capture' ? 'Get a quote' : 'See what we do'}`,
  ];
  const raw = firstOf(...candidates);
  return clampWords(raw, HEADLINE_MAX_WORDS);
}

function pickSubhead({ business, brandVoice }) {
  const candidates = [
    brandVoice?.audience_summary,
    business?.value_proposition,
    business?.description,
    business?.target_audience ? `For ${business.target_audience}.` : null,
  ];
  const raw = firstOf(...candidates);
  return clampWords(raw, SUBHEAD_MAX_WORDS);
}

function pickCta({ business, brandVoice }) {
  return firstOf(
    brandVoice?.preferred_cta,
    business?.cta_label,
    business?.industry?.includes('saas')
      ? 'Start free'
      : business?.industry?.includes('e-commerce')
        ? 'Shop now'
        : business?.industry?.includes('lead')
          ? 'Get a quote'
          : 'Get started'
  );
}

function pickValueProps({ business, brandVoice, count }) {
  const fromVoice = Array.isArray(brandVoice?.value_propositions)
    ? brandVoice.value_propositions.slice(0, count).map((vp) => ({
        title: vp.title || vp.headline || 'Benefit',
        body: vp.description || vp.body || '',
      }))
    : [];
  if (fromVoice.length >= count) return fromVoice;

  // Fallbacks (industry-aware light defaults)
  const industry = String(business?.industry || '').toLowerCase();
  const defaults = /e-?commerce|shop|retail/.test(industry)
    ? [
        { title: 'Free shipping', body: 'On orders that qualify.' },
        { title: 'Easy returns', body: 'No-questions-asked policy.' },
        { title: 'Secure checkout', body: 'Encrypted payments.' },
      ]
    : /saas|software|tech/.test(industry)
      ? [
          { title: 'Setup in minutes', body: 'No engineer required.' },
          { title: 'Cancel anytime', body: 'No long-term contract.' },
          { title: 'Real support', body: 'Humans, not bots.' },
        ]
      : /local|service/.test(industry)
        ? [
            { title: 'Local team', body: 'Right here in your area.' },
            { title: 'Licensed + insured', body: 'Fully credentialed.' },
            { title: 'Free estimate', body: 'No-pressure consultation.' },
          ]
        : [
            { title: 'Honest work', body: 'No surprises, no upsells.' },
            { title: 'Fast response', body: 'Hear back same day.' },
            { title: 'Real results', body: 'Outcomes you can measure.' },
          ];
  return [...fromVoice, ...defaults].slice(0, count);
}

function pickSocialProof({ vocSnapshot, count }) {
  // VOC verbatim quotes — NEVER invent. If we don't have ≥1 real quote, omit
  // the section.
  const quotes = Array.isArray(vocSnapshot?.verbatim_quotes)
    ? vocSnapshot.verbatim_quotes.slice(0, count).map((q) => ({
        text: q.text,
        source: q.source || 'review',
        author: q.author || null,
      }))
    : [];
  return quotes;
}

function pickObjections({ business, vocSnapshot, count }) {
  const fromVoc = Array.isArray(vocSnapshot?.top_objections)
    ? vocSnapshot.top_objections.slice(0, count).map((o) => ({
        question: o.objection || o.question || 'How does this work?',
        answer: o.rebuttal || o.answer || '',
      }))
    : [];
  if (fromVoc.length >= count) return fromVoc;

  // Industry-aware defaults
  const industry = String(business?.industry || '').toLowerCase();
  const defaults = /saas/.test(industry)
    ? [
        { question: 'Will this integrate with my stack?', answer: 'We support 40+ tools out of the box.' },
        { question: 'How long is setup?', answer: 'Most teams are running inside 30 minutes.' },
        { question: "What if it doesn't work for us?", answer: 'Cancel anytime — no contract.' },
      ]
    : /e-?commerce|shop/.test(industry)
      ? [
          { question: 'How long does shipping take?', answer: 'Most orders arrive in 3-5 business days.' },
          { question: "What's your return policy?", answer: '30-day no-questions-asked returns.' },
          { question: 'Is checkout secure?', answer: 'PCI-DSS compliant. Your card never touches our servers.' },
        ]
      : [
          { question: 'How much does it cost?', answer: 'Honest, transparent pricing — no hidden fees.' },
          { question: 'How fast can you get to me?', answer: 'Same-day or next-day in most cases.' },
          { question: "What if I'm not satisfied?", answer: "We make it right or you don't pay." },
        ];
  return [...fromVoc, ...defaults].slice(0, count);
}

function pickTrustStrip({ business }) {
  const items = [];
  if (business?.years_in_business && business.years_in_business >= 1) {
    items.push({ label: `${business.years_in_business}+ years in business`, kind: 'tenure' });
  }
  if (business?.licensed) items.push({ label: 'Licensed & insured', kind: 'credential' });
  if (business?.bbb_accredited) items.push({ label: 'BBB Accredited', kind: 'credential' });
  if (business?.review_count && business.review_count >= 10) {
    items.push({ label: `${business.review_count} verified reviews`, kind: 'social_proof' });
  }
  if (items.length === 0) {
    items.push({ label: 'Trusted by local customers', kind: 'generic' });
  }
  return items;
}

// ─── Static HTML renderer ────────────────────────────────────────────────

function renderHtml(spec) {
  if (!spec || !Array.isArray(spec.sections)) return '<!doctype html><html><body>Empty</body></html>';
  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const sections = spec.sections.map(renderSection).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.meta?.title || '')}</title>
<meta name="description" content="${esc(spec.meta?.description || '')}">
<meta property="og:title" content="${esc(spec.meta?.title || '')}">
<meta property="og:description" content="${esc(spec.meta?.description || '')}">
${spec.meta?.og_image ? `<meta property="og:image" content="${esc(spec.meta.og_image)}">` : ''}
<style>
:root{--fg:#0f172a;--bg:#fff;--muted:#64748b;--accent:#0ea5e9;--card:#f8fafc}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
section{padding:48px 16px;max-width:1100px;margin:0 auto}h1{font-size:clamp(28px,5vw,48px);line-height:1.1;margin:0 0 12px}
h2{font-size:24px;margin:0 0 8px}p{color:var(--muted);margin:0 0 16px}
.hero{display:grid;gap:24px;grid-template-columns:1fr;align-items:center}
@media(min-width:760px){.hero{grid-template-columns:1.1fr 1fr}}
.hero img{width:100%;height:auto;border-radius:12px}
.btn{display:inline-block;padding:14px 24px;background:var(--accent);color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
.grid3{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.card{padding:24px;background:var(--card);border-radius:12px}
.quote{padding:24px;background:var(--card);border-radius:12px;font-style:italic;color:var(--fg)}
.trust{display:flex;flex-wrap:wrap;gap:16px;color:var(--muted);font-size:14px}
.center{text-align:center}
</style>
</head>
<body>
${sections}
</body>
</html>`;

  function renderSection(sec) {
    if (sec.type === 'hero') {
      return `<section class="hero">
<div><h1>${esc(sec.headline)}</h1><p>${esc(sec.subhead)}</p>${sec.cta ? `<a class="btn" href="${esc(sec.cta.url)}">${esc(sec.cta.label)}</a>` : ''}</div>
${sec.image_url ? `<div><img alt="" src="${esc(sec.image_url)}"></div>` : ''}
</section>`;
    }
    if (sec.type === 'value_props') {
      return `<section><div class="grid3">${(sec.items || [])
        .map((vp) => `<div class="card"><h2>${esc(vp.title)}</h2><p>${esc(vp.body)}</p></div>`)
        .join('')}</div></section>`;
    }
    if (sec.type === 'social_proof' && Array.isArray(sec.quotes) && sec.quotes.length > 0) {
      return `<section><div class="grid3">${sec.quotes
        .map(
          (q) =>
            `<div class="quote">"${esc(q.text)}"<div style="margin-top:8px;font-style:normal;font-size:13px;color:var(--muted)">— ${esc(q.author || q.source || 'verified review')}</div></div>`
        )
        .join('')}</div></section>`;
    }
    if (sec.type === 'objections') {
      return `<section><div class="grid3">${(sec.items || [])
        .map((o) => `<div class="card"><h2>${esc(o.question)}</h2><p>${esc(o.answer)}</p></div>`)
        .join('')}</div></section>`;
    }
    if (sec.type === 'trust_strip') {
      return `<section class="center"><div class="trust" style="justify-content:center">${(sec.items || [])
        .map((t) => `<span>✓ ${esc(t.label)}</span>`)
        .join('')}</div></section>`;
    }
    if (sec.type === 'final_cta') {
      return `<section class="center"><a class="btn" href="${esc(sec.url || '#')}">${esc(sec.label)}</a></section>`;
    }
    return '';
  }
}

// ─── auditPageSpec — re-uses services/cro for the 7-dim audit ───────────

function auditPageSpec(spec) {
  const findings = [];
  let score = 100;

  // Dim 1: Hero clarity (headline word count + subhead presence)
  const hero = spec?.sections?.find((s) => s.type === 'hero');
  if (!hero?.headline) {
    findings.push('Missing hero headline');
    score -= 20;
  } else if (String(hero.headline).split(/\s+/).length > HEADLINE_MAX_WORDS) {
    findings.push(`Headline exceeds ${HEADLINE_MAX_WORDS} words — likely loses scanability`);
    score -= 10;
  }
  if (!hero?.subhead) {
    findings.push('Missing hero subhead');
    score -= 10;
  }

  // Dim 2: CTA presence + label
  if (!hero?.cta?.label) {
    findings.push('Missing hero CTA');
    score -= 15;
  }

  // Dim 3: Value prop trio (3 cards)
  const vp = spec?.sections?.find((s) => s.type === 'value_props');
  if (!vp?.items || vp.items.length < 3) {
    findings.push('Less than 3 value props — weakens differentiation');
    score -= 10;
  }

  // Dim 4: Social proof present (or honestly omitted)
  const sp = spec?.sections?.find((s) => s.type === 'social_proof');
  if (sp && (!Array.isArray(sp.quotes) || sp.quotes.length === 0)) {
    findings.push('Social proof section empty — better to omit than show empty quotes (we never invent)');
    score -= 5;
  }

  // Dim 5: Objections (3 items)
  const obj = spec?.sections?.find((s) => s.type === 'objections');
  if (!obj?.items || obj.items.length < 3) {
    findings.push('Less than 3 objections — likely missing top customer concerns');
    score -= 5;
  }

  // Dim 6: Trust strip
  if (!spec?.sections?.find((s) => s.type === 'trust_strip')) {
    findings.push('No trust strip — adds visible credibility');
    score -= 5;
  }

  // Dim 7: Final CTA
  if (!spec?.sections?.find((s) => s.type === 'final_cta')) {
    findings.push('No closing CTA — page misses a final ask');
    score -= 10;
  }

  return { score: Math.max(0, score), findings };
}

module.exports = {
  buildPageSpec,
  renderHtml,
  auditPageSpec,
  HEADLINE_MAX_WORDS,
  SUBHEAD_MAX_WORDS,
  VALUE_PROP_COUNT,
  OBJECTION_COUNT,
};
