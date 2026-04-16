// middleware/planGate.js — Feature access gates by plan
// Plans (matching live DB + CLAUDE.md): free($0) · growth($49) · agency($99)
// Usage: app.post('/webhook/org-create', planGate('multi_workspace'), handler)

'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zqhyrbttuqkvmdewiytf.supabase.co';
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();

// ── Feature gates — which plans unlock each feature ──────────────────────────
const PLAN_FEATURES = {
  // Agency-only
  multi_workspace:  ['agency'],
  white_label:      ['agency'],
  api_access:       ['agency'],
  // Growth + Agency
  paid_ads:         ['growth', 'agency'],
  sms:              ['growth', 'agency'],
  competitor_intel: ['growth', 'agency'],
  analytics:        ['growth', 'agency'],
  crm:              ['growth', 'agency'],
  long_form:        ['growth', 'agency'],
  linkedin:         ['growth', 'agency'],
  twitter:          ['growth', 'agency'],
  tiktok:           ['growth', 'agency'],
};

// ── Fetch plan from Supabase ──────────────────────────────────────────────────
async function getBusinessPlan(business_id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/businesses?select=plan&id=eq.${business_id}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const data = await res.json();
  return data?.[0]?.plan || 'free';
}

// ── Main middleware factory ────────────────────────────────────────────────────
const planGate = (feature) => async (req, res, next) => {
  // Accept business_id from body, params, or query — in that priority
  const business_id =
    req.body?.business_id    ||
    req.params?.business_id  ||
    req.params?.id           ||
    req.query?.business_id;

  if (!business_id) {
    return res.status(400).json({ error: 'business_id required', feature });
  }

  const allowedPlans = PLAN_FEATURES[feature];
  if (!allowedPlans) {
    // Unknown feature — fail open so new features don't break
    console.warn(`[planGate] Unknown feature: "${feature}" — passing through`);
    return next();
  }

  try {
    const plan = await getBusinessPlan(business_id);

    if (!allowedPlans.includes(plan)) {
      return res.status(403).json({
        error:          'upgrade_required',
        feature,
        current_plan:   plan,
        required_plans: allowedPlans,
        message:        `The "${feature}" feature requires the ${allowedPlans[0]} plan or higher. You are on the "${plan}" plan.`,
        upgrade_url:    'https://maroa-ai-marketing-automator.lovable.app/billing'
      });
    }

    // Attach to request for use in downstream handlers
    req.business_plan = plan;
    req.business_id   = business_id;
    next();

  } catch (err) {
    // Fail closed — deny access to paid features if plan can't be verified
    console.error('[planGate] Error fetching plan — denying access:', err.message);
    return res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Unable to verify plan. Please try again.' }
    });
  }
};

// ── Inline plan check (non-middleware helper) ─────────────────────────────────
planGate.check = async (business_id, feature) => {
  const allowed = PLAN_FEATURES[feature] || [];
  const plan    = await getBusinessPlan(business_id);
  return { allowed: allowed.includes(plan), plan, required: allowed };
};

planGate.FEATURES = PLAN_FEATURES;

module.exports = planGate;
