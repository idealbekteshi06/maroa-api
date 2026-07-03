'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mu = require('../lib/modelUpgrades');

test('normalizeModel: maps every old-generation ID to the current generation', () => {
  assert.strictEqual(mu.normalizeModel('claude-sonnet-4-5'), 'claude-sonnet-5');
  assert.strictEqual(mu.normalizeModel('claude-sonnet-4-6'), 'claude-sonnet-5');
  assert.strictEqual(mu.normalizeModel('claude-sonnet-4-5-20250929'), 'claude-sonnet-5');
  assert.strictEqual(mu.normalizeModel('claude-opus-4-7'), 'claude-opus-4-8');
  assert.strictEqual(mu.normalizeModel('claude-opus-4-6'), 'claude-opus-4-8');
  // Current-generation and non-mapped models pass through untouched.
  assert.strictEqual(mu.normalizeModel('claude-sonnet-5'), 'claude-sonnet-5');
  assert.strictEqual(mu.normalizeModel('claude-haiku-4-5'), 'claude-haiku-4-5');
  assert.strictEqual(mu.normalizeModel(null), null);
});

test('normalizeModel: MODEL_UPGRADE_DISABLED=1 kill switch pins the old generation', () => {
  process.env.MODEL_UPGRADE_DISABLED = '1';
  try {
    assert.strictEqual(mu.normalizeModel('claude-opus-4-7'), 'claude-opus-4-7');
  } finally {
    delete process.env.MODEL_UPGRADE_DISABLED;
  }
  assert.strictEqual(mu.normalizeModel('claude-opus-4-7'), 'claude-opus-4-8');
});

test('sanitizeBodyForModel: strips sampling params on the 5-family only', () => {
  const body = { model: 'claude-sonnet-5', temperature: 0.5, top_p: 0.9, top_k: 40, max_tokens: 100 };
  mu.sanitizeBodyForModel(body);
  assert.strictEqual(body.temperature, undefined);
  assert.strictEqual(body.top_p, undefined);
  assert.strictEqual(body.top_k, undefined);

  const old = { model: 'claude-haiku-4-5', temperature: 0.5 };
  mu.sanitizeBodyForModel(old);
  assert.strictEqual(old.temperature, 0.5, 'non-5-family keeps sampling params');
});

test('sanitizeBodyForModel: converts enabled/budget_tokens thinking to adaptive on 5-family — including via opts', () => {
  const viaBody = { model: 'claude-opus-4-8', thinking: { type: 'enabled', budget_tokens: 2048 } };
  mu.sanitizeBodyForModel(viaBody);
  assert.deepStrictEqual(viaBody.thinking, { type: 'adaptive' });

  // opts.thinking applied first, then converted — an explicit enabled config
  // from a caller must not slip through to a 400.
  const viaOpts = { model: 'claude-sonnet-5' };
  mu.sanitizeBodyForModel(viaOpts, { thinking: { type: 'enabled', budget_tokens: 1500 } });
  assert.deepStrictEqual(viaOpts.thinking, { type: 'adaptive' });

  // 'adaptive' string shorthand
  const shorthand = { model: 'claude-opus-4-8' };
  mu.sanitizeBodyForModel(shorthand, { thinking: 'adaptive' });
  assert.deepStrictEqual(shorthand.thinking, { type: 'adaptive' });

  // Older models keep the explicit budget shape.
  const legacy = { model: 'claude-haiku-4-5' };
  mu.sanitizeBodyForModel(legacy, { thinking: { type: 'enabled', budget_tokens: 1024 } });
  assert.deepStrictEqual(legacy.thinking, { type: 'enabled', budget_tokens: 1024 });
});

test('sanitizeBodyForModel: effort lands in output_config on supporting models, validated', () => {
  const body = { model: 'claude-sonnet-5' };
  mu.sanitizeBodyForModel(body, { effort: 'xhigh' });
  assert.deepStrictEqual(body.output_config, { effort: 'xhigh' });

  const bad = { model: 'claude-sonnet-5' };
  mu.sanitizeBodyForModel(bad, { effort: 'turbo' });
  assert.strictEqual(bad.output_config, undefined, 'invalid effort values are dropped');

  const unsupported = { model: 'claude-haiku-4-5' };
  mu.sanitizeBodyForModel(unsupported, { effort: 'high' });
  assert.strictEqual(unsupported.output_config, undefined, 'haiku does not take effort');
});

test('maxTokensHeadroom: scales Sonnet 5 budgets 1.5x with floor/cap; others untouched', () => {
  assert.strictEqual(mu.maxTokensHeadroom('claude-sonnet-5', 2000), 3000);
  assert.strictEqual(mu.maxTokensHeadroom('claude-sonnet-5', 100), 1024, 'floor at 1024');
  assert.strictEqual(mu.maxTokensHeadroom('claude-sonnet-5', 60000), 64000, 'cap at 64k');
  assert.strictEqual(mu.maxTokensHeadroom('claude-opus-4-8', 4000), 4000, 'opus tokenizer unchanged from 4.7');
  assert.strictEqual(mu.maxTokensHeadroom('claude-haiku-4-5', 1000), 1000);
  assert.strictEqual(mu.maxTokensHeadroom('claude-sonnet-5', undefined), undefined);
});

test('supportsFilteredWebTools: 5-family + 4.6 family true, haiku false', () => {
  assert.ok(mu.supportsFilteredWebTools('claude-sonnet-5'));
  assert.ok(mu.supportsFilteredWebTools('claude-opus-4-8'));
  assert.ok(mu.supportsFilteredWebTools('claude-opus-4-6'));
  assert.ok(!mu.supportsFilteredWebTools('claude-haiku-4-5'));
});
