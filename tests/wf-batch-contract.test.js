'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('wf6 factory exports runAudit and getLatestAudit', () => {
  const createWf6 = require('../services/wf6');
  const wf6 = createWf6({
    sbGet: async () => [],
    sbPost: async () => ({ id: 'a1' }),
    sbPatch: async () => true,
    callClaude: async () => ({ _raw: '{}' }),
    extractJSON: () => ({ overall_score: 70 }),
    logger: { warn: () => {} },
  });
  assert.equal(typeof wf6.runAudit, 'function');
  assert.equal(typeof wf6.getLatestAudit, 'function');
});

test('wf8 factory exports generateInsightReport', () => {
  const createWf8 = require('../services/wf8');
  const wf8 = createWf8({
    sbGet: async () => [],
    sbPost: async () => ({ id: 'r1' }),
    callClaude: async () => ({ _raw: '{}' }),
    extractJSON: () => ({ personas_detected: [] }),
    logger: { warn: () => {} },
  });
  assert.equal(typeof wf8.generateInsightReport, 'function');
  assert.equal(typeof wf8.getLatestReport, 'function');
});

test('wf12 factory exports planLaunch and listLaunches', () => {
  const createWf12 = require('../services/wf12');
  const wf12 = createWf12({
    sbGet: async () => [{ id: 'b1', business_name: 'Test' }],
    sbPost: async () => ({ id: 'l1' }),
    sbPatch: async () => true,
    callClaude: async () => ({ _raw: '{}' }),
    extractJSON: () => ({ launch_name: 'Launch', phases: [] }),
    logger: { warn: () => {} },
  });
  assert.equal(typeof wf12.planLaunch, 'function');
  assert.equal(typeof wf12.listLaunches, 'function');
});
