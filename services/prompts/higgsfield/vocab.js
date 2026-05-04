'use strict';

const CAMERA = {
  linear: ['Dolly In', 'Dolly Out', 'Dolly Left', 'Dolly Right', 'Dolly Zoom In', 'Dolly Zoom Out', 'Super Dolly In', 'Super Dolly Out', 'Truck Left', 'Truck Right'],
  vertical: ['Crane Up', 'Crane Down', 'Crane Over The Head', 'Levitation', 'Tilt Up', 'Tilt Down'],
  orbit: ['360 Orbit', 'Arc', 'Lazy Susan', 'Robo Arm'],
  zoom: ['Crash Zoom In', 'Crash Zoom Out', 'Rack Focus'],
  follow: ['Action Run', 'FPV Drone', 'Handheld', 'Head Tracking', 'Snorricam'],
  cinematic: ['Bullet Time', 'Dutch Angle', 'Fisheye', 'Whip Pan', 'Overhead', 'Flying'],
  product: ['Robo Arm', 'Lazy Susan', '360 Orbit', 'Arc', 'Dolly In', 'Macro Dolly In']
};

const SHOT_SIZE = ['ELS', 'EWS', 'WS', 'MLS', 'MWS', 'MS', 'MCU', 'CU', 'ECU', 'Macro', 'OTS', 'POV'];

const ANGLE = ['Eye-Level', 'Low Angle', 'High Angle', 'Overhead', 'Birds Eye View', 'Worms Eye View', 'Dutch Angle', 'Over-the-Shoulder', 'POV', 'Selfie Angle', 'Ground Level'];

const STYLE = ['Cinematic', 'VHS', 'Super 8MM', 'Anamorphic', 'Abstract', 'Documentary', 'Lifestyle', 'Editorial'];

const COLOR_GRADE = {
  blockbuster: 'teal shadows, orange highlights, high contrast',
  cold_thriller: 'desaturated blue-grey, crushed blacks',
  warm_nostalgia: 'golden amber, lifted shadows, soft grain',
  cyberpunk: 'neon magenta + cyan, deep shadows, HDR',
  romance: 'soft pink-gold, lifted shadows, dreamy',
  documentary: 'natural neutral, no grade',
  noir: 'high contrast black and white',
  clean_commercial: 'warm neutral tones, soft diffused light, high key',
  premium_luxury: 'dark moody background, single hard side-light, deep shadows',
  natural_organic: 'overcast diffused, muted earth tones, lifted blacks'
};

const LIGHTING = {
  golden_hour: 'warm directional, sun near horizon',
  blue_hour: 'cool soft, just after sunset',
  overcast: 'diffused, soft, no shadows',
  neon: 'colored artificial from signs/screens',
  volumetric: 'light rays visible through fog/dust',
  side_lit: 'single strong source from one side',
  backlit: 'light source behind subject, rim glow',
  softbox: 'wrapped, minimal shadows, even',
  hard_midday: 'overhead, strong defined shadows',
  practical_only: 'light from sources visible in frame',
  rembrandt: 'triangle of light on shadowed cheek',
  high_key: 'bright, minimal shadows',
  low_key: 'deep shadows, moody'
};

const FILM_STOCK = [
  'Kodak Portra 400 — warm rich skin tones, slight grain',
  'Fuji Velvia — vivid saturated, fine grain',
  'Kodak Vision3 500T — cinematic natural slight warmth',
  'Ilford HP5 — classic black and white, visible grain',
  'Kodak Ektachrome — bright contrasty, clean slide film'
];

const MICRO_EXPRESSION = [
  'Deadpan Neutral', 'Fierce Focus', 'Subtle Arrogance', 'Candid Profile',
  'Suppressed Smile', 'Quiet Devastation', 'Wary Recognition', 'Nervous Composure',
  'Cold Calculation', 'Bitter Amusement', 'Exhausted Relief', 'Frozen Shock',
  'Simmering Rage', 'Vulnerable Openness', 'Controlled Breath', 'Sunblind Squint'
];

const VIDEO_MODELS = {
  kling_3: { id: 'kling 3.0', best_for: 'cinematic character video, audio, multi-shot, 3-15s', has_audio: true },
  kling_2_6: { id: 'kling 2.6', best_for: 'character drama realism, no audio, 5-10s', has_audio: false },
  sora_2: { id: 'sora 2', best_for: 'epic scale, physics, action, explosions', has_audio: false },
  veo_3_1: { id: 'veo 3.1', best_for: 'reference images, first/last frame, environment, 4K', has_audio: true },
  seedance_2: { id: 'seedance 2.0', best_for: '12-asset multimodal, lipsync, multilingual audio, 10s', has_audio: true },
  minimax_hailuo_2_3: { id: 'minimax hailuo 2.3', best_for: 'VFX, fluid motion, anime, physics, 6-10s', has_audio: false },
  wan_2_5: { id: 'wan 2.5', best_for: 'native audio, artistic, fantasy stylized, 5-10s', has_audio: true },
  dop_standard: { id: 'higgsfield dop standard', best_for: 'I2V specialist, 50+ camera presets, optical physics, 3-5s', has_audio: false }
};

const IMAGE_MODELS = {
  soul_2: { id: 'soul 2.0', best_for: 'fashion, portrait, aesthetic, faces' },
  soul_cinema: { id: 'soul cinema preview', best_for: 'cinematic keyframes, close-ups, film grain' },
  nano_banana_pro: { id: 'nano banana pro', best_for: 'max sharpness, 4K, product hero' },
  nano_banana_2: { id: 'nano banana 2', best_for: 'fast pro-quality, text rendering, consistency' },
  seedream_4_5: { id: 'seedream 4.5', best_for: 'reference consistency, dense text, 4K' },
  kling_image_3: { id: 'kling image 3.0', best_for: 'native 4K, series mode, storyboarding' }
};

const SOUL_PRESETS = [
  'Editorial Street Style', 'Mystique City', 'Warm Ambient', 'Subtle Flash',
  'Old Smartphone', 'Frutiger Aero', 'Swag Era', 'Y2K Outside',
  'Nature Light', 'Y2K Studio', 'Theatrical Light', 'Siren'
];

module.exports = {
  CAMERA,
  SHOT_SIZE,
  ANGLE,
  STYLE,
  COLOR_GRADE,
  LIGHTING,
  FILM_STOCK,
  MICRO_EXPRESSION,
  VIDEO_MODELS,
  IMAGE_MODELS,
  SOUL_PRESETS
};
