/* eslint-disable no-undef */
'use strict';

const apiInput = document.getElementById('api');
const tokenInput = document.getElementById('token');
const status = document.getElementById('status');

(async () => {
  const stored = await chrome.storage.sync.get(['api_url', 'token']);
  apiInput.value = stored.api_url || 'https://maroa-api-production.up.railway.app';
  tokenInput.value = stored.token || '';
})();

document.getElementById('cfg').addEventListener('submit', async (e) => {
  e.preventDefault();
  const api_url = apiInput.value.trim();
  const token = tokenInput.value.trim();
  await chrome.storage.sync.set({ api_url, token });
  status.textContent = 'Saved. Testing…';
  status.className = 'status';
  chrome.runtime.sendMessage({ type: 'maroa:test_connection' }, (r) => {
    if (r?.ok) {
      status.textContent = '✓ Connected. Right-click any post to save.';
      status.className = 'status ok';
    } else {
      status.textContent = `✗ ${r?.reason || 'unknown error'} (status ${r?.status || ''})`;
      status.className = 'status err';
    }
  });
});
