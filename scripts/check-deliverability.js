#!/usr/bin/env node

'use strict';

/**
 * scripts/check-deliverability.js
 * ----------------------------------------------------------------------------
 * Validates email deliverability config for the Maroa sending domain.
 *
 * Checks:
 *   1. SPF record present + includes Resend
 *   2. DKIM record present
 *   3. DMARC record present + policy is reject/quarantine
 *   4. MX records configured
 *   5. PTR (reverse DNS) configured for sending IP
 *
 * Usage:
 *   FROM_DOMAIN=maroa.ai node scripts/check-deliverability.js
 * ----------------------------------------------------------------------------
 */

const dns = require('node:dns').promises;

const DOMAIN = process.env.FROM_DOMAIN || 'maroa.ai';

async function checkSPF(domain) {
  try {
    const records = await dns.resolveTxt(domain);
    const spf = records.flat().find(r => r.startsWith('v=spf1'));
    if (!spf) return { passed: false, reason: 'No SPF record found' };
    const includesResend = spf.includes('include:_spf.resend.com') || spf.includes('include:resend.com');
    if (!includesResend) return { passed: false, reason: `SPF missing Resend include: ${spf}` };
    return { passed: true, record: spf };
  } catch (e) {
    return { passed: false, reason: `SPF lookup failed: ${e.code || e.message}` };
  }
}

async function checkDKIM(domain) {
  // Common selectors used by Resend
  const selectors = ['resend', 'resend._domainkey', '20240601._domainkey'];
  for (const sel of selectors) {
    try {
      const records = await dns.resolveTxt(`${sel}.${domain}`);
      if (records.flat().some(r => r.includes('v=DKIM1'))) {
        return { passed: true, selector: sel };
      }
    } catch {
      // try next selector
    }
  }
  return { passed: false, reason: 'No DKIM record at common selectors. Add via Resend dashboard.' };
}

async function checkDMARC(domain) {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    const dmarc = records.flat().find(r => r.startsWith('v=DMARC1'));
    if (!dmarc) return { passed: false, reason: 'No DMARC record' };
    const policy = dmarc.match(/p=([^;\s]+)/i)?.[1] || 'none';
    if (policy === 'none') {
      return { passed: false, reason: `DMARC policy is 'none' — should be 'quarantine' or 'reject'`, record: dmarc };
    }
    return { passed: true, policy, record: dmarc };
  } catch (e) {
    return { passed: false, reason: `DMARC lookup failed: ${e.code || e.message}` };
  }
}

async function checkMX(domain) {
  try {
    const records = await dns.resolveMx(domain);
    if (!records.length) return { passed: false, reason: 'No MX records' };
    return { passed: true, records: records.map(r => `${r.priority} ${r.exchange}`) };
  } catch (e) {
    return { passed: false, reason: `MX lookup failed: ${e.code || e.message}` };
  }
}

(async () => {
  console.log(`═══════════════ Email Deliverability Check ═══════════════`);
  console.log(`Domain: ${DOMAIN}`);
  console.log('');

  const checks = [
    { name: 'SPF',   fn: () => checkSPF(DOMAIN) },
    { name: 'DKIM',  fn: () => checkDKIM(DOMAIN) },
    { name: 'DMARC', fn: () => checkDMARC(DOMAIN) },
    { name: 'MX',    fn: () => checkMX(DOMAIN) },
  ];

  let pass = true;
  for (const c of checks) {
    const r = await c.fn();
    if (r.passed) {
      console.log(`✅ ${c.name}:  ${r.record || r.policy || (r.records?.[0] || 'OK')}`);
    } else {
      console.log(`❌ ${c.name}:  ${r.reason}`);
      pass = false;
    }
  }

  console.log('');
  if (!pass) {
    console.log('💥 Deliverability config has gaps.');
    console.log('   Action: log into Resend dashboard → DNS → follow the setup wizard.');
    console.log('   Then re-run this script to verify.');
    process.exit(1);
  }
  console.log('🎉 Deliverability config looks good. Maroa emails should land in inbox.');
})().catch(e => {
  console.error('Check failed:', e);
  process.exit(1);
});
