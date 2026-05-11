# Maroa.ai — Legal documents

> **⚠️ THESE ARE TEMPLATES, NOT FINAL DOCUMENTS.**
>
> Every document in this folder is a **starting point** that must be
> reviewed by a qualified attorney before publishing. They reflect
> common SaaS practice and Maroa's actual technical practices, but they
> are NOT legal advice and have not been reviewed by counsel.
>
> Cost to convert to publishable: typically $500-1500 with a lawyer who
> handles SaaS contracts. Bringing them a draft (instead of starting from
> blank) saves ~50% of the legal hours.

## What's in here

| File                                         | Purpose                                                                        | Required by                        |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| [terms-of-service.md](./terms-of-service.md) | Master ToS — what Maroa offers, payment terms, SLAs, liability                 | Every paying customer              |
| [privacy-policy.md](./privacy-policy.md)     | What data we collect, why, who we share it with                                | GDPR, CCPA, every customer         |
| [dpa.md](./dpa.md)                           | Data Processing Agreement — controller/processor relationship for EU customers | GDPR Article 28                    |
| [subprocessors.md](./subprocessors.md)       | List of every third party that touches customer data                           | GDPR transparency + customer trust |
| [acceptable-use.md](./acceptable-use.md)     | What customers may NOT do with the platform                                    | All customers                      |

## Hosting

Publish each as a static page on the marketing site:

- `https://maroa.ai/legal/terms`
- `https://maroa.ai/legal/privacy`
- `https://maroa.ai/legal/dpa`
- `https://maroa.ai/legal/subprocessors`
- `https://maroa.ai/legal/acceptable-use`

Link from the dashboard footer + the signup flow.

## Maintenance

When you add a new third-party service (e.g. a new analytics tool),
update `subprocessors.md` and email existing customers per the
"changes" clause in the DPA. Most customers don't need 30 days' notice
for a new subprocessor; the DPA typically allows 14 days for
objection.

## How to use these templates with a lawyer

1. Fill in every `<<PLACEHOLDER>>` with your actual values (entity
   name, address, jurisdictions, etc.)
2. Send the filled-in version to counsel with: "Please review for our
   jurisdiction (US Delaware) and our customer set (EU + US small
   businesses). Flag anything that needs adjustment for our actual
   technical practices."
3. Their job is to fix gaps + add jurisdiction-specific language. Yours
   is to know the technical facts (e.g. that you encrypt at rest, that
   you don't sell data, etc.) — those are already filled in here.
