'use strict';

/**
 * services/computer-use/index.js
 * ----------------------------------------------------------------------------
 * Claude Computer Use orchestration for the Meta Ads gaps.
 *
 * Meta's Marketing API doesn't cover everything Maroa needs:
 *   - Pixel debugging (the UI-only Pixel inspector)
 *   - Some Reels placement variants
 *   - Account-level safety appeal flows
 *   - Custom audience tweaks that require the Ads Manager UI
 *
 * For those gaps, we use Anthropic's Computer Use beta — Claude drives
 * a sandboxed browser, takes screenshots, decides what to click, and
 * reports back. This module is the safety + orchestration layer.
 *
 * SAFETY MODEL (load-bearing — do not weaken):
 *
 *   1. **Dry-run by default.** Every flow runs with `dryRun: true`
 *      unless the caller passes `dryRun: false` AND
 *      `operatorOptIn: true` AND the env flag
 *      `COMPUTER_USE_ENABLED=1`. Production must set the env flag
 *      explicitly — flipping it is a documented operator decision.
 *
 *   2. **Sandboxed worker.** The browser runs in a Playwright Chromium
 *      headless instance, scoped to a single user data dir per run, in
 *      a Docker container with no host filesystem access (deploy-time
 *      contract). This module doesn't enforce the sandbox — operations
 *      must deploy with the right container — but we surface the
 *      requirement in startupSelfTest.
 *
 *   3. **Read-only first paint.** The first 10 actions of every flow
 *      are FORCED to be screenshots / mouse moves / scrolls. Click,
 *      type, and submit actions are gated behind the `commit:true`
 *      step boundary so a runaway model can't fire a button on the
 *      first turn.
 *
 *   4. **Hard step budget.** Every flow has a max-actions cap. The
 *      runner aborts and rolls back the browser session when the cap
 *      is hit. Default: 60 actions.
 *
 *   5. **Allowlisted origins.** The browser is only allowed to
 *      navigate to *.facebook.com / *.business.facebook.com /
 *      adsmanager.facebook.com. Anything else triggers an abort.
 *
 *   6. **Audit log.** Every action (think + tool + screenshot) is
 *      written to `computer_use_runs` with the businessId, flow name,
 *      ts. Operators can replay the run from logs.
 *
 * Public API:
 *   const cu = createComputerUseService({ apiKey, logger, sbPost, sbPatch });
 *   const result = await cu.runFlow({
 *     businessId, flow: 'pixel-debug',
 *     args: { pixelId: '...' },
 *     dryRun: true, operatorOptIn: false,
 *   });
 *
 * Available flows (in flows/ subfolder):
 *   - pixel-debug — inspect a Pixel via the Ads Manager event log
 *
 * To add a new flow:
 *   1. Create flows/<name>.js exporting { describe, buildInitialPrompt,
 *      allowedOrigins, maxActions }.
 *   2. Register here in FLOWS.
 *   3. Test in dry-run, ship behind COMPUTER_USE_ENABLED=1.
 * ----------------------------------------------------------------------------
 */

const ENABLED = String(process.env.COMPUTER_USE_ENABLED || '').match(/^(1|true|yes|on)$/i);
const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const COMPUTER_USE_BETA = 'computer-use-2025-01-24'; // verify against current Anthropic doc
const MAX_ACTIONS_DEFAULT = 60;
const READ_ONLY_PRELUDE = 10; // first N actions must be passive

const FLOWS = {
  'pixel-debug': require('./flows/pixel-debug'),
};

function createComputerUseService({ apiKey, logger, sbPost, sbPatch } = {}) {
  if (!apiKey) throw new Error('computer-use: apiKey required');

  /**
   * Validate the caller and the flow request before any browser starts.
   * Returns the canonical { flow, args, businessId, dryRun, maxActions,
   * allowedOrigins } or throws.
   */
  function validate({ businessId, flow: flowName, args, dryRun, operatorOptIn }) {
    if (!businessId) throw new Error('businessId required');
    const flow = FLOWS[flowName];
    if (!flow) throw new Error(`unknown flow: ${flowName}`);

    const effectiveDryRun = dryRun === false && operatorOptIn === true && ENABLED ? false : true;

    if (!effectiveDryRun) {
      logger?.warn?.('computer-use', businessId, 'LIVE run — actions WILL fire on Meta', {
        flow: flowName,
      });
    }

    return {
      flowName,
      flow,
      args: args || {},
      businessId,
      dryRun: effectiveDryRun,
      maxActions: Math.min(flow.maxActions || MAX_ACTIONS_DEFAULT, 120),
      allowedOrigins: flow.allowedOrigins || [],
    };
  }

  async function logRunStart(ctx) {
    if (typeof sbPost !== 'function') return null;
    try {
      const row = {
        business_id: ctx.businessId,
        flow: ctx.flowName,
        args: ctx.args,
        dry_run: ctx.dryRun,
        started_at: new Date().toISOString(),
        status: 'running',
      };
      const res = await sbPost('computer_use_runs', row);
      const inserted = Array.isArray(res) ? res[0] : res;
      return inserted?.id || null;
    } catch (e) {
      logger?.warn?.('computer-use', ctx.businessId, 'run-log insert failed', { error: e.message });
      return null;
    }
  }

  async function logRunEnd(runId, ctx, outcome) {
    if (!runId || typeof sbPatch !== 'function') return;
    try {
      await sbPatch('computer_use_runs', `id=eq.${encodeURIComponent(runId)}`, {
        status: outcome.status,
        actions_taken: outcome.actionsTaken,
        ended_at: new Date().toISOString(),
        summary: outcome.summary || null,
        error: outcome.error || null,
      });
    } catch (e) {
      logger?.warn?.('computer-use', ctx.businessId, 'run-log patch failed', { error: e.message });
    }
  }

  /**
   * Run a registered flow. Returns the structured outcome the flow itself
   * built (e.g., { pixel_status: 'firing', last_event_at: '...', issues: [] }).
   *
   * This entrypoint does NOT launch the browser directly — it returns the
   * orchestration plan and (in live mode) hands off to the Computer Use
   * runner in a separate worker process. The actual sandboxed Playwright
   * driver lives in services/computer-use/runner-worker.js (deploy-time
   * binary). Keeping the runner in a worker means an uncontrolled
   * browser process can never inherit the API server's memory or sockets.
   */
  async function runFlow({ businessId, flow, args, dryRun, operatorOptIn }) {
    const ctx = validate({ businessId, flow, args, dryRun, operatorOptIn });
    const runId = await logRunStart(ctx);

    try {
      const initialPrompt = ctx.flow.buildInitialPrompt({
        args: ctx.args,
        businessId: ctx.businessId,
        readOnlyPreludeSteps: READ_ONLY_PRELUDE,
      });

      const plan = {
        runId,
        businessId: ctx.businessId,
        flow: ctx.flowName,
        dryRun: ctx.dryRun,
        maxActions: ctx.maxActions,
        allowedOrigins: ctx.allowedOrigins,
        anthropic: {
          model: 'claude-sonnet-5',
          beta: COMPUTER_USE_BETA,
          system: initialPrompt.system,
          firstMessage: initialPrompt.firstMessage,
          tools: [
            { type: 'computer_20250124', name: 'computer', display_width_px: 1280, display_height_px: 800 },
            { type: 'bash_20250124', name: 'bash' },
          ],
        },
      };

      if (ctx.dryRun) {
        // Return the plan without actually invoking the runner. Useful for
        // tests, CI, and operator review.
        const outcome = {
          status: 'dry_run',
          actionsTaken: 0,
          summary: `Would run ${ctx.flowName} for business ${ctx.businessId} on ${ctx.allowedOrigins.join(', ')}.`,
        };
        await logRunEnd(runId, ctx, outcome);
        return { ...outcome, plan };
      }

      // LIVE — hand off to the runner worker. The runner is intentionally
      // NOT inline so the API server's worker pool can't be exhausted by
      // a stuck browser session.
      const runner = _loadRunner();
      if (!runner) {
        const outcome = {
          status: 'failed',
          actionsTaken: 0,
          error: 'computer-use-runner not deployed in this container',
        };
        await logRunEnd(runId, ctx, outcome);
        return outcome;
      }
      const outcome = await runner.execute({ plan, apiKey, anthropicBase: ANTHROPIC_API_BASE });
      await logRunEnd(runId, ctx, outcome);
      return outcome;
    } catch (e) {
      const outcome = { status: 'failed', actionsTaken: 0, error: e.message };
      await logRunEnd(runId, ctx, outcome);
      throw e;
    }
  }

  function listFlows() {
    return Object.entries(FLOWS).map(([name, mod]) => ({
      name,
      describe: typeof mod.describe === 'function' ? mod.describe() : name,
      maxActions: mod.maxActions || MAX_ACTIONS_DEFAULT,
      allowedOrigins: mod.allowedOrigins || [],
    }));
  }

  return { runFlow, listFlows, isEnabled: () => !!ENABLED };
}

function _loadRunner() {
  // The runner is an optional deploy-time module. Customers running Maroa
  // without the Computer Use container will see `null` here and dry-run
  // is the only available mode.
  try {
    // eslint-disable-next-line global-require
    return require('./runner-worker');
  } catch {
    return null;
  }
}

module.exports = { createComputerUseService, COMPUTER_USE_BETA };
