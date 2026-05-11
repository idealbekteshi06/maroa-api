# ADR-0003: Single `callClaude` facade for cost + retries + caching + budget

**Date:** 2026-05 · **Status:** Accepted

## Context

LLM costs are the largest variable expense in Maroa. At 50 customers,
an unguarded callsite can easily spend $300/month per customer if a
prompt loops. A single runaway customer can turn a $99/month subscription
into a $400/month loss.

Before this ADR, the codebase had:
- 3 direct `apiRequest('POST', 'https://api.anthropic.com/v1/messages', ...)`
  calls that bypassed every safety mechanism (no retries, no cache, no
  cost tracking, no budget gate).
- A `costGuard` middleware that read from `llm_cost_logs`, but
  `costTracker.track()` was never actually called — so the logs were
  always empty and the guard always soft-allowed.
- Per-skill model routing exists (`selectModel`) but most calls used
  Sonnet by default — no Haiku routing for cheap classification, no
  Opus-advisor for hard decisions.

## Decision

Every Claude call goes through the single `callClaude()` facade in
`server.js`. The facade:

1. **Routes to the right model.** Sonnet 4.5 default, Haiku 4.5 for
   classification/caption/hashtags, Opus 4.7 for strategy + advisor
   pattern when caller opts in.
2. **Enforces token budget.** Per-business monthly cap from
   `lib/costGuard.js`. Returns HTTP 402 if exceeded.
3. **Tracks cost.** Calls `observability.costTracker.track()` on every
   200 response. Real spend lands in `llm_cost_logs`. The cost dashboard
   becomes real.
4. **Retries with exponential backoff.** 3 attempts on 429 / 5xx /
   timeouts.
5. **Auto-injects brand voice.** When `extra.skill` is a content-type
   skill, the business's `brand_voice_anchor` is prepended to the
   system prompt (5-min cache).
6. **Accepts both call shapes** — the positional `(prompt, model, max,
   extra)` form used by legacy callers AND the object `({system, user,
   model, max_tokens, extra})` form used by services/prompts/.
7. **Supports prompt caching** via `extra.cacheSystem`.
8. **Honors files API + citations** via `extra.fileIds` + `extra.citations`.
9. **Routes advisor pattern** when called via
   `services/prompts/advisor-tool.callWithAdvisor()`.

## Alternatives considered

| Option | Why we didn't pick it |
|---|---|
| Per-service Anthropic clients | 50+ services each with their own retry/cost code = 50+ places to fix when something changes. The facade is one fix point. |
| LangChain / similar abstraction | Adds an opinionated framework on top of an already-simple API. The savings don't justify the new abstraction. |
| Switch to OpenAI mid-call (multi-provider) | We picked Anthropic deliberately. Multi-provider is Phase 5+ if at all. |

## Consequences

**Positive:**
- One file owns LLM call semantics. New features (e.g. streaming,
  tool-use, batch API) plug in once.
- Cost dashboards become real. Per-business monthly caps actually
  enforce.
- "Why did this prompt fail?" is one set of logs to inspect, not 50.
- Adding the brand-voice + cost-track + advisor wiring happens in one
  place; downstream callers benefit automatically.

**Negative:**
- `callClaude` is now ~140 lines and supports two call shapes. Some
  complexity is justified (legacy compat + features); some is not
  (eventually consolidate to one shape after every caller migrates).
- Tests for `callClaude` are partially against fakes. Real integration
  tests would need fake-anthropic mode in CI (deferred).

## Operational notes

- **Never** add a new `apiRequest(POST, anthropic.com/...)` call. Use
  `callClaude` so cost-tracking + budget gates apply.
- New skills go in the `_CONTENT_SKILLS` set in `server.js` if they
  should auto-load brand voice.
- Cost budget overrides per plan: env vars
  `COST_CAP_FREE_USD` / `..._STARTER_USD` / `..._GROWTH_USD` /
  `..._AGENCY_USD`. Default caps in `lib/costGuard.js`.
