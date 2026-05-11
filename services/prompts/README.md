# services/prompts/

Versioned, modular prompt modules. One folder per capability. Every
customer-facing LLM call ultimately routes through one of these.

## Why this structure

Inline prompt strings rot fast: they lose version history in PR diffs,
duplicate across callers, and can't be tested in isolation. Each module
here exports:

- A system prompt builder (cacheable via Anthropic prompt caching)
- A user-message builder
- An output-schema validator (zod or hand-rolled)
- Top-level entry function that the engine calls

## Skills

| Folder                  | What                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `ad-optimizer/`         | Daily ad audit synthesis. 22+ deterministic checks + LLM scoring + advisor wiring.                  |
| `advisor-tool/`         | Anthropic Advisor Tool wrapper. `callWithAdvisor` decides per-task whether to layer Opus on Sonnet. |
| `ai-seo/`               | AI-search citability audit (ChatGPT/Perplexity/Claude).                                             |
| `brand-voice/`          | Per-business voice anchor builder. `formatAnchorForPrompt` injects into any system block.           |
| `creative-director/`    | Concept generation with recursive self-assessment.                                                  |
| `cro/`                  | Landing-page audit + hero/CTA/value-prop rewrites.                                                  |
| `decision-narrator/`    | "Show your work" narrative for any decision (scale/pause/keep).                                     |
| `email-design/`         | HTML email + inline SVG chart builder.                                                              |
| `execution-mode/`       | Autonomy-mode decision per business (full / approval-required).                                     |
| `forecasting/`          | ROAS/spend forecast 30-90d.                                                                         |
| `higgsfield/`           | Higgsfield image-prompt enhancement.                                                                |
| `image-vetter/`         | Customer-uploaded image quality verdict.                                                            |
| `marketing-psychology/` | 75 mental models library + apply/audit.                                                             |
| `memory-loop/`          | Per-business memory beta wrapper.                                                                   |
| `pacing-alerts/`        | 4-hour ad-spend pacing eval.                                                                        |
| `quality-gate/`         | 6-check pre-flight quality gate (slop + specificity + brand-voice + claim + language + advisor).    |
| `voc/`                  | Voice-of-customer extraction.                                                                       |
| `voice-polish/`         | AI-slop detection + repair.                                                                         |
| `weekly-scorecard/`     | Sunday narrative + commentary.                                                                      |

Plus `foundation.js` + `manifest.json` (registry — currently informational;
versioning enforced via `_quality_gate.version` field per call).

Skill-to-Inngest mappings live in `services/inngest/functions.js`.

## Eval harness

`scripts/eval-prompts.js` + `tests/fixtures/prompts/<skill>.json`.
Add one fixture per representative scenario. Dry mode validates
post-processing on stubbed output; live mode (deferred) calls real Claude.

See [`tests/fixtures/prompts/_README.md`](../../tests/fixtures/prompts/_README.md) for the fixture schema.

## Brand-voice auto-injection

When a customer-facing call sets `extra.skill` to one of the content-type
skills (`social_post`, `caption`, `ad_copy`, `hero_rewrite`, …),
`callClaude` automatically loads the business's `brand_voice_anchor`
(5-min cache) and prepends it to the system prompt. See
[ADR-0003](../../docs/adr/0003-cost-discipline-via-callclaude-facade.md).
