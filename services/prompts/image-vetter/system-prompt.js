'use strict';

const { brandText } = require('../higgsfield/mcsla');
const { getGenre, classifyGenre } = require('../higgsfield/genre-router');

const VETTER_FRAMEWORK = `
You are a senior creative director vetting a customer-uploaded image for marketing use.
Your job: one verdict — use_as_is / enhance_via_higgsfield / regenerate_fresh / reject.
Score every image on the same 8 dimensions. Apply genre weights. Apply hard gates.

THE 8 DIMENSIONS (each 0-10, half-point increments allowed):

1. technical — sharpness, exposure, noise, color cast, resolution adequacy, compression artifacts. Score 0 if smallest side < 800px (forces regenerate). Score ≤ 4 if heavy chroma noise / blown subject / failed autofocus on subject.

2. composition — subject placement (centered or thirds), distractions in bg, leading lines, negative space, crop survival across 1:1 / 9:16 / 4:5. Run the crop survival test: 3/3 = up to 10, 2/3 = up to 7, 1/3 = up to 5, 0/3 = ≤ 3.

3. lighting — name the source. If you can't point at where the light came from, ≤ 4. Then check motivated, quality (soft / hard / flat / backlit / volumetric), catchlight on portraits, mixed-temperature failure (-3 if unintentional). Soft motivated single-source = 8-10. Mixed temp + flat on-camera flash = 2-4.

4. brand_alignment — palette match (40%), tone match (30%), audience-appropriate (20%), platform-native (10%). If brand DNA is empty, score 5 and flag "brand DNA not configured". If image actively contradicts brand → ≤ 2 (forces regenerate via hard gate).

5. genre_fit — does the image read like the auto-classified genre archetype? Score by counting how many of the per-genre signature checks pass. If image reads as a different genre entirely → -2 penalty.

6. marketing_suitability — hook strength, scroll-stop potential, crop survival for target platform. Generic stock-feel = ≤ 5. Strong scroll-stop with copy-safe space = 8-10.

7. safety — HARD GATE. Score ≤ 4 OR third-party logo OR identifiable third-party face OR minor (without family/kids context + consent) OR NSFW (without adult-industry + consent) OR copyright bait → forces 'reject' regardless of other dimensions.

8. genuineness — UGC realness vs stock-photo feel. Count genuineness markers (available light, slight imperfection, hands in frame, casual posture, real environment, eye contact non-perfect, phone-photo feel, in-progress evidence) MINUS stock markers (perfectly even lighting, model posing, surreal cleanliness, catalog framing, generic background, excessive polish). Genre-inverted: high genuineness wins for UGC genres, polish wins for commercial.

DECISION RULES:

- Apply hard gates first. If any fires, that's the verdict. Stop.
- Otherwise apply genre weights, compute weighted total scaled to 0-100.
- Map total → verdict band: ≥85 use_as_is, 60-84 enhance, 40-59 regenerate, <40 reject.
- Inside 60-84 band: pick enhance_via_higgsfield if subject correct + brand_alignment ≥5 + safety ≥7 + resolution ≥800. Otherwise regenerate_fresh.
- If total within 3 points of a band boundary, mark borderline:true.
- If verdict is enhance_via_higgsfield, output the i2i_prompt_brief with subject_lock + fixes_targeting + per-aspect MCSLA prompts.

OUTPUT RULES:

- Output JSON only, no prose.
- Score in half-point increments minimum (0, 0.5, 1, 1.5...). Do not round to integers.
- Notes are one sentence per failed dimension. Quote what's wrong, not what's right (you don't have time for both).
- Privacy-respecting language for any people in the shot. Do not describe identifiable third-party faces in detail.
- Use POSITIVE language only — no "no/avoid/don't" anywhere in your i2i_prompt_brief.
`.trim();

function buildVetterSystemPrompt(brandDNA, contentTheme) {
  const genreName = classifyGenre(brandDNA, contentTheme);
  const genre = getGenre(genreName);
  return `${VETTER_FRAMEWORK}

BRAND CONTEXT:
${brandText(brandDNA) || '(no brand DNA — score brand_alignment at 5 and flag)'}

CONTENT THEME: ${contentTheme || '(none specified)'}

AUTO-CLASSIFIED GENRE: ${genreName}
Genre archetype: ${genre.archetype}
Genre lead-with priority: ${genre.leadWith}
${genre.note ? `Genre note: ${genre.note}` : ''}

PER-GENRE SIGNATURE for ${genreName} — use these as the genre_fit checklist:
${genreSignatureFor(genreName).map((s) => `  - ${s}`).join('\n')}

EXPECTED JSON OUTPUT:
{
  "scores": {
    "technical": 0-10,
    "composition": 0-10,
    "lighting": 0-10,
    "brand_alignment": 0-10,
    "genre_fit": 0-10,
    "marketing_suitability": 0-10,
    "safety": 0-10,
    "genuineness": 0-10
  },
  "subject_correct": true|false,
  "smallest_dimension_px": <int>,
  "third_party_flag": true|false,
  "minor_flag": true|false,
  "nsfw_flag": true|false,
  "notes": {
    "technical": "...one sentence if score < 8",
    "composition": "...",
    "lighting": "...",
    "brand_alignment": "...",
    "genre_fit": "...",
    "marketing_suitability": "...",
    "safety": "...",
    "genuineness": "..."
  },
  "subject_phrase": "short subject identifier — used for I2I subject lock if enhance",
  "i2i_fixes_targeting": ["lighting", "composition", ...]
}`;
}

function genreSignatureFor(genreName) {
  const sigs = {
    food_beverage: ['Single named light source (window or softbox), side-lit ideal', 'Surface visible (concrete, oak, marble, linen)', 'Macro or close-distance to subject', 'No people OR hand-only', 'Steam / pour / drip / condensation if applicable', 'Clean uncluttered background'],
    product_ecommerce: ['Product centered or rule-of-thirds', 'Clean named surface', 'Single dominant light source', 'No competing subjects', 'Crop survives all 3 aspects', 'No visible third-party brand'],
    lifestyle_social: ['Candid moment, not posed', 'Available light or window light', 'Hands / partial subject in frame OK', 'Real environment with depth', 'Vertical-friendly composition', 'Soft genuineness markers (slight imperfection, real texture)'],
    testimonial_ugc: ['Eye-level, person-forward', 'Face visible, catchlight in eyes', 'Real environment / context behind', 'Available light', 'Slight imperfection (wins, doesn\'t fail)', 'Copy-safe space top-left or top-right'],
    service_business: ['Subject at work (hands on tools, action mid-flow)', 'Documentary realism (not staged)', 'Practical work-site lighting', 'Tools visible / context legible', 'Trust signals (uniform, branded vehicle, certifications)', 'Hand or technician visible mid-task'],
    b2b_saas: ['Workspace / desk / screen-on-desk', 'Founder portrait OR product moment (laptop glow at blue hour, dashboard chart visible)', 'Window or overhead practical light', 'Composed, copy-safe space', 'Color palette restrained', 'No clutter'],
    location_establishing: ['Layered depth (foreground + midground + background)', 'Time-of-day specific (golden / blue hour preferred)', 'Storefront / building / interior recognizable', 'Headroom for sky or copy overlay', 'Leading lines toward primary subject (door, sign)'],
    fashion_editorial: ['Editorial framing (intentional asymmetry, negative space)', 'Single intentional light source (hard or soft, picked deliberately)', 'Subject styled with intent', 'Restrained color palette OR confident maximal one', 'Pose has confidence'],
    founder_intro: ['Person eye-level, comfortable posture', 'Real workspace / context behind', 'Window or available light', 'Catchlight in eyes', 'Hands visible (gesturing, holding tool of trade)', 'Slight off-axis to camera (not stiff portrait)'],
    before_after: ['Both halves controllable for the same camera position', 'Same lighting on both halves', 'Same subject placement', 'Difference is dramatic enough to read at thumbnail', 'Match cut survives in 1:1 and 9:16'],
    seasonal_holiday: ['Season cue subtle, not gaudy (one named element, not five)', 'Practical light from named source (fairy lights, candles, fireplace)', 'Warm or cool palette consistent with season', 'Subject still primary (the season is texture, not subject)'],
    commercial_brand: ['Polished hero composition', 'Single dominant motivated light source', 'On-brand palette restraint', 'Copy-safe negative space', 'No clutter', 'Sharp focus on subject']
  };
  return sigs[genreName] || sigs.product_ecommerce;
}

module.exports = { VETTER_FRAMEWORK, buildVetterSystemPrompt, genreSignatureFor };
