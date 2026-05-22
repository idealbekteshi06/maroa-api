# Platform Updates 2026 — Maroa Implementation Map

Last updated: May 2026. This doc tracks what Anthropic, Meta, and Higgsfield shipped and how Maroa uses it.

## 1. Anthropic API

| Feature | Maroa implementation | Env / endpoint |
|--------|----------------------|----------------|
| **Advisor Tool** (`advisor-tool-2026-03-01`) | `lib/marketingClaude.js` + `callClaude` tools | `MAROA_ADVISOR_ENABLED` |
| **Web search** (`web_search_20260209`) | Gated per plan; competitor + AI SEO | `lib/webSearchGate.js` |
| **Extended output 300k (batch)** | `lib/platformAnthropic.js`; WF1 monthly + scorecard batch | `POST /webhook/wf1-monthly-batch-submit` |
| **Code execution** (`code_execution_20260120`) | Monthly analytics report | `POST /api/business/:id/monthly-report` |
| **Cache diagnostics** | `lib/cacheDiagnostics.js` + `diagnostics.previous_message_id` | `MAROA_CACHE_DIAGNOSTICS` (default on) |
| **Managed Agents + MCP tunnel** | Deep dive agent | `MAROA_MCP_TUNNEL_URL`, `POST .../marketing-deep-dive` |
| **Dreaming (beta)** | Autopilot → `brain_memory.recent_learnings` | `MAROA_DREAMING_ENABLED`, `MAROA_DREAMING_API_URL` |

### Batch token caps (plan-aware)

| Plan | WF1 overnight | WF1 monthly | Weekly scorecard |
|------|---------------|-------------|------------------|
| Agency | 4k daily / 128k monthly | 131,072 | 24,576 |
| Growth | 4k / 32k | 32,768 | 12,288 |
| Starter | 4k | 8,192 | 4,096 |

## 2. Meta Marketing API

| Change | Maroa implementation |
|--------|----------------------|
| **Viewers → Reach** (June 2026) | `lib/metaMetrics.js` — dual storage `reach` + `viewers`, `sumAudienceMetric()` |
| **Threads feed ads** | `routes/meta-campaigns.js` — `threads_positions` when objective eligible |

Set `META_GRAPH_API_VERSION=v22.0` and `META_VIEWERS_CUTOVER=2026-06-01`.

## 3. Higgsfield

| Capability | Model key | Path env |
|------------|-----------|----------|
| UGC Builder (Veo 3) | `ugc veo 3` | `HIGGSFIELD_PATH_UGC_VEO` |
| Higgsfield Speak (lip-sync) | `higgsfield speak` | `HIGGSFIELD_PATH_SPEAK` |
| WAN 2.5 audio | `wan 2.5` | `HIGGSFIELD_PATH_WAN_25` |
| Sora 2 / Veo 3.1 / DOP | existing router | unchanged |

Use `routeModelForContentType('ugc_testimonial')` in `services/higgsfield/` (2026 SDK + smart router). Legacy `modelForCapability()` remains for WF1/creative-engine paths.

## 4. vs Claude for Small Business

See [COMPETITIVE_POSITIONING.md](./COMPETITIVE_POSITIONING.md).

**Maroa moat:** Meta + Google ads execution, quality gate, Inngest ops, SMB plan caps — not generic Cowork chat.
