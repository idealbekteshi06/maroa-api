'use strict';

/**
 * Three calibration systems used together:
 * 1. Six weighted criteria (idea strength)  — 1-10
 * 2. HumanKind Scale (Leo Burnett)          — 1-10
 * 3. Grey Scale (Grey Group)                — 1-10
 *
 * Mirror of ~/.claude/skills/creative-director/references/scoring-calibration.md
 */

const SIX_CRITERIA = {
  originality: { weight: 0.25, gate: 'cap at 7 if pattern has 3+ canonical cases; cap at 6 if pattern has 50+ (P09 / P11 / P16)' },
  strategic_fit: { weight: 0.20, gate: 'must answer the brief\'s objective and hit the TA' },
  emotional_response: { weight: 0.20, gate: 'Tier 1 (generic happy/sad) ≤ 6; Tier 2 (specific: nostalgic/defiant/proud) 6-8; Tier 3 (complex: bittersweet pride / ironic sincerity) 8-10' },
  feasibility: { weight: 0.15, gate: 'must be implementable within budget/timeline/constraints stated in brief' },
  scalability: { weight: 0.10, gate: 'series? other media? other markets?' },
  simplicity: { weight: 0.10, gate: 'one sentence, 10-second explanation, otherwise it\'s a plan not an idea' }
};

const HUMANKIND_SCALE = {
  1: 'Destructive — pollutes the media space',
  2: 'No idea — waste of resources',
  3: 'Invisible — clichés, no emotion',
  4: 'No purpose — channels first, audience nowhere',
  5: 'Brand purpose — has a human mission',
  6: 'Intelligent idea — smart but not channel-tied',
  7: 'HumanKind Act — changes thoughts/feelings, impeccable craft (PRESENTATION FLOOR — below 7 do not present)',
  8: 'Changes thinking — becomes part of people\'s lives',
  9: 'Changes living — inspires lifestyle change',
  10: 'Changes the world'
};

const GREY_SCALE = {
  1: 'Toxic',
  2: 'Careless',
  3: 'Dull',
  4: 'Expected',
  5: 'Capable',
  6: 'Gratifying',
  7: 'Original',
  8: 'Best in category',
  9: 'Best in show',
  10: 'Best in the world'
};

const TIER_EMOTION = {
  1: ['happy', 'sad', 'angry', 'excited', 'positive'],
  2: ['nostalgic', 'defiant', 'proud', 'amused', 'curious', 'tender'],
  3: ['bittersweet pride', 'ironic sincerity', 'vulnerable defiance', 'reluctant hope', 'angry love', 'tender shame', 'absurd longing']
};

function emotionTierFor(emotionWord) {
  const w = (emotionWord || '').toLowerCase();
  for (let tier = 3; tier >= 1; tier--) {
    if (TIER_EMOTION[tier].some((kw) => w.includes(kw))) return tier;
  }
  return 1;
}

function computeWeightedScore(scores) {
  let total = 0;
  for (const [k, conf] of Object.entries(SIX_CRITERIA)) {
    total += (Number(scores[k]) || 0) * conf.weight;
  }
  return Math.round(total * 10) / 10;
}

function gapAnalysis(weightedScore, humankindScore) {
  if (weightedScore >= 8 && humankindScore < 7) return { diagnosis: 'clever_but_doesnt_matter', action: 'strengthen human purpose, find tension' };
  if (weightedScore < 7 && humankindScore >= 8) return { diagnosis: 'matters_but_boring', action: 'strengthen craft, originality, surprise' };
  if (weightedScore >= 8 && humankindScore >= 8) return { diagnosis: 'strong_candidate', action: 'check scalability, polish' };
  return { diagnosis: 'restart', action: 'different HMW, different methods' };
}

const STOPPING_CRITERIA = {
  exit_success: 'top idea weighted ≥ 9.0 AND HumanKind ≥ 7 → run pre-mortem then exit to articulate',
  exit_attempts: '5 passes completed → deliver best with honest assessment',
  exit_plateau: '2 consecutive passes with delta < 0.2 → convergence, deliver with note'
};

function calibrationText() {
  const sixLines = Object.entries(SIX_CRITERIA).map(([k, c]) => `- ${k} (${c.weight * 100}%): ${c.gate}`).join('\n');
  const hkLines = Object.entries(HUMANKIND_SCALE).map(([n, l]) => `${n} = ${l}`).join('\n');
  const greyLines = Object.entries(GREY_SCALE).map(([n, l]) => `${n} = ${l}`).join('\n');
  return `SIX WEIGHTED CRITERIA (idea strength, output as 1-10 each):
${sixLines}

HUMANKIND SCALE (output 1-10):
${hkLines}

GREY SCALE (output 1-10, double-check against HumanKind — divergence > 1.5 means revisit):
${greyLines}

EMOTION TIER RULE:
Score Tier 1 ≤ 6 only. Score Tier 3 to reach 9-10. Examples:
Tier 1 (generic): ${TIER_EMOTION[1].join(', ')}
Tier 2 (specific): ${TIER_EMOTION[2].join(', ')}
Tier 3 (complex): ${TIER_EMOTION[3].join(', ')}

GAP ANALYSIS RULES:
- Weighted ≥ 8 + HumanKind < 7 → "clever but doesn't matter" — strengthen human purpose
- Weighted < 7 + HumanKind ≥ 8 → "matters but boring" — strengthen craft, originality, surprise
- Both ≥ 8 → strong candidate, polish for scalability
- Both < 7 → restart with different HMW

STOPPING CRITERIA:
${Object.values(STOPPING_CRITERIA).map((s) => `- ${s}`).join('\n')}`;
}

module.exports = {
  SIX_CRITERIA,
  HUMANKIND_SCALE,
  GREY_SCALE,
  TIER_EMOTION,
  STOPPING_CRITERIA,
  emotionTierFor,
  computeWeightedScore,
  gapAnalysis,
  calibrationText
};
