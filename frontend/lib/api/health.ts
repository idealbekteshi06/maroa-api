import { api } from './client';

/**
 * lib/api/health.ts
 * ---------------------------------------------------------------------------
 * Cron-health endpoint — surfaces "when did Maroa last run X for this
 * business" so the dashboard can show reassurance / staleness signals.
 *
 *   GET /api/cron-health/:businessId
 * ---------------------------------------------------------------------------
 */

export interface CronStatus {
  last_run_at: string | null;
  healthy: boolean;
  age_hours: number | null;
}

export interface CronHealth {
  generated_at?: string;
  content_generation?: CronStatus;
  competitor_monitor?: CronStatus;
  analytics_snapshot?: CronStatus;
  lead_scoring?: CronStatus;
  retention?: CronStatus;
  wins?: CronStatus;
}

export async function fetchCronHealth(businessId: string): Promise<CronHealth | null> {
  try {
    return await api.get<CronHealth>(
      `/api/cron-health/${encodeURIComponent(businessId)}`,
    );
  } catch {
    return null;
  }
}
