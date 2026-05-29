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

// Human-facing labels for the in-code presets. Used when mirroring the
// catalog into the higgsfield_presets table (migration 087) so a frontend
// preset picker can read them without hard-coding this list.
const PRESET_LABELS = {
  social: 'Social Reel',
  cinematic: 'Cinematic Commercial',
  product: 'Product Hero',
  ugc: 'Authentic UGC',
  talking_head: 'Talking Head',
};

/**
 * The preset catalog in `higgsfield_presets` row shape. This mirrors the
 * presets WE define in code — it is NOT a fetch of Higgsfield's hosted
 * preset list (that endpoint still needs REST docs). When that lands it can
 * augment/refresh these rows behind the same table.
 */
function listPresetCatalog() {
  return Object.values(PRESETS).map((p) => ({
    preset_id: p.id,
    name: PRESET_LABELS[p.id] || p.id,
    description: [p.style, p.camera, p.lighting].filter(Boolean).join('. '),
    preview_url: null,
    supported_industries: [], // [] = applies to all industries
  }));
}

/**
 * Idempotently mirror the in-code preset catalog into higgsfield_presets.
 * Inserts rows that don't exist yet and patches description/name drift on
 * ones that do. Soft-fails per row so a single bad write never aborts the
 * weekly sync. Returns { inserted, updated, total }.
 */
async function syncPresetCatalog({ sbGet, sbPost, sbPatch, logger } = {}) {
  if (typeof sbGet !== 'function' || typeof sbPost !== 'function') {
    return { inserted: 0, updated: 0, total: 0, skipped: 'sb helpers unavailable' };
  }
  const catalog = listPresetCatalog();
  const existing = await sbGet('higgsfield_presets', 'select=preset_id,name,description').catch(() => []);
  const byId = new Map((existing || []).map((r) => [r.preset_id, r]));

  let inserted = 0;
  let updated = 0;
  for (const row of catalog) {
    const prev = byId.get(row.preset_id);
    try {
      if (!prev) {
        await sbPost('higgsfield_presets', { ...row, updated_at: new Date().toISOString() });
        inserted += 1;
      } else if (prev.name !== row.name || prev.description !== row.description) {
        if (typeof sbPatch === 'function') {
          await sbPatch('higgsfield_presets', `preset_id=eq.${encodeURIComponent(row.preset_id)}`, {
            name: row.name,
            description: row.description,
            updated_at: new Date().toISOString(),
          });
          updated += 1;
        }
      }
    } catch (e) {
      logger?.warn?.('higgsfield.syncPresetCatalog', null, 'preset upsert failed', {
        preset_id: row.preset_id,
        error: e.message,
      });
    }
  }
  return { inserted, updated, total: catalog.length };
}

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
  const hints = [preset.camera, preset.lighting, preset.style, preset.pacing, preset.audio].filter(Boolean).join('. ');
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
  listPresetCatalog,
  syncPresetCatalog,
};
