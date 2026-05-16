/**
 * Type definitions for the War Room feed (per lib/warRoomFeed.js).
 *
 * Mirror of the backend shape so the UI never goes out of sync.
 * Source of truth: services/agency-pipeline + lib/decisionLog + lib/marketingGraph.
 */

export type DecayBucket = 'fresh' | 'maturing' | 'decaying' | 'dead';

export type AutoSafeBand = 'green' | 'yellow' | 'red';

export type DecisionLogRow = {
  id: string;
  business_id: string;
  agent_name: string;
  decision_type: string;
  decision_subtype?: string | null;
  recommendation_text: string;
  confidence: number;
  expected_upside_text?: string | null;
  expected_upside_value?: number | null;
  risk_text?: string | null;
  cost_usd: number;
  manipulation_risk?: number | null;
  auto_safe_band: AutoSafeBand;
  required_approval: boolean;
  executed: boolean;
  refused: boolean;
  refusal_reason?: string | null;
  outcome?: Record<string, unknown> | null;
  outcome_score?: number | null;
  created_at: string;
};

export type CreativeAsset = {
  id: string;
  business_id: string;
  asset_type: 'image' | 'video' | 'copy' | 'headline' | 'carousel' | 'reel' | 'story' | 'email_html' | 'landing_block';
  asset_url?: string | null;
  thumbnail_url?: string | null;
  hook_type?: string | null;
  angle?: string | null;
  emotion?: string | null;
  visual_style?: string | null;
  cta_text?: string | null;
  channel: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spend_usd: number;
  revenue_usd: number;
  performance_score?: number | null;
  created_at: string;
};

export type Experiment = {
  id: string;
  name: string;
  hypothesis?: string | null;
  variant_count: number;
  status: 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  winner_creative_id?: string | null;
  confidence_score?: number | null;
  lift_pct?: number | null;
  conclusion?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
};

export type ClientApproval = {
  id: string;
  workspace_id: string;
  business_id: string;
  decision_log_id?: string | null;
  approval_token: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  client_email?: string | null;
  preview_url?: string | null;
  preview_data?: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
};

export type ClientFeed = {
  client: {
    id: string;
    business_id: string;
    client_name?: string | null;
    status: string;
    monthly_retainer_usd?: number | null;
  };
  business_id: string;
  creatives_total: number;
  decay_buckets: Record<DecayBucket, number>;
  decaying_creatives: CreativeAsset[];
  top_creatives: CreativeAsset[];
  recent_decisions: DecisionLogRow[];
  top_claims: Array<{
    id: string;
    claim_text: string;
    claim_type?: string | null;
    outcome_signal: number;
  }>;
  experiments_running: Experiment[];
  experiments_recent_winners: Experiment[];
  competitor_alerts: DecisionLogRow[];
  error?: string;
};

export type KpiHistoryKey =
  | 'active_clients'
  | 'creatives_total'
  | 'experiments_running'
  | 'pending_approvals'
  | 'refusals_7d';

export type KpiHistory = Record<KpiHistoryKey, number[]> & {
  delta_pct: Record<KpiHistoryKey, number>;
  trend: Record<KpiHistoryKey, 'up' | 'down' | 'flat'>;
};

export type WorkspaceFeed = {
  workspace: {
    id: string;
    name: string;
    plan_tier: 'solo' | 'freelancer' | 'agency' | 'enterprise';
    white_label?: Record<string, unknown>;
  };
  clients: ClientFeed[];
  pending_approvals: ClientApproval[];
  summary: {
    clients_total: number;
    creatives_total: number;
    experiments_running: number;
    decaying_or_dead: number;
    pending_approvals: number;
  };
  /** 7-day history per KPI + week-over-week delta + trend direction. Added
      by routes/war-room.js — see lib/warRoomKpiHistory.js. Optional because
      legacy or degraded responses may omit it. */
  kpi_history?: KpiHistory;
  generated_at: string;
};
