# services/cro/

Landing-page CRO audit + hero/CTA/value-prop rewrites.

## What it does

**Audit** — given a page's HTML or text content, scores 7 dimensions
(above-the-fold, value prop, CTA, social proof, trust, friction,
mobile) with deterministic checks + LLM synthesis. Returns
`audit_score (0-100)`, dimension breakdown, critical issues, warnings,
opportunities, expected lift band.

**Rewrite** — generates hero headline variants, subhead variants,
primary CTA variants (with style classification), value-prop bullets,
social-proof template, form simplification recs. Per-variant
quality-gate plumbed in (slop check + voice-polish repair).

## Public API

```js
const cro = require('./services/cro')({ sbGet, sbPost, sbPatch, callClaude, extractJSON, logger, Sentry });

await cro.engine.audit({ businessId, html, text });
await cro.engine.rewrite({ businessId, currentHero });
cro.registerRoutes({ app, apiError });
```

Free tier: audit returns deterministic-only baseline + lift band, no LLM call.
Growth/Agency: full audit + advisor wiring.

## Files

| File | What |
|---|---|
| `engine.js` | Pull business profile, dispatch audit/rewrite, persist. |
| `index.js` | Factory + DI. |
| `registerRoutes.js` | HTTP mounting. |

Prompt logic in `../prompts/cro/` (system prompt + scoring + i18n).

## Tests

`tests/cro.test.js`, `tests/psychology-integrations.test.js`, and
`tests/e2e-publish-pipeline.test.js`.
