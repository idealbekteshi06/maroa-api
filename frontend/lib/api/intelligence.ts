import { api } from './client';

/**
 * lib/api/intelligence.ts
 * ---------------------------------------------------------------------------
 * Shared intelligence feed — every module (ads, content, competitor, voc)
 * writes insights into a shared store keyed by user.
 *
 *   GET /api/intelligence/:userId
 * ---------------------------------------------------------------------------
 */

export interface IntelligenceItem {
  key: string;
  value: string;
  type?: string | null;
  updated?: string | null;
}

export interface IntelligenceFeed {
  intelligence: Record<string, IntelligenceItem[]>;
  total: number;
}

export async function fetchIntelligence(userId: string): Promise<IntelligenceFeed | null> {
  try {
    return await api.get<IntelligenceFeed>(
      `/api/intelligence/${encodeURIComponent(userId)}`,
    );
  } catch {
    return null;
  }
}
