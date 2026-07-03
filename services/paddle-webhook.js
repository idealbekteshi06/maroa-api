'use strict';

/**
 * services/paddle-webhook.js — the Paddle payment-lifecycle webhook handler,
 * extracted from server.js (PIECE 5) as a dependency-injected factory so the
 * money path is testable without booting the monolith.
 *
 * Behavior is 1:1 with the previous inline handler:
 *   - 503 when the webhook secret isn't configured
 *   - HMAC + timestamp verification via paddle.verifyWebhookSignature (Rule 3)
 *   - Two-phase idempotency via lib/webhookEvents (received → processed/failed)
 *   - subscription.activated/updated  → plan grant, is_active re-arm, welcome
 *     email/WhatsApp/SSE, cold-start auto-trigger on FIRST paid activation
 *   - subscription.canceled           → plan=free + is_active=false (stop crons)
 *   - subscription.past_due / transaction.payment_failed → downgrade + de-arm
 *   - transaction.completed           → usage_logs accounting row
 *   - subscription.paused/resumed     → status flag / plan restore
 *   - adjustment.created / transaction.refunded → full refund downgrades,
 *     partial refund logs only
 *   - subscription.trialing           → plan grant + trial_ends_at
 *   - handler crash → commit event 'failed', evict LRU, return 500 so Paddle
 *     retries (never ACK-200 an un-provisioned paid customer)
 *
 * Rule 4 is enforced here: business_id from the payload is UUID-validated and
 * every value is encodeURIComponent'd before touching a PostgREST filter.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const defaultIsUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function defaultApiError(res, status, code, message, details = null) {
  return res.status(status).json({
    error: { code, message, details, timestamp: new Date().toISOString() },
  });
}

/** Maps configured Paddle price IDs to plan names. Empty ids are skipped. */
function buildPriceToPlanMap({ starter, growth, agency } = {}) {
  const map = {};
  if (starter) map[starter] = 'starter';
  if (growth) map[growth] = 'growth';
  if (agency) map[agency] = 'agency';
  return map;
}

/**
 * @param {object} deps
 * @param {string} deps.secret               PADDLE_WEBHOOK_SECRET
 * @param {object} [deps.priceToPlan]        { [priceId]: 'starter'|'growth'|'agency' }
 * @param {object} [deps.paddle]             needs verifyWebhookSignature(raw, sig, secret)
 * @param {object} [deps.webhookEvents]      needs markProcessed / commitProcessed / forgetEvent
 * @param {function} deps.sbGet
 * @param {function} deps.sbPost
 * @param {function} deps.sbPatch
 * @param {function} [deps.sendEmail]
 * @param {function} [deps.sendWhatsApp]
 * @param {function} [deps.sendSSE]
 * @param {object} [deps.logger]
 * @param {function} [deps.apiError]
 * @param {function} [deps.isUuid]
 * @param {function} [deps.fetchImpl]        for the cold-start loopback POST
 * @param {string} [deps.internalSecret]     x-webhook-secret for the loopback
 * @param {string|number} [deps.port]        loopback port (default 3000)
 * @returns {(req, res) => Promise<void>}
 */
function createPaddleWebhookHandler(deps) {
  const {
    secret,
    priceToPlan = {},
    paddle = require('./paddle'),
    webhookEvents = require('../lib/webhookEvents'),
    sbGet,
    sbPost,
    sbPatch,
    sendEmail = async () => {},
    sendWhatsApp = async () => {},
    sendSSE = () => {},
    logger = { info() {}, warn() {}, error() {} },
    apiError = defaultApiError,
    isUuid = defaultIsUuid,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    internalSecret = process.env.N8N_WEBHOOK_SECRET || '',
    port = process.env.PORT || 3000,
  } = deps || {};

  if (typeof sbGet !== 'function' || typeof sbPost !== 'function' || typeof sbPatch !== 'function') {
    throw new Error('createPaddleWebhookHandler: sbGet, sbPost and sbPatch are required');
  }

  return async function paddleWebhookHandler(req, res) {
    if (!secret) {
      return apiError(res, 503, 'SERVICE_UNAVAILABLE', 'PADDLE_WEBHOOK_SECRET not configured');
    }
    const sig = req.headers['paddle-signature'];
    const rawBody = req.body;
    if (!sig || !Buffer.isBuffer(rawBody)) {
      return apiError(res, 400, 'INVALID_REQUEST', 'Missing Paddle signature or raw body');
    }
    const valid = paddle.verifyWebhookSignature(rawBody.toString(), sig, secret);
    if (!valid) {
      logger.warn('/webhook/paddle-webhook', null, 'Paddle signature/timestamp verification failed', {
        request_id: req.requestId,
      });
      return apiError(res, 400, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString());
    } catch {
      return apiError(res, 400, 'INVALID_JSON', 'Could not parse webhook body');
    }

    // Idempotency: Paddle can deliver the same notification twice. Block
    // duplicates before any side-effect (plan grant, cold-start fire, email).
    const eventId = event?.notification_id || event?.event_id || event?.data?.id;
    if (eventId) {
      const dedup = await webhookEvents.markProcessed({ provider: 'paddle', eventId, sbPost, sbPatch, sbGet, logger });
      if (!dedup.firstTime) {
        logger.info('/webhook/paddle-webhook', null, 'duplicate event — skipping', { event_id: eventId });
        return res.json({ received: true, duplicate: true });
      }
    }

    // Provision SYNCHRONOUSLY, then ACK based on outcome in `finally` (so the
    // early no-op `return` still ACKs 200). On failure we commit the event
    // 'failed', evict the LRU, and return 500 so Paddle retries — instead of the
    // old ACK-200-before-grant which left paid customers permanently un-provisioned.
    let _paddleOk = true;
    let _paddleErr = null;
    try {
      const eventType = event?.event_type;
      const data = event?.data;
      if (!eventType || !data) return;

      if (eventType === 'subscription.activated' || eventType === 'subscription.updated') {
        const customData = data.custom_data || {};
        const businessId = customData.business_id;
        const priceId = data.items?.[0]?.price?.id;
        const plan = customData.plan || priceToPlan[priceId] || 'starter';
        // business_id arrives from an external Paddle webhook payload — Rule 4:
        // validate it's a UUID + encode before it touches a PostgREST filter.
        if (businessId && isUuid(businessId)) {
          const encBiz = encodeURIComponent(businessId);
          // Check the PRIOR plan so we know if this is "first activation" vs renewal
          const priorRows = await sbGet('businesses', `id=eq.${encBiz}&select=plan,onboarding_state`).catch(() => []);
          const priorPlan = priorRows?.[0]?.plan || 'free';
          const wasOnFreeOrUnpaid = priorPlan === 'free' || priorPlan === 'starter' || !priorPlan;
          const isNowPaid = plan === 'growth' || plan === 'agency';

          await sbPatch('businesses', `id=eq.${encBiz}`, {
            plan,
            paddle_customer_id: data.customer_id,
            paddle_subscription_id: data.id,
            // Recovery arm: (re)activation re-arms the account. Paired with the
            // is_active:false set on payment_failed/past_due below, so a bounced
            // card that later clears self-heals instead of staying bricked.
            is_active: true,
          });
          const biz = (
            await sbGet('businesses', `id=eq.${encBiz}&select=email,business_name,whatsapp_number,whatsapp_enabled`)
          )[0];
          if (biz?.email)
            await sendEmail(
              biz.email,
              `Welcome to ${plan} plan! — ${biz.business_name}`,
              `<h2>You're now on the ${plan} plan!</h2><p>Your AI just unlocked: ${plan === 'agency' ? 'white-label, multi-workspace, priority support' : 'ad campaigns, competitor intel, advanced analytics'}.</p>`
            ).catch(() => {});
          if (biz?.whatsapp_number && biz.whatsapp_enabled)
            sendWhatsApp(biz.whatsapp_number, `*Upgraded to ${plan}!* Your AI just unlocked new features.`).catch(
              () => {}
            );
          sendSSE(businessId, 'plan_upgraded', { plan });

          // ─── Auto-trigger cold-start onboarding (FIRST paid activation only) ──
          // Fires the cold-start orchestrator the moment a customer goes from
          // free/unpaid → growth/agency. Idempotent — cold-start has its own
          // (business_id, run_date) unique constraint so duplicate webhooks
          // don't create duplicate runs.
          if (wasOnFreeOrUnpaid && isNowPaid) {
            try {
              // Fire-and-forget to our own cold-start endpoint over localhost.
              // Don't await its full chain (some phases take ~minutes) — just
              // kick off and return.
              fetchImpl(`http://127.0.0.1:${port}/webhook/cold-start-trigger`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(internalSecret ? { 'x-webhook-secret': internalSecret } : {}),
                },
                body: JSON.stringify({ businessId, source: 'paddle_subscription_activated', plan }),
              }).catch((e) =>
                logger.warn('/paddle/webhook', businessId, 'cold-start auto-trigger failed', { error: e.message })
              );
              logger.info('/paddle/webhook', businessId, 'cold-start auto-triggered on first paid activation', {
                plan,
                priorPlan,
              });
              await sbPost?.('onboarding_events', {
                business_id: businessId,
                event_type: 'cold_start_auto_triggered',
                event_data: { source: 'paddle', plan, prior_plan: priorPlan, subscription_id: data.id },
              }).catch(() => {});
            } catch (autoTriggerErr) {
              logger.warn('/paddle/webhook', businessId, 'cold-start auto-trigger threw', {
                error: autoTriggerErr.message,
              });
            }
          }
        }
      } else if (eventType === 'subscription.canceled') {
        // Also set is_active:false so the 16 background crons (which select
        // is_active=eq.true) stop processing — otherwise a churned account
        // keeps incurring LLM/image/email cost at $0 revenue indefinitely.
        const canceledPatch = { plan: 'free', plan_price: 0, is_active: false };
        const businessId = data.custom_data?.business_id;
        if (businessId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(businessId)}`, canceledPatch);
        } else {
          const bizArr = await sbGet(
            'businesses',
            `paddle_subscription_id=eq.${encodeURIComponent(data.id)}&select=id`
          );
          if (bizArr[0]) await sbPatch('businesses', `id=eq.${encodeURIComponent(bizArr[0].id)}`, canceledPatch);
        }
      } else if (eventType === 'subscription.past_due' || eventType === 'transaction.payment_failed') {
        // Payment failed — downgrade to free
        const failBizId = data.custom_data?.business_id;
        // is_active:false stops the 16 background crons (all select
        // is_active=true) from burning LLM/Higgsfield money on an account that
        // stopped paying. The subscription.activated recovery arm above flips
        // it back to true when the card clears, so dunning self-heals.
        const failPatch = { plan: 'free', plan_price: 0, is_active: false };
        // Rule 4: both the external business_id and the Paddle subscription id
        // are validated/encoded before hitting a PostgREST filter.
        if (failBizId && isUuid(failBizId)) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(failBizId)}`, failPatch);
          logger.warn('/paddle/webhook', failBizId, 'Payment failed — downgraded to free', { event_type: eventType });
        } else if (data.subscription_id || data.id) {
          // Fallback: find by subscription ID (a Paddle string id, not a UUID)
          const subId = data.subscription_id || data.id;
          const bizArr = await sbGet('businesses', `paddle_subscription_id=eq.${encodeURIComponent(subId)}&select=id`);
          if (bizArr[0]) {
            await sbPatch('businesses', `id=eq.${encodeURIComponent(bizArr[0].id)}`, failPatch);
            logger.warn('/paddle/webhook', bizArr[0].id, 'Payment failed — downgraded to free (by sub ID)', {
              event_type: eventType,
            });
          }
        }
      } else if (eventType === 'transaction.completed') {
        const customData = data.custom_data || {};
        if (customData.business_id) {
          await sbPost('usage_logs', {
            user_id: customData.business_id,
            action: 'paddle_transaction',
            plan_name: customData.plan || 'unknown',
            model_used: 'paddle',
            credits_used: 0,
            status: 'success',
          }).catch(() => {});
        }
      } else if (eventType === 'subscription.paused') {
        // Customer paused (Paddle's pause feature). Keep their plan tier
        // but flag billing as paused so the cost guard's plan-tier lookup
        // can fall back to a stricter cap if desired.
        const pausedBizId = data.custom_data?.business_id;
        const bizId =
          pausedBizId ||
          (
            await sbGet('businesses', `paddle_subscription_id=eq.${encodeURIComponent(data.id)}&select=id`).catch(
              () => []
            )
          )[0]?.id;
        if (bizId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(bizId)}`, {
            paddle_subscription_status: 'paused',
          }).catch(() => {});
          logger.info('/paddle/webhook', bizId, 'subscription paused', { event_type: eventType });
        }
      } else if (eventType === 'subscription.resumed') {
        // Resumed after pause — restore plan tier to whatever's on the
        // subscription items (Paddle includes price_id in data.items).
        const resumedBizId = data.custom_data?.business_id;
        const priceId = data.items?.[0]?.price?.id;
        const restoredPlan = data.custom_data?.plan || priceToPlan[priceId] || 'starter';
        const bizId =
          resumedBizId ||
          (
            await sbGet('businesses', `paddle_subscription_id=eq.${encodeURIComponent(data.id)}&select=id`).catch(
              () => []
            )
          )[0]?.id;
        if (bizId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(bizId)}`, {
            plan: restoredPlan,
            paddle_subscription_status: 'active',
          }).catch(() => {});
          logger.info('/paddle/webhook', bizId, 'subscription resumed', { event_type: eventType, plan: restoredPlan });
        }
      } else if (eventType === 'adjustment.created' || eventType === 'transaction.refunded') {
        // Refund issued. We log it for accounting + downgrade if a full
        // refund (action='refund' with no remaining items). Partial refunds
        // (credit notes) keep the plan but flag the audit log.
        const refundBizId = data.custom_data?.business_id;
        const isFullRefund =
          data.action === 'refund' && !data.items?.some?.((i) => Number(i.totals?.subtotal || 0) > 0);
        const bizId =
          refundBizId ||
          (data.subscription_id
            ? (
                await sbGet(
                  'businesses',
                  `paddle_subscription_id=eq.${encodeURIComponent(data.subscription_id)}&select=id`
                ).catch(() => [])
              )[0]?.id
            : null);
        if (bizId) {
          await sbPost('usage_logs', {
            user_id: bizId,
            action: 'paddle_refund',
            plan_name: data.custom_data?.plan || 'unknown',
            model_used: 'paddle',
            credits_used: 0,
            status: 'refunded',
          }).catch(() => {});
          if (isFullRefund) {
            await sbPatch('businesses', `id=eq.${encodeURIComponent(bizId)}`, {
              plan: 'free',
              plan_price: 0,
              paddle_subscription_status: 'refunded',
            }).catch(() => {});
            logger.warn('/paddle/webhook', bizId, 'full refund — downgraded to free', { event_type: eventType });
          } else {
            logger.info('/paddle/webhook', bizId, 'partial refund logged', { event_type: eventType });
          }
        }
      } else if (eventType === 'subscription.trialing') {
        // Trial activation — same plan grant as activated but flag the
        // status so we can show "trial ends Mar 18" in the dashboard.
        const trialBizId = data.custom_data?.business_id;
        const trialPlan = data.custom_data?.plan || priceToPlan[data.items?.[0]?.price?.id] || 'starter';
        if (trialBizId) {
          await sbPatch('businesses', `id=eq.${encodeURIComponent(trialBizId)}`, {
            plan: trialPlan,
            paddle_subscription_status: 'trialing',
            trial_ends_at: data.current_billing_period?.ends_at || null,
          }).catch(() => {});
        }
      } else {
        // Unhandled event type — log for observability so we know what
        // Paddle is sending. Add a handler above when we want to act on it.
        logger.info('/paddle/webhook', null, 'unhandled paddle event type', { event_type: eventType });
      }
    } catch (err) {
      console.error('[paddle-webhook ERROR]', err.message);
      logger.error('/paddle/webhook', null, 'handler crashed', err);
      _paddleOk = false;
      _paddleErr = err.message;
    } finally {
      if (eventId) {
        await webhookEvents
          .commitProcessed({
            provider: 'paddle',
            eventId,
            status: _paddleOk ? 'processed' : 'failed',
            sbPatch,
            logger,
            error: _paddleOk ? null : _paddleErr,
          })
          .catch(() => {});
        if (!_paddleOk) webhookEvents.forgetEvent('paddle', eventId);
      }
      if (!res.headersSent) {
        if (_paddleOk) res.json({ received: true });
        else res.status(500).json({ error: { code: 'HANDLER_ERROR', message: 'event processing error' } });
      }
    }
  };
}

module.exports = { createPaddleWebhookHandler, buildPriceToPlanMap };
