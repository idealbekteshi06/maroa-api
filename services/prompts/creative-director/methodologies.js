'use strict';

/**
 * 20+ creative methodologies, three categories.
 * The Phase 3 algorithm requires picking ONE from each category to avoid
 * single-method tunnel vision. Mirror of ~/.claude/skills/creative-director/references/methods-catalog.md
 */

const STRUCTURAL = {
  SIT: {
    name: 'SIT (Systematic Inventive Thinking)',
    use: 'Modify product/context using 5 templates: Subtraction, Division, Multiplication, Task Unification, Attribute Dependency',
    prompt_hint: 'Take the product. Remove a core component (Subtraction). What does the brand become without it?'
  },
  SCAMPER: {
    name: 'SCAMPER',
    use: 'Substitute / Combine / Adapt / Modify / Put to other use / Eliminate / Reverse — apply to any element of the brief',
    prompt_hint: 'Pick three SCAMPER moves. Apply to the most-defended brand assumption.'
  },
  TRIZ: {
    name: 'TRIZ (10 inventive principles)',
    use: 'Resolve contradictions by inversion, segmentation, asymmetry, dynamics, or nesting',
    prompt_hint: 'State the central contradiction. Pick the TRIZ principle that resolves it without compromise.'
  },
  MORPHOLOGICAL: {
    name: 'Morphological Analysis',
    use: 'Break the brief into 3-5 dimensions (audience emotion / brand role / cultural moment / channel native). Combinatorial fan-out.',
    prompt_hint: 'Make a 4-column matrix of axes. Force 3 unexpected combinations across columns.'
  }
};

const ASSOCIATIVE = {
  BISOCIATION: {
    name: 'Bisociation (Koestler)',
    use: 'Cross two unrelated frames of reference. The collision is the idea.',
    prompt_hint: 'List 5 things the audience does WHEN they\'re NOT thinking about your category. Force a collision.'
  },
  RANDOM_ENTRY: {
    name: 'Random Entry (de Bono)',
    use: 'Pick a random word/object. Force a connection to the brief.',
    prompt_hint: 'Random noun: [pick one]. How does this random thing solve the brief?'
  },
  SYNECTICS: {
    name: 'Synectics (4 analogies)',
    use: 'Direct (other categories), Personal (be the product), Symbolic (compress to a metaphor), Fantasy (impossible solution)',
    prompt_hint: 'Run all four analogies. The fantasy version often becomes the campaign.'
  },
  FORCED_CONNECTIONS: {
    name: 'Forced Connections',
    use: 'Pick two unrelated trends/cultural moments. Force a creative bridge.',
    prompt_hint: 'Two trends in audience\'s feed RIGHT NOW. Bridge.'
  }
};

const INVERSION = {
  REVERSE_BRAINSTORMING: {
    name: 'Reverse Brainstorming',
    use: 'Solve the OPPOSITE problem. Then invert the answers.',
    prompt_hint: 'How would we make the audience HATE the brand? Invert each answer.'
  },
  WORST_IDEA: {
    name: 'Worst Possible Idea',
    use: 'Generate the worst, dumbest, most offensive idea. Find the buried good idea inside it.',
    prompt_hint: 'What would a horrible intern produce? Find the truth-bomb hidden in the dumbest version.'
  },
  PROVOCATION_PO: {
    name: 'Provocation (PO statements, de Bono)',
    use: 'Make a deliberately absurd statement (PO). Move-laterally from there.',
    prompt_hint: 'PO: [absurd inversion of brand truth]. Now move laterally — what idea this provokes?'
  },
  OBLIQUE_STRATEGIES: {
    name: 'Oblique Strategies (Eno/Schmidt)',
    use: 'Apply a perturbation card: "Honor thy error as a hidden intention" / "What would your closest friend do?" / "Make a sudden, destructive, unpredictable action"',
    prompt_hint: 'Pick ONE Oblique card. Apply to current best idea.'
  },
  SIX_HATS: {
    name: 'Six Thinking Hats (de Bono)',
    use: 'Rotate through 6 thinking modes: White (data), Red (feeling), Black (caution), Yellow (benefit), Green (creativity), Blue (process)',
    prompt_hint: 'Especially useful for evaluation: Black hat finds the kill, Yellow finds the save.'
  }
};

const VOLUME = {
  CRAZY_8S: {
    name: 'Crazy 8s',
    use: '8 ideas in 8 minutes. Forces past the obvious early ones.',
    prompt_hint: 'List 8 ideas fast. The first 3 are warmup — bias toward 5-8.'
  },
  BRAINWRITING_635: {
    name: 'Brainwriting 6-3-5',
    use: '6 ideas, 3 minutes, 5 rounds. Each round builds on previous.',
    prompt_hint: 'Round 1: 6 ideas. Round 2: 6 NEW ideas building on round 1. Round 3: 6 new. Etc.'
  },
  STARBURSTING: {
    name: 'Starbursting',
    use: 'Six dimensions of question (Who, What, When, Where, Why, How) — exhaust each.',
    prompt_hint: 'Use BEFORE ideation to widen the brief space.'
  }
};

const ALL_METHODS = { ...STRUCTURAL, ...ASSOCIATIVE, ...INVERSION, ...VOLUME };

const CATEGORIES = {
  structural: Object.keys(STRUCTURAL),
  associative: Object.keys(ASSOCIATIVE),
  inversion: Object.keys(INVERSION),
  volume: Object.keys(VOLUME)
};

/**
 * Pick one method from each of 3 different categories for ideation.
 * Required by Phase 3 anti-pitfall rule: never run a single method.
 */
function pickMethodTriplet(rotation = 0) {
  const cats = ['structural', 'associative', 'inversion'];
  const triplet = cats.map((cat) => {
    const keys = CATEGORIES[cat];
    return keys[rotation % keys.length];
  });
  return triplet.map((k) => ALL_METHODS[k]);
}

function methodTripletText(triplet) {
  return triplet.map((m, i) => `Method ${i + 1} (${m.name}): ${m.use}\n   Hint: ${m.prompt_hint}`).join('\n\n');
}

module.exports = {
  STRUCTURAL,
  ASSOCIATIVE,
  INVERSION,
  VOLUME,
  ALL_METHODS,
  CATEGORIES,
  pickMethodTriplet,
  methodTripletText
};
