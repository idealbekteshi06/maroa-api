'use strict';

/** Agency video A/B matrix — three model + preset combinations. */
const VIDEO_AB_VARIANTS = [
  { key: 'a', model: 'nano-banana-pro', preset: 'social', content_type: 'social_reel' },
  { key: 'b', model: 'kling-3.0', preset: 'cinematic', content_type: 'cinematic' },
  { key: 'c', model: 'wan-2.5', preset: 'ugc', content_type: 'ugc_testimonial' },
];

module.exports = { VIDEO_AB_VARIANTS };
