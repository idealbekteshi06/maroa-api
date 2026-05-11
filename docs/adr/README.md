# Architecture Decision Records

Numbered, append-only log of meaningful architectural decisions. Read
these to understand *why* something is the way it is — the code answers
*what* and *how*; ADRs answer *why*.

| # | Title | Date | Status |
|---|---|---|---|
| [0001](./0001-migrate-off-n8n-to-inngest.md) | Migrate workflow runtime from n8n Cloud to Inngest | 2026-04 | Accepted |
| [0002](./0002-app-side-oauth-token-encryption.md) | Encrypt OAuth tokens at rest via app-side AES-256-GCM (not pgcrypto) | 2026-05 | Accepted |
| [0003](./0003-cost-discipline-via-callclaude-facade.md) | Single `callClaude` facade for cost + retries + caching + budget | 2026-05 | Accepted |

## When to write an ADR

Write one when:
- You changed how a major subsystem works (e.g. job scheduler, auth,
  payment provider).
- You picked between two non-trivial alternatives and want future-you
  to remember why.
- A decision has consequences that aren't obvious from reading the code
  (e.g. "we chose X *because* Supabase doesn't let us do Y").

## Template

```markdown
# ADR-NNNN: Short title in imperative voice

**Date:** YYYY-MM · **Status:** Proposed | Accepted | Superseded by ADR-XXXX

## Context
What's the problem? What forced this decision?

## Decision
What did we pick? Be specific.

## Alternatives considered
Table of options + one-line rejection reason.

## Consequences
Positive + Negative. Honest about tradeoffs.

## Operational notes
How to use the resulting thing day-to-day.
```
