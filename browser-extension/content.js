/**
 * browser-extension/content.js
 * ---------------------------------------------------------------------------
 * Runs on Instagram / Facebook / TikTok pages. Currently passive — the
 * extension's heavy work lives in background.js + the context-menu flow.
 *
 * Reserved for the future "Save this post" floating button overlay. Today
 * we just listen for the right-click event chain via the host browser; no
 * DOM injection on first ship to keep the extension's review-team risk
 * minimal.
 * ---------------------------------------------------------------------------
 */

console.log('[maroa] content script ready on', location.host);
