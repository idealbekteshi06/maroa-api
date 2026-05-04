'use strict';

const { CAMERA, STYLE, COLOR_GRADE, LIGHTING, FILM_STOCK, VIDEO_MODELS, IMAGE_MODELS, SOUL_PRESETS } = require('./vocab');
const { SLOP_INSTRUCTION } = require('./anti-slop');
const { CONSTRAINT_INSTRUCTION, constraintsFor } = require('./negative-constraints');
const { getGenre } = require('./genre-router');

const MCSLA_DEFINITION = `
MCSLA — five required layers in every Higgsfield prompt:
M (Model): which engine — Kling 3.0 / Sora 2 / Veo 3.1 / Seedance 2.0 / DoP / Soul 2.0 / Nano Banana Pro / etc.
C (Camera): NAMED preset only — Dolly In, Crane Up, FPV Drone, Robo Arm, 360 Orbit, Lazy Susan, Action Run, Bullet Time, Macro Dolly In, Handheld, Static. Never say "the camera moves dramatically" — name the move.
S (Subject): who/what + concrete appearance. Material, color, form. NO brand names.
L (Look): style + color grade + lighting source. "Cinematic, warm neutral tones, soft diffused window light, 16:9".
A (Action): what happens. Active verbs. Three-act rhythm where applicable: charge-up → burst → aftermath.

Order: Subject → Action → Camera → Style is the most reliable.
Lead with subject + action in first 20-30 words. Early tokens carry disproportionate weight.
Keep prompts under 200 words. Cinema Studio: under 512 chars.
One primary action per shot. Multiple actions = jittery output.
For I2V (animating an existing image): only describe what CHANGES or MOVES. Never re-describe what's already in the image.`.trim();

const IDENTITY_MOTION_SEPARATION = `
Identity vs Motion separation (mandatory when a person appears with Soul ID):
Identity Block — face, skin tone, body, clothing, accessories, color palette. NO motion, NO camera, NO temporal language.
Motion Block — camera movement, action, environmental motion, atmospheric changes. NO appearance descriptors.
Mixing them causes the model to re-read face descriptors per frame, which warps the face mid-clip.`.trim();

function brandText(brandDNA) {
  const b = brandDNA || {};
  const businessName = b.business_name || b.businessName;
  const tone = b.tone || b.brand_tone || b.brandTone;
  const audience = b.audience || b.target_audience || b.targetAudience;
  const competitors = Array.isArray(b.competitors) ? b.competitors : (Array.isArray(b.competitor_list) ? b.competitor_list : null);
  const visualPalette = b.visualPalette || b.visual_palette;
  const compositionRules = b.compositionRules || b.composition_rules;
  const motionIdentity = b.motionIdentity || b.motion_identity;
  const goal = b.marketing_goal || b.marketingGoal;
  return [
    businessName && `Brand: ${businessName}`,
    b.industry && `Industry: ${b.industry}`,
    tone && `Brand tone: ${tone}`,
    audience && `Audience: ${audience}`,
    b.location && `Location: ${b.location}`,
    goal && `Marketing goal: ${goal}`,
    competitors && competitors.length && `Competitors: ${competitors.slice(0, 3).join(', ')}`,
    visualPalette && `Visual palette: ${visualPalette}`,
    compositionRules && `Composition rules: ${compositionRules}`,
    motionIdentity && `Motion identity: ${motionIdentity}`
  ].filter(Boolean).join('\n');
}

function pickImageModel(brandDNA, genre) {
  const wantsCharacter = ['testimonial_ugc', 'founder_intro', 'lifestyle_social', 'fashion_editorial'].includes(genre);
  if (wantsCharacter) return IMAGE_MODELS.soul_2;
  if (genre === 'food_beverage' || genre === 'product_ecommerce') return IMAGE_MODELS.nano_banana_pro;
  return IMAGE_MODELS.nano_banana_2;
}

function pickVideoModel(brandDNA, genre, opts = {}) {
  const wantsAudio = !!opts.wantsAudio;
  const wantsScale = ['location_establishing'].includes(genre);
  const wantsMotionTransfer = !!opts.wantsMotionTransfer;
  const wantsCharacter = ['testimonial_ugc', 'founder_intro', 'lifestyle_social', 'fashion_editorial'].includes(genre);
  const isI2V = !!opts.isI2V;
  if (isI2V && (genre === 'product_ecommerce' || genre === 'food_beverage')) return VIDEO_MODELS.dop_standard;
  if (wantsScale) return VIDEO_MODELS.sora_2;
  if (wantsMotionTransfer) return VIDEO_MODELS.kling_3;
  if (wantsCharacter && wantsAudio) return VIDEO_MODELS.seedance_2;
  if (wantsCharacter) return VIDEO_MODELS.kling_3;
  if (wantsAudio) return VIDEO_MODELS.veo_3_1;
  return VIDEO_MODELS.kling_3;
}

function buildImageSystemPrompt(brandDNA, genreName) {
  const genre = getGenre(genreName);
  const constraints = constraintsFor(genre.constraintCategories);
  const colorGrade = COLOR_GRADE[genre.colorGradeDefault];
  const lighting = LIGHTING[genre.lightingDefault];
  const cameras = genre.cameraDefaults.join(' / ');
  const presetHint = ['testimonial_ugc', 'founder_intro', 'lifestyle_social', 'fashion_editorial'].includes(genreName)
    ? `Soul 2.0 presets to consider: ${SOUL_PRESETS.slice(0, 8).join(', ')}.`
    : '';

  return `You are a senior art director writing Higgsfield image prompts. Apply the MCSLA framework strictly.

${MCSLA_DEFINITION}

${SLOP_INSTRUCTION}

${CONSTRAINT_INSTRUCTION}

Genre: ${genreName}
Lead with: ${genre.leadWith}
Target length: ${genre.targetWords[0]}-${genre.targetWords[1]} words
Default cameras: ${cameras}
Default style: ${genre.styleDefault}, color grade: ${colorGrade}
Default lighting: ${lighting}
Archetype: ${genre.archetype}
Lead example: ${genre.leadExample}
${presetHint}

Brand DNA:
${brandText(brandDNA)}

Required positive constraints to weave into prompt:
${constraints.map((c) => `- ${c}`).join('\n')}

For image prompts use this pattern:
[Shot size] + [Angle] + [Movement keyword] of [subject].
[Pose / action / micro-expression].
[Environment — surface, location, atmosphere].
[Lighting — source + quality + color grade].
[Style — Cinematic / Editorial / Documentary + film stock if relevant + aspect ratio].

NEVER use brand names. Describe by appearance only.
NEVER write "no/avoid/don't" — use positive language.
NEVER mix identity and motion when a Soul ID character is involved.`;
}

function buildVideoSystemPrompt(brandDNA, genreName, opts = {}) {
  const genre = getGenre(genreName);
  const constraints = constraintsFor([...genre.constraintCategories, 'temporal_consistency']);
  const colorGrade = COLOR_GRADE[genre.colorGradeDefault];
  const lighting = LIGHTING[genre.lightingDefault];
  const cameras = genre.cameraDefaults.join(' / ');
  const isI2V = !!opts.isI2V;

  const i2vRule = isI2V
    ? `\nI2V MODE: Describe ONLY what should MOVE or CHANGE from the reference image. Never re-describe static elements already visible.`
    : '';

  return `You are a senior commercial director writing Higgsfield video prompts. Apply the MCSLA framework strictly.

${MCSLA_DEFINITION}

${IDENTITY_MOTION_SEPARATION}

${SLOP_INSTRUCTION}

${CONSTRAINT_INSTRUCTION}

Genre: ${genreName}
Lead with: ${genre.leadWith}
Target length: ${genre.targetWords[0]}-${genre.targetWords[1]} words
Default cameras: ${cameras}
Default style: ${genre.styleDefault}, color grade: ${colorGrade}
Default lighting: ${lighting}
Archetype: ${genre.archetype}
Lead example: ${genre.leadExample}${i2vRule}

Brand DNA:
${brandText(brandDNA)}

Required positive constraints:
${constraints.map((c) => `- ${c}`).join('\n')}

Video prompt pattern:
[Subject + appearance — concrete material/color].
[Action — verbs, three-act rhythm where applicable].
Camera: [NAMED preset]
Style: ${genre.styleDefault}, ${colorGrade}, ${lighting}, [aspect ratio].
${opts.wantsAudio ? 'Audio: [ambient, SFX, music cue — describe each track separately]' : ''}

For 15s ad format use the four-beat structure:
0-3s hook | 3-8s reveal | 8-12s benefits | 12-15s CTA

NEVER use brand names. NEVER write "no/avoid/don't". NEVER mix identity and motion.`;
}

function buildJsonResponseEnvelope(genreName, count = 3) {
  const genre = getGenre(genreName);
  return `Return ONLY valid JSON, no prose, with this shape:
{
  "analysis": "one sentence on the visual direction",
  "model_recommendation": "exact Higgsfield model id",
  "preset_recommendation": "exact Soul preset name if applicable, else null",
  "prompts": [
${Array.from({ length: count }, (_, i) => `    { "aspect_ratio": "${['1:1', '9:16', '4:5'][i] || '1:1'}", "prompt": "MCSLA-structured prompt, ${genre.targetWords[0]}-${genre.targetWords[1]} words, leads with ${genre.leadWith}", "camera": "named preset", "style": "Cinematic|Editorial|Documentary|Lifestyle", "color_grade": "named grade", "lighting": "named lighting" }`).join(',\n')}
  ]
}`;
}

module.exports = {
  MCSLA_DEFINITION,
  IDENTITY_MOTION_SEPARATION,
  brandText,
  pickImageModel,
  pickVideoModel,
  buildImageSystemPrompt,
  buildVideoSystemPrompt,
  buildJsonResponseEnvelope
};
