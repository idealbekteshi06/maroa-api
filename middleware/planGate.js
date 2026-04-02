// middleware/planGate.js — Feature access gates by plan
// Plans: free → growth → agency
// Usage: app.post('/route', planGate('multi_workspace'), handler)

'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zqhyrbttuqkvmdewiytf.supabase.co';
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();

// Feature → minimum plan(s) required
const PLAN_FEATURES = {
  multi_workspace:  ['agency'],
  paid_ads:         ['growth', 'agency'],
  white_label:      ['agency'],
  sms:              ['growth', 'agency'],
  competitor_intel: ['growth', 'agency'],
  api_access:       ['agency'],
  linkedin:         ['growth', 'agency'],
  twitter:          ['growth', 'agency'],
  tiktok:           ['growth', 'agency'],
  analytics:        ['growth', 'agency'],
  crm:              ['growth', 'agency'],
  long_form:        ['growth', 'agency'],
};

// Plan hierarchy — higher index = higher plan
const PLAN_RANK = { free: 0, starter: 1, growth: 2, agency: 3 };

async function getBusinessPlan(business_id) {
  const url = `${SUPABASE_URL}/rest/v1/businesses?select=plan&id=eq.${business_id}`;
  const resp = await fetch(url, {
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    }
  });
  const data = await resp.json();
  return data?.[0]?.plan || 'free';
}

// ── Main middleware factory ────────────────────────────────────────────────────
const planGate = (feature) => async (req, res, next) => {
  // Extract business_id from body, params, query — in that priority order
  const business_id =
    req.body?.business_id ||
    req.params?.business_id ||
    req.params?.id ||
    req.query?.business_id;

  if (!business_id) {
    return res.status(400).json({
      error: 'business_id required for plan verification',
      feature
    });
  }

  const allowedPlans = PLAN_FEATURES[feature];
  if (!allowedPlans) {
    // Unknown feature gate — allow through (fail open for unknown features)
    console.warn(`[planGate] Unknown feature: ${feature} — allowing through`);
    return next();
  }

  try {
    const plan = await getBusinessPlan(business_id);

    if (!allowedPlans.includes(plan)) {
      const minPlan = allowedPlans[0];
      return res.status(403).json({
        error:         'upgrade_required',
        feature,
        current_plan:  plan,
        required_plans: allowedPlans,
        message:       `This feature requires the ${minPlan} plan or higher. You are on the ${plan} plan.`,
        upgrade_url:   'https://maroa-ai-marketing-automator.lovable.app/billing'
      });
    }

    // Attach plan to request for downstream use
    req.business_plan = plan;
    req.business_id   = business_id;
    next();

  } catch (err) {
    console.error('[planGate] Error checking plan:', err.message);
    // Fail open — don't block users if plan check fails
    next();
  }
};

// ── Convenience: check plan inline (non-middleware) ───────────────────────────
planGate.check = async (business_id, feature) => {
  const allowed = PLAN_FEATURES[feature] || [];
  const plan    = await getBusinessPlan(business_id);
  return { allowed: allowed.includes(plan), plan, required: allowed };
};

planGate.features = PLAN_FEATURES;

module.exports = planGate;
