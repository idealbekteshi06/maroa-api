'use strict';

/**
 * Camera / format presets for WF10 video generation.
 * Merged into Higgsfield payloads and brief motion prompts.
 */

const PRESETS = {
  social: {
    id: 'social',
    aspect_ratio: '9:16',
    format: 'vertical',
    pacing: 'fast cuts',
    audio: 'trending audio',
    camera: 'handheld vertical, quick cuts, social-native framing',
    style: 'trending social reel, punchy hook in first 2 seconds',
  },
  cinematic: {
    id: 'cinematic',
    aspect_ratio: '16:9',
    format: 'widescreen',
    camera: 'dolly shot, golden hour, wide angle',
    lighting: 'golden hour, motivated natural light',
    style: 'cinematic commercial, shallow depth of field',
  },
  product: {
    id: 'product',
    aspect_ratio: '1:1',
    camera: 'close-up, controlled macro dolly',
    lighting: 'studio lighting, clean background',
    style: 'product hero, crisp detail, minimal distractions',
  },
  ugc: {
    id: 'ugc',
    aspect_ratio: '9:16',
    camera: 'handheld, natural light',
    style: 'authentic UGC, imperfect framing, real environment',
    lighting: 'natural light, soft shadows',
  },
  talking_head: {
    id: 'talking_head',
    aspect_ratio: '9:16',
    camera: 'portrait framing, eye-level',
    lighting: 'soft lighting, clear face, gentle catchlight',
    style: 'testimonial talking head, trustworthy, direct to camera',
  },
};

const DEFAULT_PRESET = 'ugc';

function getCameraPreset(presetId) {
  const key = String(presetId || DEFAULT_PRESET)
    .trim()
    .toLowerCase();
  return PRESETS[key] || PRESETS[DEFAULT_PRESET];
}

/** Build prompt suffix + payload fields from a preset. */
function applyCameraPresetToPayload(payload, presetId) {
  const preset = getCameraPreset(presetId);
  const out = { ...payload };
  if (preset.aspect_ratio && !out.aspect_ratio) out.aspect_ratio = preset.aspect_ratio;
  const hints = [preset.camera, preset.lighting, preset.style, preset.pacing, preset.audio]
    .filter(Boolean)
    .join('. ');
  if (hints) {
    out.prompt = out.prompt ? `${out.prompt} ${hints}` : hints;
  }
  out._camera_preset = preset.id;
  return out;
}

function motionPromptFromPreset(presetId, baseMotion) {
  const preset = getCameraPreset(presetId);
  const parts = [baseMotion, preset.camera, preset.style].filter(Boolean);
  return parts.join('. ');
}

module.exports = {
  PRESETS,
  DEFAULT_PRESET,
  getCameraPreset,
  applyCameraPresetToPayload,
  motionPromptFromPreset,
};
