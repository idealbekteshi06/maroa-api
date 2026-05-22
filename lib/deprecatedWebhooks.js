'use strict';

/**
 * Returns 410 for retired n8n-era endpoints superseded by Inngest + autopilot.
 */

const RETIRED = {
  '/webhook/master-agent': 'Use POST /webhook/autopilot-brain-run (single business) or autopilot-brain-run-all (cron).',
  '/webhook/master-agent-all': 'Replaced by Inngest autopilot-brain-daily → /webhook/autopilot-brain-run-all.',
};

function deprecatedWebhooksMiddleware() {
  return (req, res, next) => {
    const hint = RETIRED[req.path];
    if (!hint) return next();
    return res.status(410).json({
      error: 'endpoint_retired',
      path: req.path,
      message: hint,
      docs: 'docs/INNGEST_ORCHESTRATION.md',
    });
  };
}

module.exports = { deprecatedWebhooksMiddleware, RETIRED };
