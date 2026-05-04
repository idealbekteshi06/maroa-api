'use strict';

module.exports = {
  name: 'product_hero',
  use: 'Hero shot of a product as the central subject. Maximum sharpness, premium look, no humans.',
  recommendedModel: { image: 'nano banana pro', video: 'higgsfield dop standard' },
  recommendedCameras: ['Robo Arm', 'Lazy Susan', 'Macro Dolly In', '360 Orbit'],
  exampleImage: `Macro shot, low angle, static. A matte-charcoal aluminum water bottle with a brushed-steel cap, sitting on a raw concrete countertop beside a sun-warmed window. Condensation beads forming on the bottle's surface, a single droplet sliding down. Soft side-light from the window catches the brushed cap. Style: Cinematic commercial, warm neutral tones, soft diffused natural light. Sharp focus throughout. 1:1.`,
  exampleVideo: `A matte-charcoal aluminum water bottle stands on raw concrete, condensation beading. A single droplet slides down the surface (charge-up). Hand enters frame and grasps the bottle, lifting it out of frame (burst). Light catches the wet ring left on the concrete (aftermath). Camera: Robo Arm arcing slowly from base up to lid. Style: Cinematic commercial, warm neutral, soft diffused window light, 9:16. Audio: gentle metallic clink, faint surface contact.`,
  whyItWorks: [
    'Specific material + form + finish (matte-charcoal aluminum, brushed-steel cap) instead of "premium bottle"',
    'Named surface (raw concrete) — never floating in undefined space',
    'Single light source named (soft side-light from window) — not "professional lighting"',
    'Camera preset named exactly (Robo Arm) — not "camera moves around"',
    'Three-act rhythm: charge-up (droplet) → burst (hand grabs) → aftermath (wet ring)',
    'No brand name on the product — appearance only, filter-safe'
  ]
};
