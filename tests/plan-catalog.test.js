'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LIST_PRICES_USD, buildPlansCatalog } = require('../lib/planCatalog');

test('LIST_PRICES_USD matches public pricing', () => {
  assert.deepStrictEqual(LIST_PRICES_USD, { starter: 25, growth: 59, agency: 99 });
});

test('buildPlansCatalog returns expected monthly prices', () => {
  const plans = buildPlansCatalog({ starterPriceId: 'pri_starter', growthPriceId: 'pri_growth', agencyPriceId: 'pri_agency' });
  assert.strictEqual(plans.starter.price, 25);
  assert.strictEqual(plans.growth.price, 59);
  assert.strictEqual(plans.agency.price, 99);
  assert.strictEqual(plans.free.price, 25);
  assert.strictEqual(plans.starter.priceId, 'pri_starter');
});
