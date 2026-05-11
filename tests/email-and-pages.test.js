'use strict';

const test = require('node:test');
const assert = require('node:assert');

const lifecycle = require('../services/email-lifecycle');
const pageBuilder = require('../services/page-builder');

// ─── Email Lifecycle ──────────────────────────────────────────────────────

test('email-lifecycle: STAGE_DEFAULTS covers all 6 stages', () => {
  const stages = Object.keys(lifecycle.STAGE_DEFAULTS);
  assert.deepStrictEqual(stages.sort(), [
    'abandoned_cart',
    'nurture',
    'post_purchase',
    're_engagement',
    'welcome',
    'win_back',
  ]);
});

test('email-lifecycle: every stage has cadence_days array + trigger_event', () => {
  for (const [stage, defaults] of Object.entries(lifecycle.STAGE_DEFAULTS)) {
    assert.ok(Array.isArray(defaults.cadence_days), `${stage} missing cadence_days`);
    assert.ok(defaults.cadence_days.length >= 2, `${stage} should have ≥ 2 emails in sequence`);
    assert.ok(typeof defaults.trigger_event === 'string', `${stage} missing trigger_event`);
  }
});

test('email-lifecycle: principleForStep returns correct psychology principle', () => {
  assert.strictEqual(lifecycle.principleForStep('welcome', 0), 'reciprocity');
  assert.strictEqual(lifecycle.principleForStep('welcome', 1), 'social_proof');
  assert.strictEqual(lifecycle.principleForStep('abandoned_cart', 0), 'loss_aversion');
  assert.strictEqual(lifecycle.principleForStep('abandoned_cart', 1), 'scarcity');
  assert.strictEqual(lifecycle.principleForStep('post_purchase', 2), 'social_proof');
  // Default fallback
  assert.strictEqual(lifecycle.principleForStep('nonexistent', 99), 'reciprocity');
});

test('email-lifecycle: composeStepEmail attaches the principle for that stage:step', () => {
  const r = lifecycle.composeStepEmail({
    business: { business_name: 'Acme', industry: 'plumber' },
    sequence: { stage: 'abandoned_cart' },
    step: 1,
    recipient: { recipient_email: 'x@x.com', recipient_name: 'Sam' },
  });
  assert.strictEqual(r.psychological_principle, 'scarcity');
  assert.ok(r.subject.length > 0);
  assert.ok(r.cta_label.length > 0);
});

test('email-lifecycle: composeStepEmail templates per-stage subject differs', () => {
  const welcome = lifecycle.composeStepEmail({
    business: { business_name: 'Acme' },
    sequence: { stage: 'welcome' },
    step: 0,
    recipient: {},
  });
  const cart = lifecycle.composeStepEmail({
    business: { business_name: 'Acme' },
    sequence: { stage: 'abandoned_cart' },
    step: 0,
    recipient: {},
  });
  assert.notStrictEqual(welcome.subject, cart.subject);
});

test('email-lifecycle: enrollRecipient is idempotent on duplicate emails', async () => {
  let postedCount = 0;
  const deps = {
    sbGet: async (table, q) => {
      if (table === 'email_sequences')
        return [
          {
            id: 'seq-1',
            stage: 'welcome',
            cadence_days: [0, 2, 7],
            is_active: true,
          },
        ];
      if (table === 'email_sequence_runs') return [{ id: 'existing-run' }]; // already enrolled
      return [];
    },
    sbPost: async () => {
      postedCount += 1;
    },
  };
  const r = await lifecycle.enrollRecipient({
    businessId: 'b1',
    stage: 'welcome',
    email: 'a@a.com',
    deps,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.alreadyEnrolled, true);
  assert.strictEqual(postedCount, 0, 'should not insert when already enrolled');
});

test('email-lifecycle: enrollRecipient inserts a run when not already enrolled', async () => {
  let posted = null;
  const deps = {
    sbGet: async (table) => {
      if (table === 'email_sequences')
        return [
          {
            id: 'seq-1',
            stage: 'welcome',
            cadence_days: [0, 2, 7],
            is_active: true,
          },
        ];
      if (table === 'email_sequence_runs') return [];
      return [];
    },
    sbPost: async (table, row) => {
      posted = { table, row };
    },
  };
  const r = await lifecycle.enrollRecipient({
    businessId: 'b1',
    stage: 'welcome',
    email: 'new@x.com',
    name: 'New',
    deps,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(posted?.table, 'email_sequence_runs');
  assert.strictEqual(posted?.row?.recipient_email, 'new@x.com');
});

test('email-lifecycle: ensureSequencesForBusiness creates only missing stages', async () => {
  const created = [];
  const deps = {
    sbGet: async () => [{ stage: 'welcome' }], // welcome already exists
    sbPost: async (table, row) => {
      created.push(row.stage);
    },
  };
  const r = await lifecycle.ensureSequencesForBusiness({ businessId: 'b1', deps });
  assert.strictEqual(r.ok, true);
  assert.ok(!created.includes('welcome'), 'should skip existing stages');
  assert.ok(created.includes('nurture'));
  assert.ok(created.includes('abandoned_cart'));
  assert.ok(created.includes('win_back'));
});

// ─── Page Builder ─────────────────────────────────────────────────────────

test('page-builder: buildPageSpec produces 6 sections in order', () => {
  const r = pageBuilder.buildPageSpec({
    business: { business_name: 'Acme', industry: 'plumber', tagline: 'Fast fixes for tough leaks' },
    brandVoice: {},
    vocSnapshot: null,
    soulImageUrl: 'https://example.com/hero.jpg',
  });
  assert.strictEqual(r.ok, true);
  const types = r.sections.map((s) => s.type);
  assert.deepStrictEqual(types, ['hero', 'value_props', 'social_proof', 'objections', 'trust_strip', 'final_cta']);
});

test('page-builder: headline clamps to ≤8 words', () => {
  const r = pageBuilder.buildPageSpec({
    business: {
      business_name: 'X',
      industry: 'saas',
      tagline: 'This is a way too long headline that nobody will read on a hero',
    },
  });
  const hero = r.sections.find((s) => s.type === 'hero');
  const wc = hero.headline.split(/\s+/).length;
  assert.ok(wc <= pageBuilder.HEADLINE_MAX_WORDS, `headline has ${wc} words, should be ≤ 8`);
});

test('page-builder: never invents social proof — empty array if no VOC', () => {
  const r = pageBuilder.buildPageSpec({
    business: { business_name: 'X', industry: 'saas' },
    vocSnapshot: null,
  });
  const sp = r.sections.find((s) => s.type === 'social_proof');
  assert.deepStrictEqual(sp.quotes, [], 'Should never fabricate quotes — empty when VOC is unavailable');
});

test('page-builder: SaaS industry gets SaaS value props', () => {
  const r = pageBuilder.buildPageSpec({
    business: { business_name: 'X', industry: 'saas b2b' },
    brandVoice: {},
  });
  const vp = r.sections.find((s) => s.type === 'value_props');
  assert.ok(vp.items.some((it) => /minutes|setup|cancel|support/i.test(it.title)));
});

test('page-builder: e-commerce gets e-commerce value props', () => {
  const r = pageBuilder.buildPageSpec({
    business: { business_name: 'X', industry: 'e-commerce apparel' },
    brandVoice: {},
  });
  const vp = r.sections.find((s) => s.type === 'value_props');
  assert.ok(vp.items.some((it) => /shipping|returns|secure/i.test(it.title)));
});

test('page-builder: auditPageSpec scores high on a complete spec', () => {
  const spec = pageBuilder.buildPageSpec({
    business: {
      business_name: 'Acme Plumbing',
      industry: 'plumber',
      location: 'Austin',
      tagline: 'Honest plumbing for Austin homes',
      description: 'We fix leaks fast.',
    },
    brandVoice: {},
    vocSnapshot: {
      verbatim_quotes: [
        { text: 'They saved my kitchen', author: 'Jane' },
        { text: 'Fastest service in town', author: 'Mike' },
      ],
    },
    soulImageUrl: 'https://example.com/x.jpg',
  });
  const audit = pageBuilder.auditPageSpec(spec);
  assert.ok(audit.score >= 90, `Expected score ≥ 90, got ${audit.score}: ${audit.findings.join(', ')}`);
});

test('page-builder: auditPageSpec penalizes missing hero', () => {
  const audit = pageBuilder.auditPageSpec({
    sections: [{ type: 'value_props', items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] }],
  });
  assert.ok(audit.score < 80);
  assert.ok(audit.findings.some((f) => /headline/i.test(f) || /CTA/i.test(f)));
});

test('page-builder: renderHtml produces valid HTML5 doc', () => {
  const spec = pageBuilder.buildPageSpec({
    business: { business_name: 'Acme', industry: 'plumber', tagline: 'We fix leaks' },
    brandVoice: {},
  });
  const html = pageBuilder.renderHtml(spec);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<meta name="viewport"')); // mobile-optimized
  assert.ok(html.includes('Acme'));
  assert.ok(html.includes('class="btn"'));
});

test('page-builder: renderHtml escapes HTML in user input', () => {
  const spec = pageBuilder.buildPageSpec({
    business: { business_name: 'Acme & <script>alert(1)</script>', industry: 'plumber' },
    brandVoice: {},
  });
  const html = pageBuilder.renderHtml(spec);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'Must escape script tags');
  assert.ok(
    html.includes('&lt;script&gt;') || html.includes('&amp;'),
    `Expected HTML entities to be escaped, got: ${html.slice(0, 500)}`
  );
});
