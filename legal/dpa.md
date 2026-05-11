# Data Processing Agreement (DPA)

**Between:**

- **Controller** ("**Customer**"): the entity that signs up for Maroa
- **Processor** ("**Maroa**"): <<COMPANY_LEGAL_NAME>>, <<INCORPORATED_IN>>

This DPA forms part of the Terms of Service and applies when Customer is
established in the European Economic Area, the United Kingdom, or
Switzerland — or processes personal data of individuals in those regions.

> ⚠️ TEMPLATE — review with counsel + adapt to your entity. Standard
> Contractual Clauses (SCCs) referenced below should be the most current
> version from the EU Commission (Module Two: Controller-to-Processor).

## 1. Definitions

Terms defined in the GDPR (Regulation (EU) 2016/679) have the same
meaning here. "**Personal Data**" means data described in Annex I that
Maroa processes on Customer's behalf.

## 2. Subject Matter + Duration

Maroa processes Personal Data to provide the Service for the duration
of the subscription, plus the 30-day deletion window after termination.

## 3. Nature + Purpose of Processing

Maroa generates marketing content, runs ad campaigns, posts to social
media, and reports on performance — all on Customer's behalf and per
Customer's documented instructions (the Terms of Service + Customer
configuration in the dashboard).

## 4. Categories of Data Subjects

- Customer's end customers (when Customer uploads reviews / leads)
- Customer's employees / admins with dashboard access

## 5. Categories of Personal Data

- Names + email addresses
- Business contact information
- Customer reviews + testimonials (where Customer uploads them)
- IP addresses + device data (when end-customers visit Customer's tracked landing pages)

Maroa does NOT receive special categories (health, ethnicity, etc.)
unless Customer explicitly uploads them, which is not permitted by
these terms.

## 6. Processor Obligations

Maroa will:

1. Process Personal Data **only on documented Customer instructions**,
   except as required by EU/Member State law (in which case Maroa will
   notify Customer before processing unless prohibited by law)
2. Ensure persons authorized to process Personal Data are bound by
   **confidentiality**
3. Implement appropriate **technical + organizational measures** per
   Annex II (e.g. AES-256-GCM encryption, TLS in transit, RBAC,
   pen-testing)
4. Assist Customer with **data subject requests** (GDPR Arts. 12-23)
   within 14 days of receipt
5. Assist Customer with **DPIAs + supervisory authority consultations**
   (GDPR Arts. 35-36)
6. Notify Customer of a **personal-data breach** without undue delay,
   and within 72 hours where feasible
7. At Customer's choice, **delete or return** Personal Data at the end
   of services + delete copies (subject to legal retention)
8. Provide Customer with information needed to demonstrate compliance
   - allow audits (see Section 9)

## 7. Sub-Processors

Maroa engages sub-processors listed in [Subprocessors](./subprocessors.md).
Maroa will:

- **Notify** Customer ≥30 days before engaging a new sub-processor
- Allow Customer to **object** within 14 days of notification
- Bind every sub-processor in writing to **equivalent protections**
- Remain **liable** to Customer for any sub-processor's failure

Customer's continued use of the Service after a sub-processor change
notification, without timely objection, constitutes approval.

## 8. International Transfers

To the extent Maroa or a sub-processor processes Personal Data outside
the EEA / UK / Switzerland, transfers are protected by:

- **EU-US Data Privacy Framework** (where the recipient is certified)
- **Standard Contractual Clauses** (Module Two: Controller-to-Processor),
  incorporated by reference, with the **docking clause** activated for
  multi-party situations
- For UK transfers: the **UK International Data Transfer Addendum**
- For Swiss transfers: equivalent measures recognized by FDPIC

Customer can request the executed SCCs by emailing privacy@maroa.ai.

## 9. Audits

Once per 12-month period (and additionally after any data breach),
Customer may audit Maroa's compliance through:

- **Written questionnaires** answered within 14 days
- **SOC 2 reports** or equivalent attestation reports (when available)
- **On-site audits** with 30 days' written notice (Customer pays its
  own audit costs)

## 10. Liability

The liability cap in the Terms of Service applies to this DPA. The
DPA does not increase or decrease the cap.

## 11. Term + Termination

This DPA terminates automatically with the underlying Terms of Service.
Sections that by their nature should survive (confidentiality, audit
rights for past processing) survive termination.

## 12. Governing Law

This DPA is governed by the law of the Customer's EU/UK location (per
the SCCs). Disputes go to the courts of the same.

## 13. Order of Precedence

If a conflict exists, the order is: this DPA → SCCs → Terms of Service.

---

## Annex I — Description of Processing

**Subject matter**: AI-generated marketing services
**Nature**: hosting, copy, transmission, analysis, generation
**Purpose**: providing the Service
**Categories of data subjects**: see Section 4
**Categories of Personal Data**: see Section 5
**Frequency**: continuous during subscription
**Duration**: term of the underlying contract + 30 days for deletion

## Annex II — Technical + Organizational Measures (TOMs)

Maroa implements the following safeguards (current state — improvements
without reduction will be made without notice; reductions require
Customer notification):

### Access controls

- Role-based access (RBAC) via Supabase Auth
- Service-role keys stored in environment variables (Doppler / Railway), never source-controlled
- Per-business data isolation enforced at query layer (PostgREST filters)
- OAuth state binding to authenticated user (HMAC-signed, 30-min expiry)

### Encryption

- TLS 1.2+ for all connections (frontend → API, API → Supabase, API → third parties)
- AES-256-GCM at rest for OAuth tokens (`lib/oauthCrypto.js`)
- Supabase column-level encryption available on request for special-category data

### Network + infrastructure

- Hosted on Railway (US-region) with auto-scaling + DDoS protection
- Supabase Postgres with daily backups + 7-day point-in-time recovery
- WAF rules + per-IP rate limiting + abuse-pattern detection (`lib/abuseDetector.js`)
- Circuit breakers on all third-party calls (15-30s timeouts, 3-retry budget)

### Operational

- Structured request logging with PII scrubber (Sentry `beforeSend` strips auth headers, tokens, emails)
- Webhook idempotency via `webhook_events` table (at-most-once delivery)
- Migration ledger with content checksums (`_migrations` table)
- Mandatory PR review on critical paths
- CI runs lint + tests + npm audit (high+) + gitleaks secret scan on every push
- 72-hour incident response with documented runbook + RTO/RPO targets

### Data subject rights

- In-app deletion request endpoint with confirmation email
- 30-day fulfillment window
- Hard delete from Postgres + soft delete from analytics (anonymized after 90 days)
- Public status of any specific deletion request via confirmation code

### Sub-processor management

- All sub-processors have DPAs with Maroa
- See [Subprocessors](./subprocessors.md) for current list
- 30-day notification before adding new sub-processors

### Personnel

- Background checks on personnel with production access
- Mandatory annual security training
- Confidentiality obligations in employment / contractor agreements
- Access revoked within 24h of termination

---

**Customer signature**: by clicking "I accept" during checkout, the
authorized representative of Customer accepts this DPA on behalf of
the Customer entity.

**Maroa signature**: <<SIGNATORY_NAME>>, <<TITLE>>, <<COMPANY_LEGAL_NAME>>
