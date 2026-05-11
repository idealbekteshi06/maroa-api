'use strict';

/**
 * tests/google-ads-error-mapping.test.js
 *
 * Validates classifyGoogleAdsError + parseGoogleAdsQuota — the
 * analogues of services/social-multi's Meta error mapping. Same
 * pattern: tests run without network using mocked response shapes.
 */

const test = require('node:test');
const assert = require('node:assert');
const ga = require('../services/google-ads-api');

test('classifyGoogleAdsError: 401 → auth_expired, not retryable', () => {
  const c = ga.classifyGoogleAdsError({ error: { message: 'Unauthorized' } }, 401);
  assert.strictEqual(c.category, 'auth_expired');
  assert.strictEqual(c.retryable, false);
});

test('classifyGoogleAdsError: 429 → quota_exceeded, retryable', () => {
  const c = ga.classifyGoogleAdsError({ error: { message: 'quota' } }, 429);
  assert.strictEqual(c.category, 'quota_exceeded');
  assert.strictEqual(c.retryable, true);
});

test('classifyGoogleAdsError: 403 → permission_denied, not retryable', () => {
  const c = ga.classifyGoogleAdsError({ error: { message: 'Forbidden' } }, 403);
  assert.strictEqual(c.category, 'permission_denied');
});

test('classifyGoogleAdsError: 5xx → google_outage, retryable', () => {
  const c = ga.classifyGoogleAdsError({ error: { message: 'internal' } }, 502);
  assert.strictEqual(c.category, 'google_outage');
  assert.strictEqual(c.retryable, true);
});

test('classifyGoogleAdsError: GoogleAdsFailure quota_error → quota_exceeded', () => {
  const c = ga.classifyGoogleAdsError(
    {
      error: {
        details: [
          {
            '@type': 'type.googleapis.com/google.ads.googleads.v18.errors.GoogleAdsFailure',
            requestId: 'req_abc',
            errors: [{ errorCode: { quota_error: 'RESOURCE_EXHAUSTED' }, message: 'quota hit' }],
          },
        ],
      },
    },
    429
  );
  assert.strictEqual(c.category, 'quota_exceeded');
  assert.strictEqual(c.codeName, 'quota_error');
  assert.strictEqual(c.requestId, 'req_abc');
});

test('classifyGoogleAdsError: query_error → validation, not retryable', () => {
  const c = ga.classifyGoogleAdsError(
    {
      error: {
        details: [
          {
            '@type': 'type.googleapis.com/google.ads.googleads.v18.errors.GoogleAdsFailure',
            requestId: 'req_xyz',
            errors: [{ errorCode: { query_error: 'BAD_SYNTAX' }, message: 'invalid GAQL' }],
          },
        ],
      },
    },
    400
  );
  assert.strictEqual(c.category, 'validation');
  assert.strictEqual(c.retryable, false);
  assert.ok(c.hint.includes('invalid'));
});

test('parseGoogleAdsQuota: surfaces request_id from response body', () => {
  const res = { headers: { get: () => null } };
  const json = { searchSettings: { requestId: 'qreq_42' } };
  const q = ga.parseGoogleAdsQuota(res, json);
  assert.strictEqual(q.request_id, 'qreq_42');
});

test('parseGoogleAdsQuota: fills nulls when headers missing', () => {
  const res = { headers: { get: () => null } };
  const q = ga.parseGoogleAdsQuota(res, {});
  assert.strictEqual(q.request_id, null);
  assert.strictEqual(q.quota_user, null);
});
