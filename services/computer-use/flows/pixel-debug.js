'use strict';

/**
 * services/computer-use/flows/pixel-debug.js
 * ----------------------------------------------------------------------------
 * Meta Pixel debug flow.
 *
 * Goal: when the Marketing API says "Pixel events are stale" but we can't
 * see WHY (UI-only data), have Claude log in (with a pre-authenticated
 * cookie injected by the runner), navigate to Events Manager → Test
 * Events, send a trigger event, watch for it to appear, and report what
 * happened.
 *
 * Allowed origins:
 *   - facebook.com
 *   - business.facebook.com
 *   - adsmanager.facebook.com
 *
 * Outputs a structured payload that the calling service writes back to
 * the customer's pixel_diagnostics row.
 * ----------------------------------------------------------------------------
 */

const ALLOWED_ORIGINS = ['facebook.com', 'business.facebook.com', 'adsmanager.facebook.com'];

const MAX_ACTIONS = 40;

function describe() {
  return 'Inspect a Meta Pixel via Events Manager → Test Events.';
}

function buildInitialPrompt({ args, businessId, readOnlyPreludeSteps }) {
  const pixelId = args?.pixelId || '';
  const system = `You are a careful, methodical operator helping a small-business owner debug their Meta Pixel.

GROUND RULES:
  - This is a real Meta account. Never take an action that costs money,
    publishes content, deletes data, or modifies settings unless the user
    EXPLICITLY asked for that action in their first message.
  - Your first ${readOnlyPreludeSteps} actions are read-only:
    screenshot, scroll, navigate. Do not click, type, or submit until you
    have at least ${readOnlyPreludeSteps} read-only actions logged.
  - If a screen asks for authentication, STOP and report. Do not enter
    credentials.
  - If a screen shows a confirmation dialog with a destructive verb
    (Delete, Pause, Remove), STOP and report. Do not click confirm.
  - Only navigate to: ${ALLOWED_ORIGINS.join(', ')}. If a redirect leaves
    this allowlist, STOP and report.

WHAT YOU'RE DEBUGGING:
  - Pixel ID: ${pixelId || '(not provided — ask the user)'}
  - Business: ${businessId}

HOW TO PROCEED:
  1. Navigate to business.facebook.com/events-manager (use the leftmost
     menu).
  2. Find the Pixel matching ID ${pixelId}.
  3. Open the "Test Events" tab.
  4. Take a screenshot of the recent events table.
  5. If events are firing: report the last event_name, time, and the URL.
  6. If events are stale or absent: report the last event time, the
     domain reported, and any error banners shown.
  7. Take a final screenshot.

WHAT TO REPORT (always — fill in unknowns honestly):
  {
    "pixel_id": "${pixelId}",
    "status": "firing|stale|absent|unknown",
    "last_event_name": "...",
    "last_event_seconds_ago": 0,
    "source_url": "...",
    "issues": [],
    "screenshots_taken": 0
  }`;

  const firstMessage = pixelId
    ? `Please debug Meta Pixel ${pixelId} now. Start with a screenshot of the page you land on after navigating to Events Manager.`
    : 'I need you to debug a Meta Pixel but the ID wasn’t provided. Stop and report this.';

  return { system, firstMessage };
}

module.exports = {
  describe,
  buildInitialPrompt,
  allowedOrigins: ALLOWED_ORIGINS,
  maxActions: MAX_ACTIONS,
};
