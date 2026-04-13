/*
 * workflow_10_studio.js — Higgsfield Studio prompts (backend-native)
 * Pipeline: image/video generation brief → Segmind/Higgsfield API → asset.
 */

'use strict';

const { buildSystemPrompt } = require('./foundation.js');

function buildStudioBriefPrompt(ctx, request) {
  const addendum = `
WORKFLOW #10 — HIGGSFIELD STUDIO (image/video generation)

You are the creative director. Turn the concept below into a production-ready
brief for Segmind + Higgsfield (image-to-video pipeline). Your output goes
directly into API calls — be extremely specific.

OUTPUT JSON
{
  "asset_type": "image|video|carousel|reel",
  "image_prompts": [ /* array of 1-3 generation prompts if asset_type=image */ ],
  "video_prompt": { /* if asset_type=video|reel */
    "source_image_prompt": "string",
    "motion_prompt": "string (camera movement, subject motion, vibe)",
    "duration_seconds": number,
    "aspect_ratio": "9:16|16:9|1:1|4:5",
    "style_reference": "photorealistic|cinematic|anime|illustration|studio"
  },
  "carousel_slides": [ /* if asset_type=carousel */
    { "index": 1, "image_prompt": "string", "text_overlay": "string", "layout": "string" }
  ],
  "brand_guardrails": {
    "must_include": ["brand colors", "logo placement", "font family"],
    "must_avoid": ["no competitor logos", "no generic stock", "no copyrighted music"]
  },
  "platform_optimizations": [
    { "platform": "instagram_reel|tiktok|instagram_feed", "note": "string" }
  ],
  "quality_gates": {
    "required_resolution": "string",
    "required_aspect": "string",
    "safe_zones_respected": boolean
  }
}

Rules:
- Always specify ASPECT RATIO and RESOLUTION.
- Always include brand colors by hex if known.
- Never use celebrity names or copyrighted characters.
- For video: always describe the first 2 seconds (the hook) explicitly.
`.trim();

  const user = `
CONCEPT
  Core idea: ${request.coreIdea}
  Platform: ${request.platform}
  Mood: ${request.mood || 'modern confident'}
  Subject: ${request.subject}
  Text on image (if any): ${request.textOverlay || '(none)'}

BRAND VISUAL
  Colors: ${request.brandColors || 'unknown'}
  Style: ${request.brandStyle || 'modern editorial'}
  Existing assets to match: ${request.referenceAssets || 'none'}
`.trim();

  return { system: buildSystemPrompt(ctx, addendum), user };
}

module.exports.buildStudioBriefPrompt = buildStudioBriefPrompt;
