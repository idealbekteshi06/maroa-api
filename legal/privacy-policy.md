# Privacy Policy

**Effective date:** <<EFFECTIVE_DATE>>

> ⚠️ TEMPLATE — must be reviewed with counsel before publishing.

This Privacy Policy describes how <<COMPANY_LEGAL_NAME>>
("**Maroa**") collects, uses, and shares personal data when you use
Maroa.ai (the "**Service**").

## 1. Information We Collect

### 1.1 You give us directly

- **Account info**: name, email, password (hashed via Supabase Auth)
- **Business profile**: business name, industry, location, target
  audience, brand voice details
- **Payment info**: handled by Paddle as Merchant of Record. We see
  the transaction status + plan, never the full card number.
- **Customer content**: product photos, captions, business assets you
  upload

### 1.2 We collect automatically

- **Usage data**: which features you use, request timestamps, errors
- **Device data**: IP address, user agent, approximate location
- **Logs**: HTTP request metadata (path, status, duration) — retained 30 days hot, 1 year cold
- **OAuth tokens**: when you connect Meta / Google / LinkedIn / etc.,
  we store access + refresh tokens (encrypted at rest via AES-256-GCM)

### 1.3 We collect from third parties

- Performance metrics from connected platforms (Meta Ads Insights,
  Google Ads, Instagram Insights, etc.)
- Public business info (reviews, ratings) when running our voice-of-
  customer analysis

## 2. How We Use Your Data

We use your data to:

- Provide and improve the Service (generate content, run ad campaigns,
  send reports)
- Charge for paid plans (via Paddle)
- Send transactional emails (password resets, weekly scorecards,
  approval requests, billing receipts)
- Send marketing emails to existing customers (you can unsubscribe)
- Detect abuse and prevent fraud
- Comply with legal obligations

We do **not** sell personal data. We do **not** use customer content
to train AI models on a shared basis — your prompts are processed by
Anthropic / Higgsfield under no-training agreements per their
enterprise terms.

## 3. Legal Bases (GDPR)

For EU/UK customers, our legal bases under GDPR Article 6 are:

- **Contract**: processing necessary to deliver the Service you paid for
- **Legitimate interests**: fraud prevention, security monitoring,
  product analytics (we balance these against your rights)
- **Consent**: marketing emails, optional cookies
- **Legal obligation**: tax records, deletion-request handling

## 4. Sharing + Subprocessors

We share data with the third-party services listed in
[Subprocessors](./subprocessors.md). Each subprocessor has a DPA in
place with us and processes data only on our documented instructions.

We may share data:

- With law enforcement when required by valid legal process
- With acquirers in connection with a sale or merger (we'll notify you
  ≥30 days before transfer)
- With your express consent

## 5. International Transfers

Maroa is hosted on infrastructure in <<HOSTING_REGION>>. If you are in
the EEA / UK, your data may be transferred to the United States. We
rely on the **EU-US Data Privacy Framework** and **Standard Contractual
Clauses** for these transfers. EU customers can request the SCCs.

## 6. Retention

| Data                                          | Retention                                         |
| --------------------------------------------- | ------------------------------------------------- |
| Account info                                  | Until account deletion + 30 days                  |
| Customer content (uploads, generated content) | Until you delete it OR account deletion + 30 days |
| OAuth tokens                                  | Until you disconnect OR account deletion          |
| Billing records                               | 7 years (legal requirement)                       |
| HTTP request logs                             | 30 days hot, 1 year cold                          |
| Audit logs (account changes, OAuth grants)    | 2 years                                           |
| Sentry error events                           | 90 days                                           |

After retention windows expire, data is deleted or fully anonymized.

## 7. Your Rights

Depending on your jurisdiction (GDPR, CCPA, UK GDPR, etc.), you have:

- **Access** — request a copy of your data
- **Rectification** — correct inaccurate data
- **Erasure** — delete your account + associated data (some exceptions for legal-retention requirements)
- **Portability** — export your data in a machine-readable format
- **Restriction** — pause processing temporarily
- **Object** — to processing based on legitimate interests
- **Withdraw consent** — for marketing, cookies, etc.
- **Lodge a complaint** — with your data protection authority

To exercise these rights, email **privacy@maroa.ai** or use the in-app
deletion request at <<DELETION_URL>>. We respond within 30 days
(GDPR) / 45 days (CCPA).

## 8. Security

- TLS in transit for every connection
- AES-256-GCM encryption at rest for OAuth tokens
- Supabase Auth + role-based access internal to Maroa
- Regular security reviews + dependency scans (gitleaks, npm audit)
- See [security-policy](../docs/security-policy.md) for full controls

In the event of a personal-data breach, we will notify the relevant
supervisory authority within 72 hours and affected customers
without undue delay.

## 9. Cookies + Tracking

We use:

- **Strictly necessary cookies** — for authentication + session
- **Analytics** — Plausible (privacy-focused; no cross-site tracking)
  OR Posthog (configurable opt-out)
- We do **not** use Google Analytics or Facebook Pixel for our own marketing.

## 10. Children

The Service is not directed to children under 18. We do not knowingly
collect data from anyone under 18.

## 11. Changes

We will announce material changes via email ≥30 days before they take
effect. Minor clarifications may be made without notice.

## 12. Contact

**Privacy questions**: privacy@maroa.ai
**Data Protection Officer**: <<DPO_NAME_AND_EMAIL_IF_APPOINTED>>
**Mailing address**: <<COMPANY_ADDRESS>>

For EU residents: our EU representative under Article 27 GDPR is
<<EU_REPRESENTATIVE_IF_APPLICABLE>>.
