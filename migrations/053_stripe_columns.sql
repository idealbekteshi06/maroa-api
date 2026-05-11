-- migrations/053_stripe_columns.sql
-- Adds stripe_customer_id + stripe_subscription_id to businesses.
-- These are populated by the new /webhook/stripe-webhook handler.
-- ---------------------------------------------------------------------------

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS stripe_customer_id     text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

CREATE INDEX IF NOT EXISTS idx_businesses_stripe_subscription
  ON businesses (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

COMMENT ON COLUMN businesses.stripe_customer_id IS
  'Stripe customer ID — populated by /webhook/stripe-webhook on checkout.session.completed.';
COMMENT ON COLUMN businesses.stripe_subscription_id IS
  'Stripe subscription ID — used as fallback to look up business on subscription events that lack metadata.business_id.';
