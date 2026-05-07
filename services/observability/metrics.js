'use strict';

/**
 * services/observability/metrics.js
 * ----------------------------------------------------------------------------
 * In-process metrics registry. Counters, gauges, histograms.
 * Exposed via /metrics endpoint in Prometheus-compatible text format.
 *
 * Instruments collected automatically:
 *   - http_requests_total{method,path,status}
 *   - http_request_duration_ms{path}
 *   - llm_calls_total{model,skill}
 *   - llm_cost_usd_total{model,skill}
 *   - llm_tokens_total{model,direction}  // direction = input|output
 *   - skill_run_total{skill,outcome}     // outcome = ship|retry|reject|error
 *   - business_count{plan}
 *
 * Application code calls into this via:
 *   metrics.increment('skill_run_total', { skill: 'ad-optimizer', outcome: 'ship' });
 *   metrics.observeHistogram('http_request_duration_ms', durationMs, { path });
 *   metrics.setGauge('business_count', 100, { plan: 'growth' });
 * ----------------------------------------------------------------------------
 */

// In-memory registries
const counters   = new Map();   // key → number
const gauges     = new Map();   // key → number
const histograms = new Map();   // key → { count, sum, buckets:Map<number,number> }

const DEFAULT_BUCKETS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

function _key(name, labels = {}) {
  // Stable key: name{a="b",c="d"}
  const sortedLabels = Object.entries(labels)
    .filter(([_, v]) => v != null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  if (!sortedLabels.length) return name;
  const labelStr = sortedLabels.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
  return `${name}{${labelStr}}`;
}

function increment(name, labels = {}, by = 1) {
  const k = _key(name, labels);
  counters.set(k, (counters.get(k) || 0) + by);
}

function setGauge(name, value, labels = {}) {
  const k = _key(name, labels);
  gauges.set(k, Number(value) || 0);
}

function observeHistogram(name, value, labels = {}) {
  const k = _key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    h = { count: 0, sum: 0, buckets: new Map(DEFAULT_BUCKETS_MS.map(b => [b, 0])) };
    histograms.set(k, h);
  }
  h.count++;
  h.sum += Number(value) || 0;
  for (const [bucketUpperBound, _count] of h.buckets) {
    if (value <= bucketUpperBound) {
      h.buckets.set(bucketUpperBound, h.buckets.get(bucketUpperBound) + 1);
    }
  }
}

/**
 * Format all metrics as Prometheus text exposition format.
 * Suitable for /metrics endpoint scraped by Prometheus / Datadog / Grafana Cloud.
 */
function exportPrometheus() {
  const lines = [];

  // Counters
  for (const [k, v] of counters) {
    const name = k.split('{')[0];
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${k} ${v}`);
  }

  // Gauges
  for (const [k, v] of gauges) {
    const name = k.split('{')[0];
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${k} ${v}`);
  }

  // Histograms
  for (const [k, h] of histograms) {
    const name = k.split('{')[0];
    const labels = k.includes('{') ? k.slice(k.indexOf('{') + 1, k.lastIndexOf('}')) : '';
    const labelPrefix = labels ? `,${labels}` : '';
    const baseLabels = labels ? `{${labels}}` : '';

    lines.push(`# TYPE ${name} histogram`);
    for (const [bucket, count] of h.buckets) {
      lines.push(`${name}_bucket{le="${bucket}"${labelPrefix}} ${count}`);
    }
    lines.push(`${name}_bucket{le="+Inf"${labelPrefix}} ${h.count}`);
    lines.push(`${name}_count${baseLabels} ${h.count}`);
    lines.push(`${name}_sum${baseLabels} ${h.sum}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Return JSON snapshot of all metrics. Useful for dashboard endpoints + tests.
 */
function snapshot() {
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    histograms: Object.fromEntries(
      [...histograms].map(([k, h]) => [k, {
        count: h.count,
        sum: h.sum,
        avg: h.count > 0 ? h.sum / h.count : 0,
        buckets: Object.fromEntries(h.buckets),
      }])
    ),
  };
}

/**
 * Reset all metrics. ONLY for tests.
 */
function reset() {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

/**
 * Express middleware — auto-track HTTP metrics on every request.
 */
function expressMiddleware() {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const path = req.route?.path || req.path?.split('?')[0] || 'unknown';
      const labels = {
        method: req.method,
        path: path.length < 100 ? path : path.slice(0, 100), // cap to avoid label cardinality explosion
        status: String(res.statusCode),
      };
      increment('http_requests_total', labels);
      observeHistogram('http_request_duration_ms', duration, { path: labels.path });
    });
    next();
  };
}

module.exports = {
  increment,
  setGauge,
  observeHistogram,
  exportPrometheus,
  snapshot,
  reset,
  expressMiddleware,
};
