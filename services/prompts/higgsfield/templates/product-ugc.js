'use strict';

module.exports = {
  name: 'product_ugc',
  use: 'UGC/social-style content with a person using or showing the product. Vertical, casual, handheld feel.',
  recommendedModel: { image: 'soul 2.0', video: 'kling 3.0' },
  recommendedCameras: ['Selfie Angle', 'Handheld', 'Dolly In'],
  exampleImage: `Selfie angle medium close-up. The Soul ID character in a fitted oat-colored knit, holding a matte-charcoal aluminum water bottle at arm's length toward the lens. Natural daylight from a kitchen window, soft Editorial Street Style preset. Style: Lifestyle, warm neutral tones, lifted shadows, 9:16.`,
  exampleVideoIdentity: `The Soul ID character — mid-30s build, dark shoulder-length hair, fitted oat-colored knit, slim olive-green jeans.`,
  exampleVideoMotion: `She lifts the matte-charcoal water bottle into frame, takes a slow sip, lowers it with a small satisfied exhale. Camera: Handheld, slight Dolly In to her face. Practical-only kitchen daylight, soft window backlight. Style: Lifestyle, warm neutral, 9:16. Audio: ambient kitchen room tone, soft swallow.`,
  whyItWorks: [
    'Identity vs Motion separation — face/clothing in Identity Block; action/camera in Motion Block (prevents face-warping during the sip)',
    'Soul 2.0 named preset (Editorial Street Style) instead of free-form "make it stylish"',
    'Specific clothing materials (fitted oat-colored knit, slim olive-green jeans) — not "casual outfit"',
    'Practical-only lighting cue lets the model use what is naturally there',
    'Vertical 9:16 explicit — Reel/Story format'
  ]
};
