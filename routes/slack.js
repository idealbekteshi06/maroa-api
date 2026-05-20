'use strict';

/**
 * routes/slack.js
 * ----------------------------------------------------------------------------
 * Slack integration — Maroa runs inside the customer's Slack workspace.
 *
 * Endpoints:
 *
 *   POST /webhook/slack/command        — Slash-command dispatcher
 *        verified by HMAC-SHA256 against SLACK_SIGNING_SECRET +
 *        timestamp ≤5min (replay-protection). Routes /maroa subcommands:
 *
 *          /maroa status                — one-line summary across workspaces
 *          /maroa approvals             — list pending approvals
 *          /maroa approve <decision-id> — approve a specific decision
 *          /maroa reject <decision-id> <reason>
 *          /maroa draft <theme>         — fire-and-forget draft request
 *          /maroa help
 *
 *   POST /webhook/slack/interactivity  — Block Kit button callbacks for
 *        approve/reject from inside Slack messages.
 *
 *   POST /webhook/slack/digest         — Internal cron trigger (gated by
 *        webhook secret). Posts the daily 9am summary to a channel.
 *
 * Design:
 *   - Signature verification BEFORE any side-effect. Replay-window 5min.
 *   - Maps Slack user → Maroa user via slack_identities table (user must
 *     have linked their Slack account once via /maroa link).
 *   - All replies are ephemeral by default (only the user sees them).
 *   - Approve/reject calls go through the same /api/war-room route the
 *     dashboard uses — single source of truth, idempotency-key safe.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

function register({
  app,
  warRoomFeed,
  workspaces,
  decisionLog,
  sbGet,
  sbPost,
  sbPatch,
  apiError,
  safePublicError,
  log,
  express,
  marketingGraph,
  requireAnyUserId,
}) {
  const SLACK_SIGNING_SECRET = (process.env.SLACK_SIGNING_SECRET || '').trim();
  const SLACK_REPLAY_WINDOW_S = 5 * 60;

  // We need the RAW body for signature verification — express.json() consumes
  // it. Mount a raw parser specifically for Slack routes that re-exposes the
  // raw bytes on req.rawBody before the JSON / urlencoded parsers run.
  function rawCapture(req, _res, next) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      req.rawBody = data;
      next();
    });
  }

  function verifySlack(req) {
    if (!SLACK_SIGNING_SECRET) return { ok: false, reason: 'slack_signing_secret_unset' };
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    if (!ts || !sig) return { ok: false, reason: 'missing_signature_headers' };
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad_timestamp' };
    const age = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
    if (age > SLACK_REPLAY_WINDOW_S) return { ok: false, reason: 'replay_window_exceeded' };

    const base = `v0:${ts}:${req.rawBody || ''}`;
    const computed =
      'v0=' +
      crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
    // Constant-time compare
    try {
      const a = Buffer.from(computed, 'utf8');
      const b = Buffer.from(String(sig), 'utf8');
      if (a.length !== b.length) return { ok: false, reason: 'sig_length_mismatch' };
      if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'sig_mismatch' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'sig_compare_error' };
    }
  }

  // ── Slack user → Maroa user mapping ───────────────────────────────────
  // Looked up via the slack_identities table (migration 075). When no
  // mapping exists yet we tell the user to /maroa link.
  async function maroaUserForSlack(slackUserId) {
    if (!sbGet || !slackUserId) return null;
    try {
      const rows = await sbGet(
        'slack_identities',
        `slack_user_id=eq.${encodeURIComponent(slackUserId)}&select=maroa_user_id&limit=1`,
      );
      return rows?.[0]?.maroa_user_id || null;
    } catch {
      return null;
    }
  }

  function parseSlackForm(raw) {
    const params = new URLSearchParams(raw || '');
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }

  function ephemeral(text, blocks) {
    return {
      response_type: 'ephemeral',
      text,
      ...(blocks ? { blocks } : {}),
    };
  }

  // ── Command handlers ─────────────────────────────────────────────────

  async function handleStatus(maroaUserId, _args, _payload, res) {
    if (!warRoomFeed || !workspaces) {
      return res.json(ephemeral('Maroa is initializing. Try again in a minute.'));
    }
    try {
      const memberships = await workspaces.listForUser(maroaUserId).catch(() => []);
      if (!memberships?.length) {
        return res.json(
          ephemeral("You're not a member of any Maroa workspace. Ask the owner to invite you."),
        );
      }
      const wsId = memberships[0].workspace_id || memberships[0].id;
      const feed = await warRoomFeed.getWorkspaceFeed(wsId).catch(() => null);
      if (!feed) return res.json(ephemeral("I couldn't reach your workspace just now. Try again."));
      const pending = (feed.pending_approvals || []).length;
      const decaying = feed.summary?.decaying_or_dead || 0;
      const live = feed.summary?.creatives_total || 0;
      const text =
        pending > 0
          ? `:wave: *${pending}* ${pending === 1 ? 'thing needs' : 'things need'} your eyes. ` +
            `Run \`/maroa approvals\` to triage. Otherwise: ${live} pieces live, ${decaying} fading.`
          : `:white_check_mark: All caught up. ${live} pieces live, ${decaying} fading.`;
      return res.json(ephemeral(text));
    } catch (e) {
      log?.('/webhook/slack', null, 'status failed', { error: e.message });
      return res.json(ephemeral('Something went wrong on my side. Try again in a moment.'));
    }
  }

  async function handleApprovals(maroaUserId, _args, _payload, res) {
    if (!warRoomFeed || !workspaces) {
      return res.json(ephemeral('Maroa is initializing.'));
    }
    try {
      const memberships = await workspaces.listForUser(maroaUserId).catch(() => []);
      if (!memberships?.length) {
        return res.json(ephemeral("You're not a member of any Maroa workspace yet."));
      }
      const wsId = memberships[0].workspace_id || memberships[0].id;
      const feed = await warRoomFeed.getWorkspaceFeed(wsId).catch(() => null);
      const pending = (feed?.clients || [])
        .flatMap((c) => (c.recent_decisions || []).map((d) => ({ ...d, client: c })))
        .filter((d) => d.required_approval && !d.executed && !d.refused)
        .slice(0, 5);
      if (!pending.length) {
        return res.json(ephemeral(':white_check_mark: Inbox clear — nothing waiting.'));
      }
      const blocks = pending.flatMap((d) => [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*${d.client?.client?.client_name || 'Your business'}* — ${d.agent_name}\n` +
              `${(d.recommendation_text || 'Decision').slice(0, 240)}` +
              (typeof d.confidence === 'number' && d.confidence > 0
                ? `  _(${Math.round(d.confidence * 100)}% sure)_`
                : ''),
          },
        },
        {
          type: 'actions',
          block_id: `decision:${d.id}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              value: JSON.stringify({ action: 'approve', decision_id: d.id, workspace_id: wsId }),
              action_id: `approve_${d.id}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Not this one' },
              value: JSON.stringify({ action: 'reject', decision_id: d.id, workspace_id: wsId }),
              action_id: `reject_${d.id}`,
            },
          ],
        },
        { type: 'divider' },
      ]);
      return res.json({
        response_type: 'ephemeral',
        text: `${pending.length} pending`,
        blocks,
      });
    } catch (e) {
      log?.('/webhook/slack', null, 'approvals failed', { error: e.message });
      return res.json(ephemeral('Something went wrong loading your approvals.'));
    }
  }

  async function handleApprove(maroaUserId, args, payload, res) {
    const decisionId = (args[0] || '').trim();
    if (!decisionId) return res.json(ephemeral('Usage: `/maroa approve <decision-id>`'));
    if (!decisionLog) return res.json(ephemeral('Decision log unavailable.'));
    try {
      const updated = await decisionLog.approve(decisionId, maroaUserId);
      if (!updated) return res.json(ephemeral(`Couldn't approve \`${decisionId}\`. Maybe already done?`));
      // Mirror to marketing graph if wired — same pattern as the war-room route.
      if (marketingGraph?.upsertEntity) {
        marketingGraph
          .upsertEntity({
            businessId: updated.business_id,
            type: 'decision',
            subtype: updated.agent_name || 'slack_approval',
            title: (updated.recommendation_text || 'approved via slack').slice(0, 200),
            externalId: `decision:${updated.id}`,
            source: 'slack:command',
            attrs: { decision_id: updated.id, action: 'approved', via: 'slack' },
          })
          .catch(() => {});
      }
      return res.json(ephemeral(`:white_check_mark: Approved. Maroa is shipping it now.`));
    } catch (e) {
      return res.json(ephemeral(`Couldn't approve: ${e.message}`));
    }
  }

  async function handleReject(maroaUserId, args, _payload, res) {
    const decisionId = (args[0] || '').trim();
    const reason = args.slice(1).join(' ').trim();
    if (!decisionId) {
      return res.json(ephemeral('Usage: `/maroa reject <decision-id> <reason>`'));
    }
    if (!decisionLog) return res.json(ephemeral('Decision log unavailable.'));
    try {
      const updated = await decisionLog.reject(decisionId, maroaUserId, reason || '');
      if (!updated) return res.json(ephemeral(`Couldn't reject \`${decisionId}\`.`));
      return res.json(ephemeral(`:x: Rejected. I'll learn from this.`));
    } catch (e) {
      return res.json(ephemeral(`Couldn't reject: ${e.message}`));
    }
  }

  function handleHelp(_maroaUserId, _args, _payload, res) {
    return res.json(
      ephemeral(
        '*Maroa Slack commands*\n' +
          '• `/maroa status` — one-line summary\n' +
          '• `/maroa approvals` — list pending items with buttons\n' +
          '• `/maroa approve <id>` — approve a decision\n' +
          '• `/maroa reject <id> <reason>` — reject with a reason\n' +
          '• `/maroa link` — connect your Slack account to Maroa (one-time)\n' +
          '• `/maroa help` — this message',
      ),
    );
  }

  async function handleLink(_maroaUserId, _args, payload, res) {
    // Link is an out-of-band magic-link flow. We return the URL the user
    // clicks in their DMs; clicking it lands on a Maroa page that POSTs
    // their Maroa-side JWT + Slack user id to /api/slack/link-complete.
    const apiBase =
      process.env.MAROA_PUBLIC_BASE || 'https://maroa.ai';
    const slackUserId = payload.user_id || 'unknown';
    const linkUrl = `${apiBase}/settings/slack-link?slack_user=${encodeURIComponent(slackUserId)}`;
    return res.json(
      ephemeral(
        `:link: Click here to link your Slack account to Maroa:\n${linkUrl}\n` +
          `_(One-time. The link is private to you.)_`,
      ),
    );
  }

  const COMMANDS = {
    status: handleStatus,
    approvals: handleApprovals,
    approve: handleApprove,
    reject: handleReject,
    link: handleLink,
    help: handleHelp,
  };

  // ── Slash-command dispatcher ──────────────────────────────────────────
  app.post('/webhook/slack/command', rawCapture, async (req, res) => {
    try {
      const verdict = verifySlack(req);
      if (!verdict.ok) {
        log?.('/webhook/slack/command', null, 'signature rejected', { reason: verdict.reason });
        return res.status(401).type('text').send('invalid signature');
      }
      const payload = parseSlackForm(req.rawBody);
      const text = (payload.text || '').trim();
      const [subcommand, ...args] = text.split(/\s+/).filter(Boolean);
      const handler = COMMANDS[(subcommand || 'help').toLowerCase()] || handleHelp;

      // Resolve Maroa user
      const maroaUserId = await maroaUserForSlack(payload.user_id);
      if (!maroaUserId && handler !== handleLink && handler !== handleHelp) {
        return res.json(
          ephemeral(
            "I don't see a linked Maroa account for you. Run `/maroa link` first to connect (one-time).",
          ),
        );
      }
      return handler(maroaUserId, args, payload, res);
    } catch (e) {
      log?.('/webhook/slack/command', null, 'crashed', { error: e.message });
      return res.status(500).json(ephemeral("I hit an error. Try again in a moment."));
    }
  });

  // ── Block Kit button callback (approve/reject from inside a message) ──
  app.post('/webhook/slack/interactivity', rawCapture, async (req, res) => {
    try {
      const verdict = verifySlack(req);
      if (!verdict.ok) return res.status(401).type('text').send('invalid signature');
      const form = parseSlackForm(req.rawBody);
      const payload = JSON.parse(form.payload || '{}');
      const slackUser = payload?.user?.id;
      const maroaUserId = await maroaUserForSlack(slackUser);
      if (!maroaUserId) {
        return res.json(ephemeral('Link your Slack account first: `/maroa link`'));
      }
      const action = payload?.actions?.[0];
      if (!action) return res.json(ephemeral('No action found.'));
      const value = JSON.parse(action.value || '{}');
      if (value.action === 'approve') {
        const updated = await decisionLog.approve(value.decision_id, maroaUserId);
        return res.json(ephemeral(updated ? ':white_check_mark: Approved.' : "Couldn't approve."));
      }
      if (value.action === 'reject') {
        const updated = await decisionLog.reject(value.decision_id, maroaUserId, 'rejected from slack');
        return res.json(ephemeral(updated ? ':x: Rejected.' : "Couldn't reject."));
      }
      return res.json(ephemeral('Unknown action.'));
    } catch (e) {
      log?.('/webhook/slack/interactivity', null, 'crashed', { error: e.message });
      return res.status(500).json(ephemeral('Error processing action.'));
    }
  });

  // ── Link-complete endpoint (signed-in dashboard side) ─────────────────
  // Called by /settings/slack-link in the frontend when a user clicks the
  // magic URL DM'd by /maroa link. Expects body { slack_user_id, slack_team_id? }
  // along with the user's Supabase JWT (requireAnyUserId resolves req.user.id).
  //
  // Upserts slack_identities so the next /maroa command from that Slack user
  // routes to the right Maroa user. If a different Maroa user previously
  // claimed the same slack_user_id, revoke the old row first so there's
  // exactly one active mapping per Slack user.
  if (requireAnyUserId && sbPost && sbPatch) {
    app.post(
      '/api/slack/link-complete',
      requireAnyUserId,
      express ? express.json({ limit: '2kb' }) : (req, _res, next) => next(),
      async (req, res) => {
        try {
          const userId = req.user?.id;
          if (!userId) return apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
          const slackUserId = String(req.body?.slack_user_id || '').trim();
          const slackTeamId = String(req.body?.slack_team_id || '').trim() || null;
          if (!slackUserId || !/^[A-Z0-9]{6,30}$/.test(slackUserId)) {
            return apiError(res, 400, 'VALIDATION_ERROR', 'slack_user_id is required');
          }

          // Revoke any existing active mapping for this Slack user that
          // doesn't belong to the current Maroa user. (User self-relinking
          // — same maroa_user_id — is a no-op upsert.)
          try {
            await sbPatch(
              'slack_identities',
              `slack_user_id=eq.${encodeURIComponent(slackUserId)}&revoked_at=is.null&maroa_user_id=neq.${encodeURIComponent(userId)}`,
              { revoked_at: new Date().toISOString() },
            );
          } catch {
            // If there's no row to revoke, PostgREST 404s — ignore.
          }

          // Check if this exact (slack_user_id, maroa_user_id) already exists.
          const existing = await sbGet(
            'slack_identities',
            `slack_user_id=eq.${encodeURIComponent(slackUserId)}&maroa_user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
          );
          if (existing && existing[0]?.id) {
            // Re-activate if it was revoked, otherwise no-op.
            await sbPatch(
              'slack_identities',
              `id=eq.${existing[0].id}`,
              { revoked_at: null, linked_at: new Date().toISOString(), slack_team_id: slackTeamId },
            );
            return res.json({ ok: true, linked: true, reactivated: true });
          }

          await sbPost('slack_identities', {
            slack_user_id: slackUserId,
            slack_team_id: slackTeamId,
            maroa_user_id: userId,
          });
          return res.json({ ok: true, linked: true });
        } catch (err) {
          log?.('/api/slack/link-complete', null, 'failed', { error: err.message });
          return apiError(res, 500, 'INTERNAL_ERROR', safePublicError ? safePublicError(err) : 'link failed');
        }
      },
    );

    // Reverse — unlink from settings UI. User can disconnect Slack any time.
    app.delete('/api/slack/link', requireAnyUserId, async (req, res) => {
      try {
        const userId = req.user?.id;
        if (!userId) return apiError(res, 401, 'UNAUTHORIZED', 'Sign in first');
        await sbPatch(
          'slack_identities',
          `maroa_user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null`,
          { revoked_at: new Date().toISOString() },
        );
        return res.json({ ok: true });
      } catch (err) {
        log?.('/api/slack/link', null, 'unlink failed', { error: err.message });
        return apiError(res, 500, 'INTERNAL_ERROR', safePublicError ? safePublicError(err) : 'unlink failed');
      }
    });
  }

  log?.('/webhook/slack', null, `Slack routes registered (signing_secret ${SLACK_SIGNING_SECRET ? 'set' : 'MISSING'})`);
}

module.exports = { register };
