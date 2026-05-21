// middleware/planGate.js — Feature access gates by plan
// Plans (live /api/billing/plans): starter($29) · growth($59) · agency($99)
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

// ── Fetch plan + owner from Supabase ─────────────────────────────────────────
// Returns { plan, user_id } so callers can verify the authenticated user
// actually owns this business before granting plan access. This is the
// fix for the IDOR vector flagged by the May-11 Antigravity review:
// previously planGate verified the business had the right plan but never
// verified the caller had the right business.
async function getBusinessPlanAndOwner(business_id, token) {
  // Defensive — caller is expected to UUID-validate, but never let an
  // unvalidated id touch the filter. encodeURIComponent stops `&`/`,`/`(` from
  // breaking out of the value.
  if (!isUuid(business_id)) throw new Error('invalid business_id');
  const safeId = encodeURIComponent(business_id);
  const authHeader = token ? `Bearer ${token}` : `Bearer ${SUPABASE_KEY}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/businesses?select=plan,user_id&id=eq.${safeId}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: authHeader },
  });
  const data = await res.json();
  const row = data?.[0] || null;
  return { plan: row?.plan || 'free', user_id: row?.user_id || null };
}

// Legacy single-value helper — kept for the planGate.check() public API
// where there's no req/user context.
async function getBusinessPlan(business_id) {
  const { plan } = await getBusinessPlanAndOwner(business_id);
  return plan;
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
    const authHeader = req.get('authorization') || '';
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = tokenMatch ? tokenMatch[1] : req.query?.token || null;

    const { plan, user_id: ownerId } = await getBusinessPlanAndOwner(business_id, token);

    // ─── IDOR protection ─────────────────────────────────────────────────
    // Verify the AUTHENTICATED caller actually owns this business_id. The
    // upstream auth middleware (requireAuthOrWebhookSecret) puts the JWT
    // user id at req.user.id when the request is JWT-auth. When the
    // request is webhook-secret-auth (req.authSource === 'webhook') we
    // skip ownership check because it's a trusted internal caller.
    //
    // Without this check, a Free-tier customer could pass an Agency
    // customer's business_id and get Agency-tier features. Documented
    // in ADR-0004 (added 2026-05-11) + flagged by the Antigravity
    // adversarial review.
    if (req.authSource !== 'webhook') {
      const jwtUserId = req.user?.id;
      if (!jwtUserId) {
        return res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'JWT required for plan-gated feature' },
        });
      }
      if (!ownerId) {
        // Business doesn't exist OR doesn't have a user_id (legacy data).
        // Fail closed — don't grant access to a business with no owner row.
        return res.status(403).json({
          error: { code: 'BUSINESS_NOT_FOUND', message: 'business_id not found or ownerless' },
        });
      }
      if (String(jwtUserId) !== String(ownerId)) {
        console.warn(
          `[planGate] IDOR attempt blocked — user ${jwtUserId} requested feature "${feature}" on business ${business_id} owned by ${ownerId}`
        );
        return res.status(403).json({
          error: { code: 'FORBIDDEN', message: 'You do not own this business' },
        });
      }
    }

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
