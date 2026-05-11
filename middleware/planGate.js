// middleware/planGate.js — Feature access gates by plan
// Plans (matching live DB + CLAUDE.md): free($0) · growth($49) · agency($99)
// Usage: app.post('/webhook/org-create', planGate('multi_workspace'), handler)

'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/[^\x20-\x7E]/g, '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || '').replace(/[^\x20-\x7E]/g, '').trim();

// Strict UUID v1-v5. Anything that doesn't match is rejected before it can
// touch the PostgREST filter — closes the injection vector where a crafted
// business_id like `00000000-...&select=*,plan_history(*)` would alter the
// query shape. Doing this client-side is cheaper than a server roundtrip.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// ── Feature gates — which plans unlock each feature ──────────────────────────
const PLAN_FEATURES = {
  // Agency-only
  multi_workspace: ['agency'],
  white_label: ['agency'],
  api_access: ['agency'],
  // Growth + Agency
  paid_ads: ['growth', 'agency'],
  sms: ['growth', 'agency'],
  competitor_intel: ['growth', 'agency'],
  analytics: ['growth', 'agency'],
  crm: ['growth', 'agency'],
  long_form: ['growth', 'agency'],
  linkedin: ['growth', 'agency'],
  twitter: ['growth', 'agency'],
  tiktok: ['growth', 'agency'],
};

// ── Fetch plan from Supabase ──────────────────────────────────────────────────
async function getBusinessPlan(business_id) {
  // Defensive — caller is expected to UUID-validate, but never let an
  // unvalidated id touch the filter. encodeURIComponent stops `&`/`,`/`(` from
  // breaking out of the value.
  if (!isUuid(business_id)) throw new Error('invalid business_id');
  const safeId = encodeURIComponent(business_id);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/businesses?select=plan&id=eq.${safeId}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const data = await res.json();
  return data?.[0]?.plan || 'free';
}

// ── Main middleware factory ────────────────────────────────────────────────────
const planGate = (feature) => async (req, res, next) => {
  // Accept business_id from body, params, or query — in that priority
  const business_id = req.body?.business_id || req.params?.business_id || req.params?.id || req.query?.business_id;

  if (!business_id) {
    return res.status(400).json({ error: 'business_id required', feature });
  }
  if (!isUuid(business_id)) {
    return res.status(400).json({ error: 'business_id must be a valid UUID', feature });
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
        error: 'upgrade_required',
        feature,
        current_plan: plan,
        required_plans: allowedPlans,
        message: `The "${feature}" feature requires the ${allowedPlans[0]} plan or higher. You are on the "${plan}" plan.`,
        upgrade_url: 'https://maroa-ai-marketing-automator.lovable.app/billing',
      });
    }

    // Attach to request for use in downstream handlers
    req.business_plan = plan;
    req.business_id = business_id;
    next();
  } catch (err) {
    // Fail closed — deny access to paid features if plan can't be verified
    console.error('[planGate] Error fetching plan — denying access:', err.message);
    return res.status(503).json({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Unable to verify plan. Please try again.' },
    });
  }
};

// ── Inline plan check (non-middleware helper) ─────────────────────────────────
planGate.check = async (business_id, feature) => {
  const allowed = PLAN_FEATURES[feature] || [];
  const plan = await getBusinessPlan(business_id);
  return { allowed: allowed.includes(plan), plan, required: allowed };
};

planGate.FEATURES = PLAN_FEATURES;

module.exports = planGate;
