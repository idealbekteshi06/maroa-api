# services/computer-use

Claude Computer Use (beta) orchestration for the Meta Ads UI-only gaps.

## What this is

When Meta's Marketing API doesn't cover what we need (Pixel debugging,
some Reels placements, account safety appeals), Claude drives a
sandboxed Chromium browser through Anthropic's Computer Use beta. This
service is the orchestration + safety layer; the actual browser worker
runs in a separate container (`services/computer-use/runner-worker.js` —
ship as a deploy-time module).

## Safety model

These guarantees are load-bearing. Don't weaken without writing an ADR.

1. **Dry-run by default.** Every flow runs with `dryRun: true` unless
   the caller passes `dryRun: false` AND `operatorOptIn: true` AND
   the env flag `COMPUTER_USE_ENABLED=1` is set in production.
2. **Sandboxed worker.** Browser runs in a Docker container with no
   host filesystem access. The container is a separate deploy target.
3. **Read-only prelude.** The first 10 actions of every flow are
   restricted to screenshot / scroll / navigate.
4. **Action cap.** Default 60 actions per flow. Hard limit at 120.
5. **Origin allowlist.** Each flow declares its allowed origins; the
   runner aborts if the model tries to navigate elsewhere.
6. **Audit log.** Every run is written to `computer_use_runs` with the
   businessId, flow, args, screenshots, and final outcome.

## Public API

```js
const { createComputerUseService } = require('./services/computer-use');

const cu = createComputerUseService({
  apiKey: env.ANTHROPIC_KEY,
  logger,
  sbPost,
  sbPatch,
});

// Dry-run a flow (safe — returns the plan, no browser):
const plan = await cu.runFlow({
  businessId,
  flow: 'pixel-debug',
  args: { pixelId: '1234567890' },
  dryRun: true,
});

// Live run (requires all three: dryRun:false + operatorOptIn:true + env
// COMPUTER_USE_ENABLED=1). Returns the structured outcome from the flow.
const outcome = await cu.runFlow({
  businessId,
  flow: 'pixel-debug',
  args: { pixelId: '1234567890' },
  dryRun: false,
  operatorOptIn: true,
});
```

## Flows shipped today

- **`pixel-debug`** — Inspect a Meta Pixel via Events Manager → Test
  Events. Returns `{ status, last_event_name, last_event_seconds_ago,
source_url, issues[] }`.

## Adding a new flow

1. Create `flows/<name>.js` exporting:
   - `describe()` — one-line summary
   - `buildInitialPrompt({ args, businessId, readOnlyPreludeSteps })`
     — returns `{ system, firstMessage }`
   - `allowedOrigins` — array of hostnames
   - `maxActions` — hard cap for this flow
2. Register in `FLOWS` map in `index.js`.
3. Test in dry-run. Have an operator review the plan output before
   flipping to live.
4. Ship behind `COMPUTER_USE_ENABLED=1`.

## Runner worker

`runner-worker.js` is the optional Playwright-backed module that
actually drives the browser. Deploy it as a separate Docker image with:

- Playwright Chromium pinned
- `--no-sandbox` flag inside the unprivileged container
- No volume mounts (read-only filesystem)
- Network policy limited to the flow's allowed origins
- Stdin/stdout JSON-RPC bridge to the orchestrator above

When the runner module isn't present, dry-run is the only available
mode (the orchestrator returns `status: 'failed'` with a clear
`runner-not-deployed` error on live calls). This lets the orchestrator
ship into the main API container without the browser dependency.

## Audit + observability

- Every run writes to `computer_use_runs` (migration: schema TBD).
- Logger field `service: 'computer-use'` is the searchable tag.
- Sentry sees any thrown error from `runFlow`.

## Roadmap

- `audience-tweak` — adjust a custom audience that the API can't reach.
- `safety-appeal` — file an account-level safety appeal.
- `reels-placement` — schedule a Reels-only ad variant.
- Migration `072_computer_use_runs.sql` for the audit table.
