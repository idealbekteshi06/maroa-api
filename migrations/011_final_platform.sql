-- Migration 011: Final Complete Platform
-- WhatsApp + Email Approvals + Referrals + Competitor Ads + Webhooks

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gmb_access_token TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS gmb_location_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS revenue_forecast JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_model TEXT;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS image_score NUMERIC DEFAULT 0;
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS gmb_post_id TEXT;

CREATE TABLE IF NOT EXISTS content_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID,
  business_id UUID,
  token TEXT UNIQUE NOT NULL,
  action TEXT,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '48 hours',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_business_id UUID,
  referee_email TEXT,
  referee_business_id UUID,
  status TEXT DEFAULT 'pending',
  reward_given BOOLEAN DEFAULT false,
  referral_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS competitor_ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID,
  competitor_name TEXT,
  ad_id TEXT,
  ad_body TEXT,
  ad_headline TEXT,
  impressions_range TEXT,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID,
  event_type TEXT,
  webhook_url TEXT,
  secret TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE content_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_full_content_approvals" ON content_approvals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_full_referrals" ON referrals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_full_competitor_ads" ON competitor_ads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_full_webhook_subs" ON webhook_subscriptions FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_content_approvals_token ON content_approvals(token);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_competitor_ads_biz ON competitor_ads(business_id);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_biz ON webhook_subscriptions(business_id, event_type);
