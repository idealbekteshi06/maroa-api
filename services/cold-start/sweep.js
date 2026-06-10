'use strict';

/**
 * services/cold-start/sweep.js
 * ---------------------------------------------------------------------------
 * Stale-run sweep (gap G-1).
 *
 * A cold-start run can wedge forever in status='awaiting_input' when the
 * customer never takes the action the orchestrator paused on (uploads Soul-ID
 * photos, approves a concept). Nothing previously timed these out or nudged
 * the customer — a paying customer could silently get nothing indefinitely.
 *
 * This sweep runs daily (Inngest cron `cold-start-sweep-daily`) and:
 *   - reminds the customer once after 72h stuck in awaiting_input
 *   - fails the run cleanly after 7 days (168h) so it stops counting as
 *     in-progress (autopilot-brain / dashboards treat anything not
 *     'completed' as still onboarding — see autopilot-brain composeBrief)
 *
 * We deliberately do NOT auto-advance phases — re-driving the engine without
 * the customer's input is risky (wrong Soul-ID, wrong concept). Failing the
 * run cleanly is the safe unwedge; the customer can be re-triggered.
 *
 * deps follows the same injection style as phases.js / orchestrator.js:
 *   { sbGet, sbPatch, sbPost, sendEmail, inngest, logger, now }
 *   - sbGet/sbPatch/sbPost  : Supabase PostgREST helpers
 *   - sendEmail(to, subject, html) : positional, matches server.js sendEmail
 *   - inngest               : optional — unused today, reserved for a future
 *                             "send reminder via durable event" path
 *   - now                   : optional Date injection for deterministic tests
 * ---------------------------------------------------------------------------
 */

const REMINDER_AFTER_MS = 72 * 60 * 60 * 1000; // 72h → nudge once
const EXPIRE_AFTER_MS = 168 * 60 * 60 * 1000; // 7d → fail cleanly
const SWEEP_LIMIT = 500; // cap rows scanned per sweep

function ageMs(run, nowMs) {
  const ts = run?.updated_at || run?.started_at;
  const t = ts ? Date.parse(ts) : NaN;
  if (Number.isNaN(t)) return 0;
  return Math.max(0, nowMs - t);
}

/**
 * sweepStaleRuns — find awaiting_input runs that have gone stale and either
 * remind (72h, once) or expire (7d). Returns a summary.
 *
 * @returns {Promise<{ scanned: number, reminded: number, expired: number }>}
 */
async function sweepStaleRuns({ sbGet, sbPatch, sbPost, sendEmail, inngest, logger, now } = {}) {
  const nowDate = now instanceof Date ? now : new Date();
  const nowMs = nowDate.getTime();
  const nowISO = nowDate.toISOString();

  let scanned = 0;
  let reminded = 0;
  let expired = 0;

  if (typeof sbGet !== 'function') {
    logger?.warn?.('cold-start.sweep', null, 'sbGet unavailable — skipping sweep');
    return { scanned, reminded, expired };
  }

  const runs = await sbGet(
    'cold_start_runs',
    `status=eq.awaiting_input&select=id,business_id,current_phase,started_at,updated_at,display_state&limit=${SWEEP_LIMIT}`
  ).catch(() => []);

  for (const run of runs || []) {
    scanned += 1;
    const age = ageMs(run, nowMs);
    // PostgREST filters must be UUID-validated + encoded at the boundary
    // (Rule 4). business_id/id are uuid columns; encode defensively.
    const runIdFilter = `id=eq.${encodeURIComponent(run.id)}`;

    try {
      // ── Expire after 7 days — fail cleanly so it stops counting as in-progress ──
      if (age > EXPIRE_AFTER_MS) {
        await sbPatch?.('cold_start_runs', runIdFilter, {
          status: 'failed',
          failed_at: nowISO,
          last_error: 'abandoned_onboarding_timeout',
        }).catch(() => {});
        expired += 1;
        logger?.warn?.('cold-start.sweep', run.business_id, 'expired abandoned onboarding run', {
          run_id: run.id,
          current_phase: run.current_phase,
          age_hours: Math.round(age / 3_600_000),
        });
        continue; // don't also remind a run we just failed
      }

      // ── Remind once after 72h ──
      if (age > REMINDER_AFTER_MS) {
        const displayState = run.display_state && typeof run.display_state === 'object' ? run.display_state : {};
        if (displayState.reminder_sent_at) {
          // Already nudged — leave it for the expiry pass.
          continue;
        }

        // Look up the customer's email for the nudge.
        let email = null;
        let businessName = null;
        if (run.business_id) {
          const bizFilter = `id=eq.${encodeURIComponent(run.business_id)}&select=email,business_name&limit=1`;
          const bizRows = await sbGet('businesses', bizFilter).catch(() => []);
          email = bizRows?.[0]?.email || null;
          businessName = bizRows?.[0]?.business_name || null;
        }

        let sentOk = false;
        if (typeof sendEmail === 'function' && email) {
          const action = displayState.next_user_action
            ? String(displayState.next_user_action).replace(/_/g, ' ')
            : 'finish setting up your account';
          const subject = `Finish setting up ${businessName || 'your Maroa account'}`;
          const html = [
            `<p>Hi,</p>`,
            `<p>Your Maroa onboarding is paused waiting on one quick step: <strong>${action}</strong>.</p>`,
            `<p>Until it's done we can't start running content and ads for you. It only takes a minute — `,
            `<a href="https://maroa.ai/dashboard">open your dashboard</a> to wrap it up.</p>`,
            `<p>Reply to this email if you're stuck and we'll help.</p>`,
          ].join('');
          try {
            await sendEmail(email, subject, html);
            sentOk = true;
          } catch (e) {
            logger?.warn?.('cold-start.sweep', run.business_id, 'reminder email failed', { error: e.message });
          }
        }

        // Record that we nudged (only once), even if email was skipped/queued —
        // we don't want to retry a missing-key send every day. Merge into the
        // existing display_state so we don't clobber pct_complete etc.
        await sbPatch?.('cold_start_runs', runIdFilter, {
          display_state: { ...displayState, reminder_sent_at: nowISO },
        }).catch(() => {});

        if (sentOk) reminded += 1;
      }
    } catch (e) {
      // Per-run isolation — one bad row never aborts the sweep.
      logger?.warn?.('cold-start.sweep', run.business_id, 'sweep row failed', {
        run_id: run.id,
        error: e.message,
      });
    }
  }

  logger?.info?.('cold-start.sweep', null, 'stale-run sweep complete', { scanned, reminded, expired });
  return { scanned, reminded, expired };
}

module.exports = {
  sweepStaleRuns,
  REMINDER_AFTER_MS,
  EXPIRE_AFTER_MS,
  SWEEP_LIMIT,
};
