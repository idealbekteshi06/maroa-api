'use strict';

// Regression test for the email_sequences single-writer consolidation
// (migration 090): the legacy trigger-based routes system must read/write its
// OWN `email_blast_sequences` table, never the canonical `email_sequences`
// table (owned solely by services/email-lifecycle).

const test = require('node:test');
const assert = require('node:assert/strict');

const { register } = require('../routes/email-lifecycle');

// Mount the routes against a fake app that just captures the handlers by path.
function captureRoutes(deps) {
  const handlers = {};
  const app = { post: (path, handler) => (handlers[path] = handler) };
  register({
    app,
    sbGet: async () => [],
    sbPost: async () => ({ id: 'x1' }),
    sbPatch: async () => true,
    callClaude: async () => ({}),
    sendEmailWithTags: async () => ({}),
    log: () => {},
    logError: async () => {},
    ...deps,
  });
  return handlers;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

test('routes/email-lifecycle: email-sequence-create writes email_blast_sequences, NOT email_sequences', async () => {
  const posts = [];
  const handlers = captureRoutes({
    sbPost: async (table, row) => (posts.push(table), { id: 'blast1', ...row }),
  });
  const res = mockRes();
  await handlers['/webhook/email-sequence-create'](
    { body: { business_id: 'b1', name: 'Welcome', trigger_type: 'signup', emails: [{ subject_prompt: 'hi' }] } },
    res
  );
  assert.ok(posts.includes('email_blast_sequences'), 'must write the relocated email_blast_sequences table');
  assert.ok(!posts.includes('email_sequences'), 'must NOT write the canonical email_sequences table');
  assert.equal(res.body.sequence_id, 'blast1');
});

test('routes/email-lifecycle: email-enroll resolves sequences from email_blast_sequences', async () => {
  const reads = [];
  const handlers = captureRoutes({
    sbGet: async (table) => {
      reads.push(table);
      if (table === 'email_blast_sequences') return [{ id: 'blast1', name: 'Welcome', emails: [{ delay_hours: 0 }] }];
      return [];
    },
  });
  const res = mockRes();
  await handlers['/webhook/email-enroll'](
    { body: { business_id: 'b1', contact_email: 'a@a.com', sequence_id: 'blast1' } },
    res
  );
  // Fire-and-forget endpoint acks immediately; assert it read the relocated table.
  assert.ok(reads.includes('email_blast_sequences'));
  assert.ok(!reads.includes('email_sequences'));
});
