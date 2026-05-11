'use strict';

/**
 * routes/status-page.js — Self-hosted public status page.
 *
 * Mounted at GET /status. Returns a single-file HTML page with
 * client-side JS that polls /healthz + /readyz every 30 seconds and
 * displays live status of every critical dependency (Supabase,
 * Anthropic, Inngest, Higgsfield).
 *
 * Why self-hosted vs. statuspage.io:
 *   - Zero monthly cost ($29-99/mo saved)
 *   - No third-party signup
 *   - Data stays inside our infrastructure
 *   - Reflects ACTUAL system health (statuspage.io is operator-curated)
 *
 * Trade-offs (and Phase 7 enhancements):
 *   - No historical uptime visualization — Phase 7 adds an Inngest cron
 *     that snapshots health every 5 min into the events table, and the
 *     status page renders a 90-day uptime bar.
 *   - No notification system — Phase 7 wires email/SMS via the existing
 *     Resend / Twilio integrations when /readyz flips to error.
 *   - No mobile-app pings — Phase 7 if/when there's an app.
 *
 * For now: it's a real-time mirror of /readyz, which is what 95% of
 * status pages do anyway.
 */

const STATUS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Maroa.ai Status</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9C%85%3C/text%3E%3C/svg%3E">
  <style>
    :root {
      --green: #22c55e;
      --yellow: #eab308;
      --red: #ef4444;
      --gray: #6b7280;
      --bg: #0a0a0a;
      --card: #18181b;
      --text: #fafafa;
      --muted: #a1a1aa;
      --border: #27272a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      line-height: 1.5;
      padding: 2rem 1rem;
      min-height: 100vh;
    }
    .container { max-width: 720px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 2.5rem; }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .timestamp {
      color: var(--muted);
      font-size: 0.875rem;
    }
    .overall {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      text-align: center;
    }
    .overall-title { font-size: 0.875rem; color: var(--muted); margin-bottom: 0.5rem; }
    .overall-status {
      font-size: 1.5rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
    }
    .dot {
      display: inline-block;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-green { background: var(--green); box-shadow: 0 0 12px rgba(34, 197, 94, 0.5); }
    .dot-yellow { background: var(--yellow); box-shadow: 0 0 12px rgba(234, 179, 8, 0.5); }
    .dot-red { background: var(--red); box-shadow: 0 0 12px rgba(239, 68, 68, 0.5); }
    .dot-gray { background: var(--gray); }
    .checks {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .check {
      display: flex;
      align-items: center;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
    }
    .check:last-child { border-bottom: none; }
    .check-name {
      font-weight: 500;
      flex: 1;
    }
    .check-status {
      color: var(--muted);
      font-size: 0.875rem;
      margin-right: 0.75rem;
    }
    .check-error {
      color: var(--red);
      font-size: 0.75rem;
      font-family: ui-monospace, SFMono-Regular, monospace;
      margin-top: 0.25rem;
    }
    .meta {
      text-align: center;
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: var(--muted);
    }
    .meta a { color: var(--muted); text-decoration: underline; }
    .badge {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .badge-green { background: rgba(34, 197, 94, 0.15); color: var(--green); }
    .badge-yellow { background: rgba(234, 179, 8, 0.15); color: var(--yellow); }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: var(--red); }
    .latency {
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 0.75rem;
      color: var(--muted);
      margin-left: 0.5rem;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #fafafa; --card: #fff; --text: #18181b;
        --muted: #71717a; --border: #e4e4e7;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Maroa.ai Status</h1>
      <div class="timestamp" id="ts">Loading…</div>
    </header>

    <div class="overall">
      <div class="overall-title">Current status</div>
      <div class="overall-status" id="overall">
        <span class="dot dot-gray"></span>
        <span>Checking…</span>
      </div>
    </div>

    <div class="checks" id="checks">
      <div class="check"><div class="check-name">Initializing…</div></div>
    </div>

    <div class="meta">
      Polls every 30 seconds. Source: <code>/readyz</code>.<br>
      Incident? Email <a href="mailto:hello@maroa.ai">hello@maroa.ai</a>.
    </div>
  </div>

  <script>
    const CHECK_LABELS = {
      supabase: 'Database (Supabase)',
      anthropic: 'AI (Anthropic Claude)',
      inngest: 'Job scheduler (Inngest)',
      higgsfield: 'Image / video (Higgsfield)',
    };

    async function poll() {
      const tsEl = document.getElementById('ts');
      const overallEl = document.getElementById('overall');
      const checksEl = document.getElementById('checks');
      try {
        const res = await fetch('/readyz', { cache: 'no-store' });
        const data = await res.json();
        const ts = new Date().toLocaleString();
        tsEl.textContent = 'Last checked: ' + ts;

        const checks = data.checks || {};
        const allOk = Object.values(checks).every((c) => c.ok);
        const someOk = Object.values(checks).some((c) => c.ok);

        if (allOk && res.ok) {
          overallEl.innerHTML = '<span class="dot dot-green"></span><span>All systems operational</span>';
        } else if (someOk) {
          overallEl.innerHTML = '<span class="dot dot-yellow"></span><span>Partial degradation</span>';
        } else {
          overallEl.innerHTML = '<span class="dot dot-red"></span><span>Service disruption</span>';
        }

        checksEl.innerHTML = '';
        for (const [key, value] of Object.entries(checks)) {
          const label = CHECK_LABELS[key] || key;
          const ok = !!value.ok;
          const badge = ok ? 'badge-green' : 'badge-red';
          const badgeText = ok ? 'OPERATIONAL' : 'DOWN';
          const reason = value.reason ? '<div class="check-error">' + value.reason + '</div>' : '';
          checksEl.insertAdjacentHTML('beforeend',
            '<div class="check">' +
              '<div class="check-name">' + label + reason + '</div>' +
              '<span class="badge ' + badge + '">' + badgeText + '</span>' +
            '</div>'
          );
        }
        if (typeof data.duration_ms === 'number') {
          checksEl.insertAdjacentHTML('beforeend',
            '<div class="check">' +
              '<div class="check-name" style="color: var(--muted); font-size: 0.875rem;">Last check duration</div>' +
              '<span class="latency">' + data.duration_ms + 'ms</span>' +
            '</div>'
          );
        }
      } catch (e) {
        tsEl.textContent = 'Last check failed at ' + new Date().toLocaleString();
        overallEl.innerHTML = '<span class="dot dot-red"></span><span>Status check failed</span>';
        checksEl.innerHTML = '<div class="check"><div class="check-name">' +
          'Could not reach /readyz endpoint: ' + (e?.message || 'unknown error') + '</div></div>';
      }
    }

    poll();
    setInterval(poll, 30000);
  </script>
</body>
</html>`;

function register({ app }) {
  // Mount at /status — public, no auth, no rate limit. The page itself
  // polls /readyz which DOES have rate-limit + auth (where applicable).
  app.get('/status', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(STATUS_HTML);
  });
}

module.exports = { register };
