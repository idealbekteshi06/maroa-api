'use strict';

const hf = require('../higgsfield');

const FIX_LANGUAGE = {
  technical: 'increase sharpness on the named subject; recover highlight and shadow detail on subject edges',
  composition: 're-stage to rule of thirds with subject placed intentionally; clear background of distractions; add copy-safe negative space',
  lighting: 'single named source from a stated direction, soft diffused, motivated; remove all secondary sources; warm neutral 5500K unless brand specifies otherwise',
  brand_alignment: 'shift palette toward brand colors; mood matches brand tone; remove off-brand props',
  genre_fit: 'restage to match the genre archetype signature for the auto-classified genre',
  marketing_suitability: 'compose for target aspect crop; add copy-safe space; strong scroll-stop hook moment',
  genuineness: 'preserve imperfection — keep available-light feel, do not over-polish'
};

function buildEnhanceBrief(input) {
  const { brandDNA, contentTheme, vetterOutput } = input || {};
  const genreName = hf.classifyGenre(brandDNA, contentTheme);
  const genre = hf.getGenre(genreName);
  const fixes = Array.isArray(vetterOutput?.i2i_fixes_targeting) ? vetterOutput.i2i_fixes_targeting.slice(0, 3) : [];
  const subjectLock = (vetterOutput?.subject_phrase || 'the customer-uploaded subject').slice(0, 200);

  const fixLines = fixes.map((f) => FIX_LANGUAGE[f] || `address ${f} weakness`).filter(Boolean);

  const colorGrade = hf.COLOR_GRADE[genre.colorGradeDefault] || hf.COLOR_GRADE.clean_commercial;
  const lighting = hf.LIGHTING[genre.lightingDefault] || hf.LIGHTING.softbox;
  const cameraDefault = (genre.cameraDefaults && genre.cameraDefaults[0]) || 'Static';
  const styleDefault = genre.styleDefault || 'Cinematic commercial';

  const buildPromptForAspect = (aspect) => {
    const framing = aspect === '1:1'
      ? 'centered or left-third placement, copy-safe negative space right'
      : aspect === '9:16'
        ? 'subject vertical center, lower-third placement, copy-safe negative space top'
        : 'rule-of-thirds left placement, copy-safe negative space right';
    return [
      `Soul 2.0. Subject: ${subjectLock}, preserved.`,
      ...fixLines.map((l) => `Fix: ${l}.`),
      `Camera: ${cameraDefault}.`,
      `Composition: ${framing}.`,
      `Lighting: ${lighting}, motivated, single-source.`,
      `Style: ${styleDefault}, ${colorGrade}, sharp focus throughout, ${aspect}.`
    ].join(' ');
  };

  const i2iPrompts = ['1:1', '9:16', '4:5'].map((ar) => ({
    aspect_ratio: ar,
    prompt: hf.killSlop(buildPromptForAspect(ar))
  }));

  return {
    model: 'soul 2.0',
    preset_recommendation: null,
    subject_lock: subjectLock,
    fixes_targeting: fixes,
    genre: genreName,
    i2i_prompts: i2iPrompts,
    fallback_if_i2i_fails: 'regenerate_fresh'
  };
}

module.exports = { buildEnhanceBrief, FIX_LANGUAGE };
