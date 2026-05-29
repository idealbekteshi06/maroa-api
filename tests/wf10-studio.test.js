'use strict';

// Behavioral coverage for WF10 — Higgsfield Studio engine.
// Previously flagged 🔴 (zero behavioral tests) in CLAUDE.md §5.B.
// These exercise the real engine (buildStudioBriefPrompt + buildBrandContext
// + estimateModelCost run for real; only sb*/callClaude/higgsfieldAI mocked).

const test = require('node:test');
const assert = require('node:assert');

const createWf10 = require('../services/wf10');

const BIZ = '11111111-1111-4111-8111-111111111111';

// Minimal business row so buildBrandContext + resolveBrandContext succeed.
function businessRow(plan = 'starter') {
  return {
    id: BIZ,
    business_name: 'Studio Test Co',
    industry: 'fitness studio',
    plan,
    is_active: true,
  };
}

// Build a deps container. `higgsfieldAI` + sb* mocks are overridable per-test.
function makeDeps(overrides = {}) {
  const posts = [];
  const patches = [];
  const deps = {
    sbGet: async (table, query) => {
      if (table === 'businesses') return [businessRow(overrides.plan || 'starter')];
      if (table === 'business_profiles') return [{}];
      if (table === 'studio_jobs') return overrides.studioJobsRows || [];
      return [];
    },
    sbPost: async (table, row) => {
      posts.push({ table, row });
      if (table === 'studio_jobs') return { id: 'job-1' };
      if (table === 'video_ab_tests') return { id: 'ab-1' };
      return { id: `${table}-id` };
    },
    sbPatch: async (table, q, body) => {
      patches.push({ table, q, body });
      return {};
    },
    callClaude: async () => '{"asset_type":"image","image_prompts":["a bright gym scene"]}',
    extractJSON: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    higgsfieldAI: {
      generateImage: async () => ({ url: 'https://cdn.higgsfield.ai/img/studio.png', model_used: 'nano-banana-pro' }),
      generateVideo: async () => ({ url: 'https://cdn.higgsfield.ai/v/studio.mp4', model_used: 'seedance-2.0' }),
      getSoulId: async () => ({ higgsfield_soul_id: 'soul-1' }),
      uploadSoulId: async () => ({ ok: true, higgsfield_soul_id: 'soul-uploaded' }),
      ...(overrides.higgsfieldAI || {}),
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { deps, posts, patches };
}

// Wait until a predicate over the captured patches becomes true (drives the
// setImmediate async job processing) or time out.
async function waitFor(predicate, { tries = 50, ms = 5 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

test('getBusinessPlan: defaults to starter when no row', async () => {
  const wf10 = createWf10({
    sbGet: async () => [],
    sbPost: async () => ({}),
    sbPatch: async () => ({}),
    callClaude: async () => '{}',
    extractJSON: () => ({}),
    higgsfieldAI: {},
    logger: { info() {}, warn() {}, error() {} },
  });
  assert.strictEqual(await wf10.getBusinessPlan(BIZ), 'starter');
});

test('getBusinessPlan: returns lowercased plan from row', async () => {
  const { deps } = makeDeps({ plan: 'AGENCY' });
  const wf10 = createWf10(deps);
  assert.strictEqual(await wf10.getBusinessPlan(BIZ), 'agency');
});

test('recordAbTestResult: rejects when required args missing', async () => {
  const { deps } = makeDeps();
  const wf10 = createWf10(deps);
  await assert.rejects(() => wf10.recordAbTestResult({ businessId: BIZ }), /required/i);
  await assert.rejects(() => wf10.recordAbTestResult({ businessId: BIZ, abTestId: 'ab-1' }), /required/i);
});

test('recordAbTestResult: patches video_ab_tests with winner + completed status', async () => {
  const { deps, patches } = makeDeps();
  const wf10 = createWf10(deps);
  const r = await wf10.recordAbTestResult({
    businessId: BIZ,
    abTestId: 'ab-9',
    winnerVariant: 'B',
    metaExperimentId: 'exp-1',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.winner_variant, 'B');
  const patch = patches.find((p) => p.table === 'video_ab_tests');
  assert.ok(patch, 'video_ab_tests patched');
  assert.strictEqual(patch.body.winner_variant, 'b', 'winner lowercased');
  assert.strictEqual(patch.body.status, 'completed');
  assert.strictEqual(patch.body.meta_experiment_id, 'exp-1');
});

test('createStudioJob: builds brief, queues a studio_jobs row, returns jobId + plan', async () => {
  const { deps, posts } = makeDeps({ plan: 'starter' });
  const wf10 = createWf10(deps);
  const r = await wf10.createStudioJob({ businessId: BIZ, request: { kind: 'image', subject: 'gym' } });
  assert.strictEqual(r.status, 'queued');
  assert.strictEqual(r.jobId, 'job-1');
  assert.strictEqual(r.plan, 'starter');
  const jobPost = posts.find((p) => p.table === 'studio_jobs');
  assert.ok(jobPost, 'studio_jobs row inserted');
  assert.strictEqual(jobPost.row.business_id, BIZ);
  assert.strictEqual(jobPost.row.status, 'queued');
  assert.strictEqual(jobPost.row.provider, 'higgsfield');
  assert.strictEqual(jobPost.row.brief.asset_type, 'image');
});

test('createStudioJob: async image path completes the job + emits wf10.job.completed', async () => {
  const { deps, posts, patches } = makeDeps({ plan: 'starter' });
  const wf10 = createWf10(deps);
  await wf10.createStudioJob({ businessId: BIZ, request: { kind: 'image', subject: 'gym' } });

  const completed = await waitFor(() =>
    patches.some((p) => p.table === 'studio_jobs' && p.body.status === 'completed')
  );
  assert.ok(completed, 'job patched to completed');
  const finalPatch = patches.find((p) => p.table === 'studio_jobs' && p.body.status === 'completed');
  assert.strictEqual(finalPatch.body.result_url, 'https://cdn.higgsfield.ai/img/studio.png');
  assert.strictEqual(finalPatch.body.provider, 'higgsfield');

  const event = posts.find((p) => p.table === 'events' && p.row.kind === 'wf10.job.completed');
  assert.ok(event, 'wf10.job.completed event written');
  assert.strictEqual(event.row.payload.url, 'https://cdn.higgsfield.ai/img/studio.png');
});

test('createStudioJob: failed generation (no url) marks job failed + emits wf10.job.failed', async () => {
  const { deps, posts, patches } = makeDeps({
    plan: 'starter',
    higgsfieldAI: { generateImage: async () => ({}) }, // no url
  });
  const wf10 = createWf10(deps);
  await wf10.createStudioJob({ businessId: BIZ, request: { kind: 'image', subject: 'gym' } });

  const failed = await waitFor(() => patches.some((p) => p.table === 'studio_jobs' && p.body.status === 'failed'));
  assert.ok(failed, 'job patched to failed when no result url');
  const event = posts.find((p) => p.table === 'events' && p.row.kind === 'wf10.job.failed');
  assert.ok(event, 'wf10.job.failed event written');
  assert.strictEqual(event.row.severity, 'error');
});

test('uploadSoulIdForBusiness / getSoulIdForBusiness resolve plan + delegate to higgsfieldAI', async () => {
  let uploadArgs = null;
  let getArgs = null;
  const { deps } = makeDeps({
    plan: 'agency',
    higgsfieldAI: {
      uploadSoulId: async (businessId, imageUrl, opts) => {
        uploadArgs = { businessId, imageUrl, opts };
        return { ok: true };
      },
      getSoulId: async (businessId, opts) => {
        getArgs = { businessId, opts };
        return { higgsfield_soul_id: 'soul-x' };
      },
    },
  });
  const wf10 = createWf10(deps);

  await wf10.uploadSoulIdForBusiness({ businessId: BIZ, imageUrl: 'https://p', characterName: 'Founder' });
  assert.strictEqual(uploadArgs.imageUrl, 'https://p');
  assert.strictEqual(uploadArgs.opts.plan, 'agency', 'plan resolved from business row');
  assert.strictEqual(uploadArgs.opts.character_name, 'Founder');

  const g = await wf10.getSoulIdForBusiness({ businessId: BIZ });
  assert.strictEqual(g.higgsfield_soul_id, 'soul-x');
  assert.strictEqual(getArgs.opts.plan, 'agency');
});

test('listJobs: builds query with status filter + limit; getJob returns single row', async () => {
  let listQuery = null;
  const deps = {
    sbGet: async (table, query) => {
      if (table === 'studio_jobs' && query.includes('order=created_at.desc')) {
        listQuery = query;
        return [{ id: 'j1' }, { id: 'j2' }];
      }
      if (table === 'studio_jobs') return [{ id: 'j1', business_id: BIZ }];
      return [];
    },
    sbPost: async () => ({}),
    sbPatch: async () => ({}),
    callClaude: async () => '{}',
    extractJSON: () => ({}),
    higgsfieldAI: {},
    logger: { info() {}, warn() {}, error() {} },
  };
  const wf10 = createWf10(deps);

  const list = await wf10.listJobs({ businessId: BIZ, status: 'completed', limit: 10 });
  assert.strictEqual(list.items.length, 2);
  assert.ok(listQuery.includes('status=eq.completed'), 'status filter applied');
  assert.ok(listQuery.includes('limit=10'), 'limit applied');

  const job = await wf10.getJob({ businessId: BIZ, jobId: 'j1' });
  assert.strictEqual(job.id, 'j1');
});
