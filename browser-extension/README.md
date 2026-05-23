# Maroa browser extension

MV3 Chrome extension. Right-click any Instagram / Facebook / TikTok post →
_Save to Maroa as inspiration_ → it lands in your cold-start corpus and
shapes the next round of drafts.

## Why it exists (distribution wedge)

Every café owner who installs this gives Maroa a permanent foothold on
their browser. Every time they see a competitor post they love and save
it, the corpus gets sharper. Compounding distribution.

## Install (developer / unreleased)

1. Clone this repo
2. Open Chrome → `chrome://extensions`
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked** → select `browser-extension/`
5. Click the Maroa icon → paste your API URL + token

Once the extension hits the Chrome Web Store (target: Week 4 of the
30-day plan), normal users install with one click.

## What it does

- Right-click on any IG / FB / TikTok page → "Save to Maroa as inspiration"
- Right-click on selected text → "Save selected text as a Maroa claim"
- POSTs to `/api/inspiration/save` with the URL, image, and selected text
- Backend stores it as a `marketing_graph_entities` row of type `inspiration`
- Cold-start corpus picks it up on the next pretrainer sweep

## Permissions

- `contextMenus` — to register the right-click items
- `activeTab` — to read the URL of the page the user right-clicked on
- `storage` — to remember the API URL + token
- `notifications` — to confirm a save happened

Hosts allowed: only Instagram, Facebook, TikTok, Threads + the Maroa API.
No `<all_urls>`. No tracking. No telemetry.

## Privacy

The extension only talks to the API URL you configure. It does not run
any analytics. The selected text + page URL you save are visible to your
Maroa workspace owner only (RLS enforced server-side).

## Building for the Web Store

Pack from the repo root:

```bash
cd browser-extension
zip -r ../maroa-extension.zip . -x '*.DS_Store'
```

Upload `maroa-extension.zip` via the Chrome Developer Dashboard. First
review typically takes 3-5 business days.

## License

MIT
