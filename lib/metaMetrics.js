'use strict';

/**
 * lib/metaMetrics.js
 * Meta Graph API metric normalization — Viewers replacing Reach (June 2026).
 * https://developers.facebook.com/docs/graph-api/changelog
 */

const META_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';
const VIEWERS_CUTOVER_ISO = process.env.META_VIEWERS_CUTOVER || '2026-06-01';

/** Insight metrics to request (viewers first, reach fallback until cutover). */
const PAGE_POST_INSIGHT_METRICS = 'post_impressions,post_engaged_users,post_media_view';

const CAMPAIGN_INSIGHT_FIELDS = ['impressions', 'clicks', 'spend', 'actions', 'reach', 'unique_outbound_clicks'].join(
  ','
);

/** Threads feed placement — Marketing API expanded 2026. */
const THREADS_PLACEMENTS = ['threads_feed'];

const THREADS_OBJECTIVES = new Set(['REACH', 'LINK_CLICKS', 'OUTCOME_TRAFFIC', 'CONVERSIONS']);

function useViewersPrimary(date = new Date()) {
  return date.toISOString().slice(0, 10) >= VIEWERS_CUTOVER_ISO.slice(0, 10);
}

/**
 * Normalize a snapshot row: prefer viewers when present, keep reach for backward compat.
 */
function normalizeSnapshotMetrics(row = {}) {
  const viewers = Number(row.viewers) || Number(row.post_media_view) || Number(row.page_media_view) || null;
  const reach = Number(row.reach) || 0;
  const primary = viewers != null && viewers > 0 ? viewers : reach;
  return {
    viewers: viewers ?? (useViewersPrimary() ? primary : null),
    reach: viewers != null && viewers > 0 ? viewers : useViewersPrimary() ? primary : reach,
    audience_metric: viewers != null && viewers > 0 ? 'viewers' : 'reach',
    impressions: Number(row.impressions) || 0,
    engagement: Number(row.engagement) || 0,
    clicks: Number(row.clicks) || 0,
  };
}

function sumAudienceMetric(rows, key = 'reach') {
  return (rows || []).reduce((s, r) => {
    const n = normalizeSnapshotMetrics(r);
    return s + (n.audience_metric === 'viewers' ? n.viewers || n.reach : n[key] || 0);
  }, 0);
}

function graphBaseUrl() {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}`;
}

function pagePostsFields() {
  const metrics = useViewersPrimary()
    ? 'post_impressions,post_engaged_users,post_media_view'
    : 'post_impressions,post_engaged_users';
  return `id,message,created_time,insights.metric(${metrics})`;
}

module.exports = {
  META_GRAPH_VERSION,
  VIEWERS_CUTOVER_ISO,
  PAGE_POST_INSIGHT_METRICS,
  CAMPAIGN_INSIGHT_FIELDS,
  THREADS_PLACEMENTS,
  THREADS_OBJECTIVES,
  useViewersPrimary,
  normalizeSnapshotMetrics,
  sumAudienceMetric,
  graphBaseUrl,
  pagePostsFields,
};
