'use strict';

/**
 * services/stripe/index.js
 * ----------------------------------------------------------------------------
 * Stripe webhook handler — parallel to the existing Paddle handler so Maroa
 * accepts payments from EITHER provider depending on the customer's region:
 *
 *   Paddle  — better global VAT handling, primary for EU/UK
 *   Stripe  — better US/CA UX, easier customer disputes
 *
 * Critical Stripe events we handle:
 *   checkout.session.completed     — first paid signup → fire cold-start
 *   customer.subscription.created  — explicit subscription activation
 *   customer.subscription.updated  — plan change → update businesses.plan
 *   customer.subscription.deleted  — cancel → downgrade to free
 *   invoice.payment_failed          — failed renewal → downgrade
 *   invoice.payment_succeeded       — successful renewal → log usage
 *
 * Signature verification: Stripe uses HMAC-SHA256 over `${timestamp}.${rawBody}`.
 * We verify against STRIPE_WEBHOOK_SECRET.
 *
 * Env required:
 *   STRIPE_SECRET_KEY            (for any direct API calls)
 *   STRIPE_WEBHOOK_SECRET        (for signature verification)
 *   STRIPE_GROWTH_PRICE_ID       (already in env per user's Railway list)
 *   STRIPE_AGENCY_PRICE_ID       (already in env)
 *
 * Public API:
 *   verifyStripeSignature(rawBody, signatureHeader, secret) → boolean
 *   handleStripeEvent({ event, sbGet, sbPatch, sbPost, sendEmail, logger,
 *                       internalSecret, port })
 *     Fire-and-forget. Maps Stripe event → business action.
 *     Auto-triggers cold-start on first paid activation (mirror of Paddle).
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

const STRIPE_PRICE_TO_PLAN = {};
if (process.env.STRIPE_GROWTH_PRICE_ID) STRIPE_PRICE_TO_PLAN[process.env.STRIPE_GROWTH_PRICE_ID] = 'growth';
if (process.env.STRIPE_AGENCY_PRICE_ID) STRIPE_PRICE_TO_PLAN[process.env.STRIPE_AGENCY_PRICE_ID] = 'agency';

/**
 * Verify Stripe-Signature header (HMAC-SHA256 over `${timestamp}.${rawBody}`).
 * Tolerates clock skew up to 5 minutes.
 */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret || !rawBody) return false;
  const parts = String(sigHeader).split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;

  // 5-minute tolerance window
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const signed = `${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString() : rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');

  // Constant-time compare against each provided signature (Stripe rotates)
  return signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
}

/**
 * Map a Stripe event to business actions. Returns a summary; caller decides
 * whether to await side effects.
 */
async function handleStripeEvent({ event, sbGet, sbPatch, sbPost, sendEmail, logger, internalSecret, port = 3000 }) {
  if (!event?.type || !event?.data?.object) return { ok: false, reason: 'malformed_event' };
  const t = event.type;
  const obj = event.data.object;
  const result = { ok: true, event_type: t, actions: [] };

  try {
    // ── checkout.session.completed → first paid signup ──
    if (t === 'checkout.session.completed' || t === 'customer.subscription.created') {
      const businessId = obj.metadata?.business_id || obj.client_reference_id;
      const priceId = obj.items?.data?.[0]?.price?.id || obj.line_items?.data?.[0]?.price?.id;
      const plan = obj.metadata?.plan || STRIPE_PRICE_TO_PLAN[priceId] || 'starter';
      if (!businessId) {
        result.actions.push({ skipped: 'no business_id in metadata' });
        return result;
      }

      // Check prior plan to determine if this is FIRST paid activation
      const priorRows = await sbGet('businesses', `id=eq.${businessId}&select=plan`).catch(() => []);
      const priorPlan = priorRows?.[0]?.plan || 'free';
      const wasOnFreeOrUnpaid = priorPlan === 'free' || priorPlan === 'starter' || !priorPlan;
      const isNowPaid = plan === 'growth' || plan === 'agency';

      await sbPatch('businesses', `id=eq.${businessId}`, {
        plan,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.subscription || obj.id,
      });
      result.actions.push({ plan_updated: plan });

      // Auto-trigger cold-start on first paid activation
      if (wasOnFreeOrUnpaid && isNowPaid) {
        try {
          fetch(`http://127.0.0.1:${port}/webhook/cold-start-trigger`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(internalSecret ? { 'x-webhook-secret': internalSecret } : {}),
            },
            body: JSON.stringify({ businessId, source: 'stripe_checkout_completed', plan }),
          }).catch((e) =>
            logger?.warn?.('/stripe/webhook', businessId, 'cold-start trigger failed', { error: e.message })
          );
          result.actions.push({ cold_start_triggered: true });
          await sbPost?.('onboarding_events', {
            business_id: businessId,
            event_type: 'cold_start_auto_triggered',
            event_data: { source: 'stripe', plan, prior_plan: priorPlan },
          }).catch(() => {});
        } catch (e) {
          logger?.warn?.('/stripe/webhook', businessId, 'cold-start trigger threw', { error: e.message });
        }
      }
      return result;
    }

    // ── customer.subscription.updated ──
    if (t === 'customer.subscription.updated') {
      const businessId = obj.metadata?.business_id;
      const priceId = obj.items?.data?.[0]?.price?.id;
      const plan = obj.metadata?.plan || STRIPE_PRICE_TO_PLAN[priceId] || null;
      if (businessId && plan) {
        await sbPatch('businesses', `id=eq.${businessId}`, { plan });
        result.actions.push({ plan_updated: plan });
      }
      return result;
    }

    // ── customer.subscription.deleted → downgrade to free ──
    if (t === 'customer.subscription.deleted') {
      const businessId = obj.metadata?.business_id;
      if (businessId) {
        await sbPatch('businesses', `id=eq.${businessId}`, { plan: 'free' });
        result.actions.push({ plan_downgraded: 'free' });
      } else {
        // Fallback: find by stripe_subscription_id
        const rows = await sbGet('businesses', `stripe_subscription_id=eq.${obj.id}&select=id`).catch(() => []);
        if (rows[0]) {
          await sbPatch('businesses', `id=eq.${rows[0].id}`, { plan: 'free' });
          result.actions.push({ plan_downgraded_by_subscription_lookup: 'free' });
        }
      }
      return result;
    }

    // ── invoice.payment_failed → downgrade after grace period ──
    if (t === 'invoice.payment_failed') {
      // Stripe retries up to 4 times before marking the subscription
      // unrecoverable. We downgrade only if attempt_count >= 4.
      const businessId = obj.subscription_details?.metadata?.business_id;
      const attempts = obj.attempt_count || 1;
      if (businessId && attempts >= 4) {
        await sbPatch('businesses', `id=eq.${businessId}`, { plan: 'free', plan_price: 0 });
        result.actions.push({ plan_downgraded_after_retries: attempts });
        logger?.warn?.('/stripe/webhook', businessId, `Payment failed ${attempts}× — downgraded to free`);
      } else {
        result.actions.push({ payment_retry_pending: attempts });
      }
      return result;
    }

    // ── invoice.payment_succeeded → log usage ──
    if (t === 'invoice.payment_succeeded') {
      const businessId = obj.subscription_details?.metadata?.business_id;
      if (businessId) {
        await sbPost?.('usage_logs', {
          user_id: businessId,
          action: 'stripe_invoice_paid',
          plan_name: STRIPE_PRICE_TO_PLAN[obj.lines?.data?.[0]?.price?.id] || 'unknown',
          model_used: 'stripe',
          credits_used: 0,
          status: 'success',
        }).catch(() => {});
      }
      return result;
    }

    return result;
  } catch (err) {
    logger?.error?.('/stripe/webhook', null, 'handler crashed', { error: err.message });
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  verifyStripeSignature,
  handleStripeEvent,
  STRIPE_PRICE_TO_PLAN,
};
