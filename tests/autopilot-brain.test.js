'use strict';

const test = require('node:test');
const assert = require('node:assert');

const brain = require('../services/autopilot-brain');

// ─── composeProposedDecisions — onboarding takes priority ────────────────

test('autopilot: cold-start in progress → only proposes continue_onboarding', () => {
  const snapshot = {
    cold_start: { status: 'awaiting_input', current_phase: 'train_soul_id', display_state: { pct_complete: 40 } },
    pacing_alerts_24h: [{ alert_type: 'spend_pacing' }],
    competitor_alerts_7d: [{ severity: 'critical' }],
  };
  const proposed = brain.composeProposedDecisions({ snapshot });
  assert.strictEqual(proposed.length, 1);
  assert.strictEqual(proposed[0].domain, 'cold-start');
  assert.strictEqual(proposed[0].priority, 'highest');
});

test('autopilot: completed cold-start → considers all domains', () => {
  const snapshot = {
    cold_start: { status: 'completed' },
    pacing_alerts_24h: [{ alert_type: 'cpa_blowout' }],
    competitor_alerts_7d: [{ severity: 'critical', competitor_name: 'X', signal_type: 'new_ad_launched' }],
    citation_run_24h: { total: 50, cited: 10, cite_rate: 0.2 },
  };
  const proposed = brain.composeProposedDecisions({ snapshot });
  const domains = proposed.map((p) => p.domain);
  assert.ok(domains.includes('pacing-alerts'));
  assert.ok(domains.includes('competitor-watch'));
  assert.ok(domains.includes('creative-engine'));
  assert.ok(domains.includes('citation-tracker'));
});

// ─── resolveConflicts — hard rules ───────────────────────────────────────

test('autopilot: blocks Meta scale when measurement-health says trust=false', () => {
  const snapshot = {
    measurement_health: [{ platform: 'meta', trust_for_scaling: false, health_verdict: 'broken' }],
    yesterday_decisions: [],
  };
  const proposed = [
    { domain: 'ad-optimizer', platform: 'meta', action: 'scale_20pct' },
    { domain: 'ad-optimizer', platform: 'google', action: 'scale_15pct' },
  ];
  const r = brain.resolveConflicts({ snapshot, proposed });
  // Meta scale should be filtered out; Google scale stays
  assert.strictEqual(r.final.length, 1);
  assert.strictEqual(r.final[0].platform, 'google');
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].blocked_by, 'measurement-health');
});

test('autopilot: allows Meta scale when measurement-health says trust=true', () => {
  const snapshot = {
    measurement_health: [{ platform: 'meta', trust_for_scaling: true, health_verdict: 'healthy' }],
    yesterday_decisions: [],
  };
  const proposed = [
    { domain: 'ad-optimizer', platform: 'meta', action: 'scale_20pct' },
  ];
  const r = brain.resolveConflicts({ snapshot, proposed });
  assert.strictEqual(r.final.length, 1);
  assert.strictEqual(r.conflicts.length, 0);
});

test('autopilot: blocks re_engagement when post_purchase active yesterday', () => {
  const snapshot = {
    yesterday_decisions: [{ domain: 'email-lifecycle', stage: 'post_purchase' }],
  };
  const proposed = [
    { domain: 'email-lifecycle', stage: 're_engagement', action: 'enroll' },
  ];
  const r = brain.resolveConflicts({ snapshot, proposed });
  assert.strictEqual(r.final.length, 0);
  assert.strictEqual(r.conflicts.length, 1);
  assert.ok(/channel fatigue/.test(r.conflicts[0].reason));
});

test('autopilot: pass through with no conflicts', () => {
  const snapshot = {
    measurement_health: [],
    yesterday_decisions: [],
  };
  const proposed = [
    { domain: 'creative-engine', action: 'generate_today' },
    { domain: 'citation-tracker', action: 'review_results' },
  ];
  const r = brain.resolveConflicts({ snapshot, proposed });
  assert.strictEqual(r.final.length, 2);
  assert.strictEqual(r.conflicts.length, 0);
});

// ─── composeBrief — narrative shape ──────────────────────────────────────

test('autopilot: brief acknowledges ongoing onboarding', () => {
  const snapshot = {
    business: { business_name: 'Acme' },
    cold_start: { status: 'awaiting_input', current_phase: 'train_soul_id', display_state: { pct_complete: 40 } },
  };
  const brief = brain.composeBrief({ snapshot, decisions: [], conflicts: [] });
  assert.ok(brief.includes('Acme'));
  assert.ok(/onboarding|40%|train soul id/i.test(brief));
});

test('autopilot: brief mentions blocked decisions transparently', () => {
  const snapshot = {
    business: { business_name: 'Acme' },
    cold_start: { status: 'completed' },
    citation_run_24h: { total: 0 },
  };
  const conflicts = [
    { blocked_by: 'measurement-health', reason: 'EMQ too low' },
  ];
  const brief = brain.composeBrief({ snapshot, decisions: [], conflicts });
  assert.ok(/tracking|degraded|holding off/i.test(brief));
});

test('autopilot: brief reports citation rate when available', () => {
  const snapshot = {
    business: { business_name: 'Acme' },
    cold_start: { status: 'completed' },
    citation_run_24h: { total: 50, cited: 30, cite_rate: 0.6 },
  };
  const brief = brain.composeBrief({ snapshot, decisions: [], conflicts: [] });
  assert.ok(/60%|cited/i.test(brief));
});

test('autopilot: brief stays concise (≤ 1000 chars)', () => {
  const snapshot = {
    business: { business_name: 'Acme' },
    cold_start: { status: 'completed' },
    pacing_alerts_24h: [{ alert_type: 'a' }, { alert_type: 'b' }],
    competitor_alerts_7d: [{ severity: 'critical' }],
    citation_run_24h: { total: 100, cited: 40, cite_rate: 0.4 },
  };
  const brief = brain.composeBrief({ snapshot, decisions: [], conflicts: [] });
  assert.ok(brief.length <= 1000, `brief too long: ${brief.length} chars`);
});
