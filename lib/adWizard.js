'use strict';

/**
 * lib/adWizard.js
 * ----------------------------------------------------------------------------
 * Shared helpers for the Paid Ads guided wizard (Meta / Google / TikTok).
 *
 * The frontend hub sends an optional `wizard` object on campaign-create:
 *   { objective, target_audience, age_range, locations[], daily_budget,
 *     duration_days, offer }
 *
 * These helpers normalize the untrusted body into a bounded shape and render
 * it as a hard-constraint block for the Claude strategy prompt. User-specified
 * answers must OVERRIDE the AI's own guesses — the prompt block says so
 * explicitly, and callers use wizardDailyBudget() to force the budget field.
 *
 * Backwards compatible: normalizeWizard(undefined) → null, and callers keep
 * their pre-wizard behavior when null.
 * ----------------------------------------------------------------------------
 */

function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * Normalize an untrusted wizard body into a bounded, typed object.
 * Returns null when nothing usable was provided (absent wizard = legacy path).
 */
function normalizeWizard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};

  const objective = cleanStr(raw.objective, 200);
  if (objective) out.objective = objective;

  const audience = cleanStr(raw.target_audience, 500);
  if (audience) out.target_audience = audience;

  // age_range accepted as "25-44" or [25, 44]
  if (Array.isArray(raw.age_range) && raw.age_range.length === 2) {
    const lo = Number(raw.age_range[0]);
    const hi = Number(raw.age_range[1]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) out.age_range = `${Math.round(lo)}-${Math.round(hi)}`;
  } else {
    const ar = cleanStr(raw.age_range, 20);
    if (ar) out.age_range = ar;
  }

  if (Array.isArray(raw.locations)) {
    const locs = raw.locations
      .map((l) => cleanStr(l, 100))
      .filter(Boolean)
      .slice(0, 20);
    if (locs.length) out.locations = locs;
  }

  const budget = Number(raw.daily_budget);
  if (Number.isFinite(budget) && budget > 0) out.daily_budget = Math.round(budget * 100) / 100;

  const duration = Number(raw.duration_days);
  if (Number.isFinite(duration) && duration >= 1 && duration <= 365) out.duration_days = Math.round(duration);

  const offer = cleanStr(raw.offer, 300);
  if (offer) out.offer = offer;

  return Object.keys(out).length ? out : null;
}

/**
 * The user's daily budget, or null when the wizard didn't specify one.
 */
function wizardDailyBudget(wizard) {
  if (!wizard || !Number.isFinite(Number(wizard.daily_budget)) || Number(wizard.daily_budget) <= 0) return null;
  return Number(wizard.daily_budget);
}

/**
 * Render the wizard answers as an explicit-constraint block for the strategy
 * prompt. Returns '' when no wizard — safe to interpolate unconditionally.
 */
function wizardPromptBlock(wizard) {
  if (!wizard) return '';
  const lines = [];
  if (wizard.objective) lines.push(`- Campaign objective: ${wizard.objective}`);
  if (wizard.target_audience) lines.push(`- Target audience: ${wizard.target_audience}`);
  if (wizard.age_range) lines.push(`- Age range: ${wizard.age_range}`);
  if (wizard.locations) lines.push(`- Locations: ${wizard.locations.join(', ')}`);
  if (wizard.daily_budget) lines.push(`- Daily budget: $${wizard.daily_budget}/day (use EXACTLY this daily budget)`);
  if (wizard.duration_days) lines.push(`- Campaign duration: ${wizard.duration_days} days`);
  if (wizard.offer) lines.push(`- Offer / promo to feature: ${wizard.offer}`);
  if (!lines.length) return '';
  return `
USER-SPECIFIED CAMPAIGN SETTINGS (from the setup wizard — these are HARD CONSTRAINTS.
They OVERRIDE any defaults above and your own recommendations. You MUST respect them exactly):
${lines.join('\n')}
`;
}

module.exports = { normalizeWizard, wizardDailyBudget, wizardPromptBlock };
