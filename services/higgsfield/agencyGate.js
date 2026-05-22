'use strict';

const UPGRADE_URL = 'https://maroa.ai/pricing';

/**
 * Agency-only ($99) premium Higgsfield features gate.
 */
function requireAgency(plan) {
  const isAgency = String(plan || '').toLowerCase() === 'agency';
  if (!isAgency) {
    return {
      skipped: true,
      reason: 'agency_plan_required',
      upgrade_url: UPGRADE_URL,
    };
  }
  return { skipped: false, isAgency: true };
}

module.exports = { requireAgency, UPGRADE_URL };
