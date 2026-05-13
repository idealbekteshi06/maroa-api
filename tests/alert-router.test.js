'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createAlertRouter, SEVERITIES } = require('../lib/alertRouter');

test('alertRouter: throws on missing key/severity/title', async () => {
  const r = createAlertRouter({});
  await assert.rejects(r.alert({ severity: 'warning', title: 'x' }), /key required/);
  await assert.rejects(r.alert({ key: 'k', title: 'x' }), /severity must be/);
  await assert.rejects(r.alert({ key: 'k', severity: 'warning' }), /title required/);
});

test('alertRouter: invalid severity throws', async () => {
  const r = createAlertRouter({});
  await assert.rejects(r.alert({ key: 'k', severity: 'catastrophic', title: 'x' }), /severity must be/);
});

test('alertRouter: info severity does not fire Slack/Email/PagerDuty', async () => {
  let slackHits = 0;
  global.fetch = async () => {
    slackHits++;
    return { ok: true, status: 200, text: async () => '' };
  };
  const sendEmailCalls = [];
  const r = createAlertRouter({
    slackWebhookUrl: 'https://hooks.slack.com/fake',
    emailTo: 'a@b.com',
    sendEmail: async (...args) => {
      sendEmailCalls.push(args);
      return { sent: true };
    },
    pagerDutyKey: 'fake-pd-key',
  });
  const res = await r.alert({ key: 'k', severity: 'info', title: 'low' });
  assert.strictEqual(slackHits, 0);
  assert.strictEqual(sendEmailCalls.length, 0);
  assert.strictEqual(res.slack, undefined);
  assert.strictEqual(res.email, undefined);
  assert.strictEqual(res.pagerduty, undefined);
});

test('alertRouter: warning fires Slack but not email or pagerduty', async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
  const sendEmailCalls = [];
  const r = createAlertRouter({
    slackWebhookUrl: 'https://hooks.slack.com/fake',
    emailTo: 'a@b.com',
    sendEmail: async (...args) => {
      sendEmailCalls.push(args);
      return { sent: true };
    },
  });
  const res = await r.alert({ key: 'k1', severity: 'warning', title: 'medium' });
  assert.ok(res.slack);
  assert.strictEqual(res.slack.ok, true);
  assert.strictEqual(sendEmailCalls.length, 0);
});

test('alertRouter: error severity fires Slack + Email', async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
  const sendEmailCalls = [];
  const r = createAlertRouter({
    slackWebhookUrl: 'https://hooks.slack.com/fake',
    emailTo: 'a@b.com',
    sendEmail: async (...args) => {
      sendEmailCalls.push(args);
      return { sent: true };
    },
  });
  const res = await r.alert({ key: 'k2', severity: 'error', title: 'high' });
  assert.ok(res.slack);
  assert.ok(res.email);
  assert.strictEqual(sendEmailCalls.length, 1);
});

test('alertRouter: critical severity fires all 4 channels', async () => {
  const slackCalls = [];
  const pdCalls = [];
  global.fetch = async (url) => {
    if (url.includes('pagerduty')) pdCalls.push(url);
    else slackCalls.push(url);
    return { ok: true, status: 200, text: async () => '' };
  };
  const sendEmailCalls = [];
  const r = createAlertRouter({
    slackWebhookUrl: 'https://hooks.slack.com/fake',
    emailTo: 'a@b.com',
    sendEmail: async (...args) => {
      sendEmailCalls.push(args);
      return { sent: true };
    },
    pagerDutyKey: 'fake-pd-key',
  });
  const res = await r.alert({ key: 'k3', severity: 'critical', title: 'pager-worthy' });
  assert.strictEqual(slackCalls.length, 1);
  assert.strictEqual(pdCalls.length, 1);
  assert.strictEqual(sendEmailCalls.length, 1);
  assert.ok(res.pagerduty.ok);
});

test('alertRouter: rate-limits the same key on Slack/Email within 5min', async () => {
  let slackHits = 0;
  global.fetch = async () => {
    slackHits++;
    return { ok: true, status: 200, text: async () => '' };
  };
  const r = createAlertRouter({
    slackWebhookUrl: 'https://hooks.slack.com/fake',
  });
  await r.alert({ key: 'same-key', severity: 'warning', title: 'first' });
  await r.alert({ key: 'same-key', severity: 'warning', title: 'second' });
  await r.alert({ key: 'same-key', severity: 'warning', title: 'third' });
  assert.strictEqual(slackHits, 1, 'duplicate alerts under same key must be rate-limited');
});

test('alertRouter: different keys are not rate-limited together', async () => {
  let slackHits = 0;
  global.fetch = async () => {
    slackHits++;
    return { ok: true, status: 200, text: async () => '' };
  };
  const r = createAlertRouter({ slackWebhookUrl: 'https://hooks.slack.com/fake' });
  r._resetRateLimits();
  await r.alert({ key: 'k-a', severity: 'warning', title: 'a' });
  await r.alert({ key: 'k-b', severity: 'warning', title: 'b' });
  assert.strictEqual(slackHits, 2);
});

test('alertRouter: missing Slack webhook silently skips Slack', async () => {
  const r = createAlertRouter({});
  const res = await r.alert({ key: 'k', severity: 'warning', title: 'x' });
  assert.strictEqual(res.slack.ok, false);
  assert.match(res.slack.reason, /SLACK_ALERT_WEBHOOK_URL/);
});

test('alertRouter: missing emailTo silently skips email', async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
  const r = createAlertRouter({
    slackWebhookUrl: 'https://hooks.slack.com/fake',
    sendEmail: async () => ({ sent: true }),
  });
  const res = await r.alert({ key: 'k99', severity: 'error', title: 'x' });
  assert.strictEqual(res.email.ok, false);
});

test('alertRouter: configured() reports which channels are wired', () => {
  const r = createAlertRouter({ slackWebhookUrl: 'x', emailTo: 'y@z', sendEmail: async () => ({}) });
  const c = r.configured();
  assert.strictEqual(c.slack, true);
  assert.strictEqual(c.email, true);
});

test('alertRouter: Slack network failure does not throw', async () => {
  global.fetch = async () => {
    throw new Error('network down');
  };
  const r = createAlertRouter({ slackWebhookUrl: 'https://hooks.slack.com/fake' });
  const res = await r.alert({ key: 'k-fail', severity: 'warning', title: 'x' });
  assert.strictEqual(res.slack.ok, false);
  assert.match(res.slack.reason, /network down/);
});

test('alertRouter: SEVERITIES exports the valid set', () => {
  assert.deepStrictEqual([...SEVERITIES], ['info', 'warning', 'error', 'critical']);
});
