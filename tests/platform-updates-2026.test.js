'use strict';

const test = require('node:test');
const assert = require('node:assert');

const meta = require('../lib/metaMetrics');
const platform = require('../lib/platformAnthropic');
const cacheDiag = require('../lib/cacheDiagnostics');
const { buildCodeExecutionTool } = require('../lib/claudeAnthropicTools');

test('metaMetrics: viewers primary after cutover', () => {
  assert.strictEqual(meta.useViewersPrimary(new Date('2026-07-01')), true);
  const n = meta.normalizeSnapshotMetrics({ reach: 100, viewers: 150 });
  assert.equal(n.audience_metric, 'viewers');
  assert.equal(n.viewers, 150);
  assert.equal(n.reach, 150);
});

test('metaMetrics: threads objectives include traffic', () => {
  assert.ok(meta.THREADS_OBJECTIVES.has('OUTCOME_TRAFFIC'));
});

test('platformAnthropic: agency monthly batch cap uses extended range', () => {
  const cap = platform.batchMaxTokensForPlan('agency', 'wf1_monthly');
  assert.ok(cap > 64000);
  assert.ok(platform.supportsExtendedOutput('claude-sonnet-5'));
});

test('cacheDiagnostics: round-trip message id', () => {
  cacheDiag.setPreviousMessageId('biz-1', 'wf5', 'msg_prev');
  const d = cacheDiag.buildDiagnosticsPayload({ businessId: 'biz-1', skill: 'wf5' });
  assert.equal(d.previous_message_id, 'msg_prev');
  const ing = cacheDiag.ingestResponse({
    businessId: 'biz-1',
    skill: 'wf5',
    responseBody: { id: 'msg_new', cache_miss_reason: 'system_prompt_changed' },
    logger: { info: () => {} },
  });
  assert.equal(ing.message_id, 'msg_new');
  assert.equal(ing.cache_miss_reason, 'system_prompt_changed');
});

test('code execution tool type', () => {
  assert.equal(buildCodeExecutionTool().type, 'code_execution_20260120');
});
