'use strict';

/**
 * Canonical plan catalog for GET /api/billing/plans.
 * List prices (USD/mo): starter $25 · growth $59 · agency $99
 */

const LIST_PRICES_USD = {
  starter: 25,
  growth: 59,
  agency: 99,
};

function buildPlansCatalog({ starterPriceId = '', growthPriceId = '', agencyPriceId = '' } = {}) {
  const starter = {
    name: 'Starter',
    price: LIST_PRICES_USD.starter,
    annual: 250,
    maxRuns: 1,
    runHours: [6],
    priceId: starterPriceId,
    images: 20,
    kling: 0,
    sora: 0,
    platforms: 1,
    brands: 1,
    video: false,
    analytics: false,
    white_label: false,
    api: false,
    features: ['1 platform', '20 AI images/mo', 'AI brain 1×/day', 'Content calendar', 'Email support'],
  };

  const growth = {
    name: 'Growth',
    price: LIST_PRICES_USD.growth,
    annual: 590,
    maxRuns: 3,
    runHours: [6, 12, 18],
    priceId: growthPriceId,
    images: 60,
    kling: 25,
    sora: 5,
    platforms: 3,
    brands: 1,
    video: true,
    analytics: true,
    white_label: false,
    api: false,
    features: [
      '3 platforms',
      '60 AI images/mo',
      '25 Kling videos',
      '5 Sora videos',
      'AI brain 3×/day',
      'Paid ads',
      'Competitor tracking',
      'Analytics',
    ],
  };

  const agency = {
    name: 'Agency',
    price: LIST_PRICES_USD.agency,
    annual: 990,
    maxRuns: 5,
    runHours: [6, 9, 12, 15, 18],
    priceId: agencyPriceId,
    images: 120,
    kling: 50,
    sora: 15,
    platforms: 99,
    brands: 3,
    video: true,
    analytics: true,
    white_label: true,
    api: true,
    features: [
      'Unlimited platforms',
      '120 AI images/mo',
      '50 Kling videos',
      '15 Sora videos',
      'AI brain 5×/day',
      '3 brands',
      'White-label',
      'API access',
    ],
  };

  return { starter, growth, agency };
}

module.exports = { LIST_PRICES_USD, buildPlansCatalog };
