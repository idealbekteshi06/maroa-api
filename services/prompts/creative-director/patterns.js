'use strict';

/**
 * P01-P18 pattern map. Used for empirical originality calibration —
 * if the proposed idea hits a saturated pattern (50+ canonical cases),
 * originality is empirically capped, not subjectively claimed.
 *
 * Mirror of ~/.claude/skills/creative-director/references/legendary-patterns.md
 */

const PATTERNS = {
  P01: { name: 'Idea vs Enemy', mechanic: 'Brand picks a fight with a clearly named adversary (a bad practice, a category convention, a competitor type). Energy comes from the conflict.', saturation: 'medium', examples: 'Apple "Think Different" (vs IBM/conformity), Dove (vs unrealistic beauty)' },
  P02: { name: 'Behavior Inversion', mechanic: 'Take a category convention. Do the opposite. The inversion is the idea.', saturation: 'medium', examples: 'Patagonia "Don\'t Buy This Jacket" (anti-purchase from a retailer)' },
  P03: { name: 'Brand as Activist', mechanic: 'Brand takes a public stance on a social/political issue and acts on it through media spend, product, or activation.', saturation: 'high', examples: 'Nike "Dream Crazy" (Kaepernick), Lego "Rebuild the World"' },
  P04: { name: 'Cultural Hijack', mechanic: 'Brand inserts itself into a cultural moment that\'s already happening — sport, news, calendar, meme.', saturation: 'medium', examples: 'Oreo "Dunk in the Dark" (Super Bowl blackout), KitKat "Have a Break" tie-ins' },
  P05: { name: 'Limitation as Power', mechanic: 'Constraint becomes the message. The thing you can\'t do becomes the thing you celebrate.', saturation: 'low', examples: 'Volkswagen "Think Small", Avis "We Try Harder"' },
  P06: { name: 'Invisible Brand', mechanic: 'Brand mark almost or entirely absent. The idea earns recognition without the logo.', saturation: 'low', examples: 'Burger King "Moldy Whopper", IKEA wordless instructions' },
  P07: { name: 'Craft as Message', mechanic: 'The HOW is the WHAT — execution craft itself communicates the brand idea.', saturation: 'medium', examples: 'Apple Shot on iPhone billboards, John Lewis Christmas films' },
  P08: { name: 'User as Co-Author', mechanic: 'Customer behavior IS the campaign. UGC, vote, choose-your-own.', saturation: 'high', examples: 'Doritos "Crash the Super Bowl", Coca-Cola "Share a Coke"' },
  P09: { name: 'Serialization & Ritual', mechanic: 'Repeating format that audiences anticipate (yearly, weekly, daily). Becomes a ritual.', saturation: 'very_high', examples: 'John Lewis Christmas, Spotify Wrapped (P11 hybrid)' },
  P10: { name: 'Absurd as Carrier', mechanic: 'Surreal/absurd execution that makes a serious point land harder.', saturation: 'low', examples: 'Old Spice "The Man Your Man Could Smell Like", Skittles wedding' },
  P11: { name: 'Social Experiment', mechanic: 'Brand stages a real-life experiment with hidden cameras / public participants. Reveal carries the message.', saturation: 'very_high', examples: 'Dove "Real Beauty Sketches", "Like a Girl"' },
  P12: { name: 'Truth Telling', mechanic: 'Brand says something the category usually hides (about itself, the customer, or the world).', saturation: 'medium', examples: 'Snickers "You\'re Not You When You\'re Hungry"' },
  P13: { name: 'Product as Proof', mechanic: 'Demonstrate the product working in a specific extreme condition. Demo is the campaign.', saturation: 'medium', examples: 'Volvo "Epic Split" (Van Damme), Will It Blend' },
  P14: { name: 'Benefit Hyperbole', mechanic: 'Push a product benefit to absurd extreme to dramatize it.', saturation: 'medium', examples: 'Mac vs PC, Geico (most ads in this pattern)' },
  P15: { name: 'Long-form Drama', mechanic: 'Multi-minute film/series that wins on storytelling, not 30-sec spot logic.', saturation: 'medium', examples: 'BMW Films, Apple "Welcome Home" Spike Jonze' },
  P16: { name: 'Design as Idea', mechanic: 'Visual identity / design system itself is the campaign idea.', saturation: 'very_high', examples: 'Mailchimp "Did You Mean Mailkimp", Spotify color campaigns' },
  P17: { name: 'Tech as Canvas', mechanic: 'New tech (AR, AI, voice, robotics) is itself the message — the medium proves the brand\'s relevance.', saturation: 'medium', examples: 'Burger King "Whopper Detour", Burberry AR' },
  P18: { name: 'Behavior Change Over Time', mechanic: 'Campaign measures itself by getting audience to do something different over months/years, not just remember a message.', saturation: 'low', examples: 'Lifebuoy "Help a Child Reach 5", Always "Like a Girl"' }
};

const SATURATED_PATTERNS = ['P09', 'P11', 'P16']; // very_high — empirical originality cap = 6
const BUSY_PATTERNS = ['P03', 'P08']; // high — cap = 7

function originalityCapForPattern(patternId) {
  if (SATURATED_PATTERNS.includes(patternId)) return 6;
  if (BUSY_PATTERNS.includes(patternId)) return 7;
  return 10;
}

function patternsText() {
  return Object.entries(PATTERNS).map(([id, p]) => {
    return `${id} ${p.name} (${p.saturation}): ${p.mechanic}\n   Examples: ${p.examples}`;
  }).join('\n\n');
}

module.exports = {
  PATTERNS,
  SATURATED_PATTERNS,
  BUSY_PATTERNS,
  originalityCapForPattern,
  patternsText
};
