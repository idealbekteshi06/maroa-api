'use strict';

const vocab = require('./vocab');
const antiSlop = require('./anti-slop');
const negativeConstraints = require('./negative-constraints');
const genreRouter = require('./genre-router');
const mcsla = require('./mcsla');

function buildImageBrief(input) {
  const { brandDNA, contentTheme, productImageUrl, hasReferenceImage, isI2V } = input || {};
  const genreName = genreRouter.classifyGenre(brandDNA, contentTheme);
  const genre = genreRouter.getGenre(genreName);
  const model = mcsla.pickImageModel(brandDNA, genreName);
  const system = mcsla.buildImageSystemPrompt(brandDNA, genreName);
  const responseEnvelope = mcsla.buildJsonResponseEnvelope(genreName, 3);
  const userTask = [
    productImageUrl && hasReferenceImage ? 'Analyze the attached reference image first. Use it as visual ground truth — match its product/character geometry but improve composition, lighting, and surface staging.' : null,
    `Content theme: ${contentTheme || 'general brand content'}`,
    `Generate three image prompts for aspect ratios 1:1, 9:16, 4:5 (feed, story/reel, IG portrait).`,
    isI2V ? 'These are I2V prompts — describe ONLY what changes or moves; the reference defines the static elements.' : 'These are still-image prompts.',
    responseEnvelope
  ].filter(Boolean).join('\n\n');

  return {
    genreName,
    genre,
    model,
    system,
    userTask
  };
}

function buildVideoBrief(input) {
  const { brandDNA, contentTheme, productImageUrl, isI2V, wantsAudio, wantsMotionTransfer, durationSec } = input || {};
  const genreName = genreRouter.classifyGenre(brandDNA, contentTheme);
  const genre = genreRouter.getGenre(genreName);
  const model = mcsla.pickVideoModel(brandDNA, genreName, { wantsAudio, wantsMotionTransfer, isI2V });
  const system = mcsla.buildVideoSystemPrompt(brandDNA, genreName, { isI2V, wantsAudio });
  const dur = Math.max(3, Math.min(15, durationSec || 8));
  const responseEnvelope = `Return ONLY valid JSON:
{
  "analysis": "one sentence on the cinematic direction",
  "model_recommendation": "exact Higgsfield video model id",
  "duration_sec": ${dur},
  "prompt": "single MCSLA-structured prompt, ${genre.targetWords[0]}-${genre.targetWords[1]} words, leading with ${genre.leadWith}",
  "camera": "named preset",
  "style": "named style",
  "color_grade": "named grade",
  "lighting": "named lighting",
  "aspect_ratio": "9:16 | 16:9 | 1:1",
  ${wantsAudio ? '"audio": "ambient + SFX + music cues",' : ''}
  "negative_to_positive_check": "confirm no negation phrasing was used"
}`;

  const userTask = [
    productImageUrl ? 'Analyze the attached reference image first.' : null,
    `Content theme: ${contentTheme || 'general brand content'}`,
    isI2V ? 'I2V mode — only describe motion and camera. Reference image defines the static state.' : 'Generate a single video prompt.',
    `Target duration: ${dur}s.`,
    durationSec === 15 ? 'Use the 0-3s hook | 3-8s reveal | 8-12s benefits | 12-15s CTA structure.' : null,
    responseEnvelope
  ].filter(Boolean).join('\n\n');

  return {
    genreName,
    genre,
    model,
    system,
    userTask,
    durationSec: dur
  };
}

function buildHeroAdBrief(input) {
  return buildVideoBrief({ ...input, durationSec: 15, wantsAudio: true });
}

module.exports = {
  buildImageBrief,
  buildVideoBrief,
  buildHeroAdBrief,
  ...mcsla,
  ...vocab,
  ...antiSlop,
  ...negativeConstraints,
  ...genreRouter
};
