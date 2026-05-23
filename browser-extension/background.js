/**
 * browser-extension/background.js
 * ---------------------------------------------------------------------------
 * MV3 service worker. Registers the context-menu items, listens for clicks,
 * and POSTs the captured payload to Maroa's /api/inspiration/save endpoint.
 *
 * No long-running state — the service worker can be killed any moment and
 * Chrome respawns it on the next event. Settings live in chrome.storage.sync.
 * ---------------------------------------------------------------------------
 */

const DEFAULTS = {
  api_url: 'https://maroa-api-production.up.railway.app',
  token: '',
};

async function getConfig() {
  const stored = await chrome.storage.sync.get(['api_url', 'token']);
  return { ...DEFAULTS, ...stored };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'maroa-save-inspiration',
    title: 'Save to Maroa as inspiration',
    contexts: ['page', 'image', 'link', 'selection'],
    documentUrlPatterns: ['https://*.instagram.com/*', 'https://*.facebook.com/*', 'https://*.tiktok.com/*'],
  });
  chrome.contextMenus.create({
    id: 'maroa-save-as-claim',
    title: 'Save selected text as a Maroa claim',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'maroa-save-inspiration') {
    await captureInspiration({
      source_url: info.pageUrl || tab?.url || null,
      image_url: info.srcUrl || null,
      excerpt: info.selectionText || null,
      tab_title: tab?.title || null,
    });
  }
  if (info.menuItemId === 'maroa-save-as-claim') {
    await captureInspiration({
      source_url: info.pageUrl || tab?.url || null,
      excerpt: info.selectionText || null,
      claim_text: info.selectionText || null,
      tab_title: tab?.title || null,
      hint: 'claim',
    });
  }
});

async function captureInspiration(payload) {
  const cfg = await getConfig();
  if (!cfg.token) {
    notify('Maroa: token not set', 'Open the Maroa popup and add your token to save inspiration.');
    return;
  }
  try {
    const res = await fetch(`${cfg.api_url.replace(/\/$/, '')}/api/inspiration/save`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      },
      body: JSON.stringify({
        source: 'browser_extension',
        captured_at: new Date().toISOString(),
        ...payload,
      }),
    });
    if (res.ok) {
      notify('Saved to Maroa', "I'll learn from this for your next drafts.");
    } else {
      const text = await res.text();
      notify("Couldn't save", `${res.status}: ${text.slice(0, 80)}`);
    }
  } catch (e) {
    notify('Network error', e.message);
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title,
    message,
    priority: 1,
  });
}

// Allow popup + content script to test the connection without exposing the token.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'maroa:test_connection') {
    (async () => {
      const cfg = await getConfig();
      if (!cfg.token) return sendResponse({ ok: false, reason: 'no_token' });
      try {
        const res = await fetch(`${cfg.api_url.replace(/\/$/, '')}/api/workspaces`, {
          headers: { Authorization: `Bearer ${cfg.token}` },
        });
        sendResponse({ ok: res.ok, status: res.status });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message });
      }
    })();
    return true; // async
  }
});
