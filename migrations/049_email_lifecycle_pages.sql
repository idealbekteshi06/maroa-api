-- migrations/049_email_lifecycle_pages.sql
-- Week 10 — Email lifecycle + landing page generator

-- ─── Email lifecycle ─────────────────────────────────────────────────────
-- Six lifecycle stages: welcome, nurture, abandoned, post_purchase,
-- re_engagement, win_back. One sequence per business per stage.
CREATE TABLE IF NOT EXISTS email_sequences (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stage           text          NOT NULL CHECK (stage IN ('welcome','nurture','abandoned_cart','post_purchase','re_engagement','win_back')),

  is_active       boolean       NOT NULL DEFAULT true,
  trigger_event   text          NOT NULL,       -- 'signup' | 'cart_abandoned_24h' | 'no_open_30d' | etc.
  step_count      int           NOT NULL DEFAULT 0,
  cadence_days    int[]         NOT NULL DEFAULT ARRAY[]::int[],  -- e.g. [0, 2, 7] for 3 emails

  template_payload jsonb        NOT NULL DEFAULT '{}'::jsonb,     -- per-step subjects + bodies

  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (business_id, stage)
);

CREATE TABLE IF NOT EXISTS email_sequence_runs (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id     uuid          NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  business_id     uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Recipient (a customer of the business — different from the business owner)
  recipient_email text          NOT NULL,
  recipient_name  text          NULL,

  current_step    int           NOT NULL DEFAULT 0,
  status          text          NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','unsubscribed','bounced','failed')),

  started_at      timestamptz   NOT NULL DEFAULT now(),
  next_send_at    timestamptz   NULL,
  completed_at   timestamptz   NULL,

  -- Per-send tracking
  send_log        jsonb         NOT NULL DEFAULT '[]'::jsonb,    -- [{step, sent_at, opened, clicked, resend_id}]

  created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_runs_due
  ON email_sequence_runs (next_send_at) WHERE status = 'running' AND next_send_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_runs_business_status
  ON email_sequence_runs (business_id, status);

-- ─── Landing pages ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS landing_pages (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  slug            text          NOT NULL,                          -- URL slug
  page_type       text          NOT NULL CHECK (page_type IN ('homepage','product','service','lead_capture','event','seasonal')),

  -- Content
  hero_headline   text          NOT NULL,
  hero_subhead    text          NULL,
  hero_image_url  text          NULL,
  hero_video_url  text          NULL,
  cta_label       text          NOT NULL,
  cta_url         text          NULL,
  body_sections   jsonb         NOT NULL DEFAULT '[]'::jsonb,    -- [{ type, content }, ...]

  -- Deploy state
  status          text          NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','deployed','archived')),
  deployed_url    text          NULL,
  deploy_target   text          NULL CHECK (deploy_target IN ('vercel','cloudflare_pages','customer_domain') OR deploy_target IS NULL),
  deployed_at     timestamptz   NULL,

  -- CRO scores at time of generation
  cro_score       int           NULL,
  cro_findings    jsonb         NULL,

  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),

  UNIQUE (business_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_landing_pages_business_status
  ON landing_pages (business_id, status);
