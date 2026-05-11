# Subprocessors

**Last updated:** <<LAST_UPDATED>>

These third-party services process customer data on behalf of
<<COMPANY_LEGAL_NAME>>. Each has a DPA in place with us. We give
customers ≥30 days' notice before engaging a new subprocessor.

## Active subprocessors

### Core platform

| Subprocessor       | Purpose                     | Data shared                                                          | Region                              | DPA                                              |
| ------------------ | --------------------------- | -------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| **Supabase, Inc.** | Database + auth             | All customer data, OAuth tokens (encrypted), business profiles       | US (default), with EU region option | [Supabase DPA](https://supabase.com/legal/dpa)   |
| **Railway Corp.**  | API hosting + log retention | HTTP request logs, error traces, in-flight data                      | US                                  | [Railway DPA](https://railway.com/legal/dpa)     |
| **Sentry, Inc.**   | Error monitoring            | Error stack traces, request metadata (PII scrubbed via `beforeSend`) | US                                  | [Sentry DPA](https://sentry.io/legal/dpa/)       |
| **Inngest, Inc.**  | Durable job scheduler       | Event payloads (business_id + ids, never raw content)                | US                                  | [Inngest DPA](https://www.inngest.com/legal/dpa) |

### AI

| Subprocessor       | Purpose                                        | Data shared                                                  | Region                   | DPA                                                                                         |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------- |
| **Anthropic, PBC** | LLM (Claude Sonnet 4.5 / Opus 4.7 / Haiku 4.5) | Prompts + customer-supplied context                          | US                       | [Anthropic Commercial Terms / DPA](https://www.anthropic.com/legal) — no-training agreement |
| **Higgsfield AI**  | Image + video generation                       | Image-gen prompts, reference photos, Soul ID training images | US (Cloud) / mixed (FNF) | [Higgsfield Terms](https://higgsfield.ai/legal)                                             |
| **OpenAI, L.L.C.** | Embeddings only (Pinecone vector store)        | Text content snippets for embedding                          | US                       | [OpenAI DPA](https://openai.com/policies/data-processing-addendum) — API tier (no-training) |

### Marketing platforms (customer-authorized)

The following platforms receive data only when Customer authorizes us
via OAuth. We don't share Customer data with them unless Customer
connects their account.

| Platform                                                | Purpose                                                    | Data shared                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| **Meta Platforms, Inc.** (Facebook, Instagram, Threads) | Publish posts, run ads, read insights                      | Posts, captions, image assets, ad budgets                           |
| **Google LLC** (Google Ads)                             | Run + optimize Google Ads campaigns                        | Ad creatives, budgets, conversion data via Enhanced Conversions API |
| **LinkedIn Corporation**                                | Publish to LinkedIn                                        | Posts, organization ID, profile data                                |
| **Ayrshare, Inc.**                                      | Multi-platform social posting (TikTok, YouTube, Pinterest) | Posts + media for connected accounts                                |
| **Twitter / X Corp.**                                   | Publish tweets / threads                                   | Tweet text                                                          |
| **TikTok, Inc.**                                        | Publish TikTok content                                     | Video assets + captions                                             |

### Payments + email

| Subprocessor               | Purpose                                           | Data shared                                                                                | Region  | DPA                                                  |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------- |
| **Paddle.com Market Ltd.** | Merchant of Record, payments, tax                 | Customer email, plan, transaction amount, billing address (we don't see full card numbers) | UK + US | [Paddle DPA](https://www.paddle.com/legal/dpa)       |
| **Stripe, Inc.** (legacy)  | Legacy subscriptions only — not for new customers | Same as Paddle                                                                             | US      | [Stripe DPA](https://stripe.com/legal/dpa)           |
| **Resend.com, Inc.**       | Transactional + marketing email                   | Recipient email, message content                                                           | US      | [Resend DPA](https://resend.com/legal/dpa)           |
| **Twilio Inc.** (WhatsApp) | Optional WhatsApp notifications                   | Phone number, message text                                                                 | US      | [Twilio DPA](https://www.twilio.com/en-us/legal/dpa) |

### Operational

| Subprocessor         | Purpose                            | Data shared                       | Region      | DPA                                                                              |
| -------------------- | ---------------------------------- | --------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| **GitHub, Inc.**     | Source control + CI                | Code, no production data          | US          | [GitHub DPA](https://github.com/customer-terms/github-data-protection-agreement) |
| **Cloudflare, Inc.** | DNS, DDoS protection (via Railway) | HTTP request metadata             | Global edge | [Cloudflare DPA](https://www.cloudflare.com/legal/dpa/)                          |
| **Doppler**          | Secrets management                 | Environment variables (encrypted) | US          | [Doppler DPA](https://www.doppler.com/legal/dpa)                                 |

## Data residency

Most processing happens in the US. EU customers can request:

- **Supabase EU region** — additional fee, requires migration window
- **EU-only AI providers** — currently no such EU-resident vendor matches Anthropic's capability; we use Anthropic + Higgsfield with SCCs

## How to object to a subprocessor

Email **privacy@maroa.ai** within 30 days of our notification. If we
can't reasonably accommodate the objection, you may terminate your
subscription with a pro-rated refund of unused prepayment.

## Change log

| Date             | Change              |
| ---------------- | ------------------- |
| <<INITIAL_DATE>> | Initial publication |
|                  |                     |
