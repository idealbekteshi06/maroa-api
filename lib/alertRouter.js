'use strict';

/**
 * lib/alertRouter.js
 * ---------------------------------------------------------------------------
 * Multi-channel alert router for SLO violations + critical events.
 *
 * Why this exists: solo founder. Sentry exists, SLO monitor fires warnings,
 * but without explicit routing to a channel the founder watches in real
 * time, 3am incidents are silent failures until morning.
 *
 * This router fans out a single alert to all configured channels with
 * per-channel rate limiting (we don't want a Sentry spam storm becoming a
 * Slack spam storm). Each channel is independently optional — set the
 * env var, get the channel; don't set it, the router silently skips.
 *
 * Channels:
 *   - Slack          (SLACK_ALERT_WEBHOOK_URL)
 *   - Email          (ALERT_EMAIL_TO + existing sendEmail)
 *   - Sentry         (always — uses the existing client if loaded)
 *   - PagerDuty      (PAGERDUTY_INTEGRATION_KEY — for hard-paging)
 *
 * Severity routing:
 *   - 'info'      → Sentry breadcrumb only
 *   - 'warning'   → Sentry + Slack (no email, no page)
 *   - 'error'     → Sentry + Slack + Email
 *   - 'critical'  → Sentry + Slack + Email + PagerDuty (pages on-call)
 *
 * Rate limiting (per channel):
 *   - Same alert key fires at most once per 5 min on Slack/Email
 *   - Sentry has its own dedup (set fingerprint via tags)
 *   - PagerDuty has its own dedup (set dedup_key)
 *
 * Public API:
 *
 *   const router = createAlertRouter({ sendEmail, logger });
 *   await router.alert({
 *     key: 'slo:api_latency_p99',  // dedup key
 *     severity: 'warning',
 *     title: 'SLO violation: API latency p99',
 *     message: 'p99 is 1200ms (threshold 800ms)',
 *     extra: { current: 1200, threshold: 800 },
 *   });
 * ---------------------------------------------------------------------------
 */

const Sentry = (() => {
  try {
    return require('@sentry/node');
  } catch {
    return null;
  }
})();

const SEVERITIES = Object.freeze(['info', 'warning', 'error', 'critical']);
const RATE_LIMIT_MS = 5 * 60 * 1000;

function _validSeverity(s) {
  return SEVERITIES.includes(s);
}

function createAlertRouter({ sendEmail, logger, slackWebhookUrl, emailTo, pagerDutyKey } = {}) {
  const _slackUrl = slackWebhookUrl || process.env.SLACK_ALERT_WEBHOOK_URL || null;
  const _emailTo = emailTo || process.env.ALERT_EMAIL_TO || null;
  const _pdKey = pagerDutyKey || process.env.PAGERDUTY_INTEGRATION_KEY || null;

  const _rateLimitMap = new Map(); // key:channel → expiresAt

  function _isRateLimited(key, channel) {
    const k = `${key}:${channel}`;
    const expiresAt = _rateLimitMap.get(k);
    if (expiresAt && expiresAt > Date.now()) return true;
    _rateLimitMap.set(k, Date.now() + RATE_LIMIT_MS);
    return false;
  }

  async function _slack({ title, message, severity, extra }) {
    if (!_slackUrl) return { ok: false, reason: 'SLACK_ALERT_WEBHOOK_URL not set' };
    const emoji = severity === 'critical' ? ':rotating_light:' : severity === 'error' ? ':red_circle:' : ':warning:';
    try {
      const r = await fetch(_slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${emoji} *${title}*\n${message}${extra ? '\n```' + JSON.stringify(extra, null, 2) + '```' : ''}`,
        }),
      });
      return { ok: r.ok, status: r.status };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async function _email({ title, message, severity, extra }) {
    if (!sendEmail || !_emailTo) return { ok: false, reason: 'sendEmail or ALERT_EMAIL_TO missing' };
    const subject = `[Maroa ${severity.toUpperCase()}] ${title}`;
    const html = `<h2 style="color:${severity === 'critical' ? '#dc2626' : '#d97706'}">${title}</h2>
<p>${message.replace(/\n/g, '<br/>')}</p>
${extra ? `<pre>${JSON.stringify(extra, null, 2)}</pre>` : ''}
<hr/>
<p style="font-size:12px;color:#94a3b8">Sent by Maroa.ai alert router.</p>`;
    try {
      const r = await sendEmail(_emailTo, subject, html);
      return { ok: r?.sent !== false };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async function _pagerDuty({ key, title, message, severity, extra }) {
    if (!_pdKey || severity !== 'critical') {
      return {
        ok: false,
        reason: severity !== 'critical' ? 'severity below page threshold' : 'PAGERDUTY_INTEGRATION_KEY not set',
      };
    }
    try {
      const r = await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: _pdKey,
          event_action: 'trigger',
          dedup_key: key,
          payload: {
            summary: title,
            severity: 'critical',
            source: 'maroa.ai',
            custom_details: { message, ...extra },
          },
        }),
      });
      return { ok: r.ok, status: r.status };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  function _sentry({ title, message, severity, extra, key }) {
    if (!Sentry?.captureMessage) return { ok: false, reason: 'Sentry not loaded' };
    const level =
      severity === 'critical' ? 'fatal' : severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info';
    try {
      Sentry.captureMessage(title, {
        level,
        tags: { alert_router: 'true', alert_key: key },
        extra: { message, ...extra },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Fire an alert. Returns a summary of which channels accepted it.
   */
  async function alert({ key, severity, title, message, extra } = {}) {
    if (!key) throw new Error('alertRouter.alert: key required (for dedup)');
    if (!_validSeverity(severity)) {
      throw new Error(`alertRouter.alert: severity must be one of ${SEVERITIES.join(',')}`);
    }
    if (!title) throw new Error('alertRouter.alert: title required');
    if (!message) message = title;

    const results = {};

    // Sentry — always, no rate limit (its own dedup handles spam)
    results.sentry = _sentry({ title, message, severity, extra, key });

    // Slack — warning + above
    if (['warning', 'error', 'critical'].includes(severity) && !_isRateLimited(key, 'slack')) {
      results.slack = await _slack({ title, message, severity, extra });
    }

    // Email — error + above
    if (['error', 'critical'].includes(severity) && !_isRateLimited(key, 'email')) {
      results.email = await _email({ title, message, severity, extra });
    }

    // PagerDuty — critical only (pages on-call)
    if (severity === 'critical') {
      results.pagerduty = await _pagerDuty({ key, title, message, severity, extra });
    }

    logger?.info?.('alertRouter.alert', null, 'dispatched', { key, severity, results });
    return results;
  }

  function configured() {
    return {
      sentry: !!Sentry,
      slack: !!_slackUrl,
      email: !!sendEmail && !!_emailTo,
      pagerduty: !!_pdKey,
    };
  }

  function _resetRateLimits() {
    _rateLimitMap.clear();
  }

  return { alert, configured, _resetRateLimits };
}

module.exports = {
  createAlertRouter,
  SEVERITIES,
  RATE_LIMIT_MS,
};
