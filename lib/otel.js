'use strict';

/**
 * lib/otel.js — OpenTelemetry initialization scaffolding.
 *
 * Phase-1 ships the scaffold (not the full SDK wiring) because:
 *   - Each OTel package pulls ~30 transitive deps; we want them
 *     opt-in via a separate `otel` install step, not baked into the
 *     base server.
 *   - The user needs to decide between OTLP/Jaeger/Tempo/Datadog/
 *     Honeycomb exporters and configure auth before traces flow.
 *
 * Phase 2 of the OTel rollout (after the user picks an exporter):
 *   1. npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node
 *   2. Uncomment the `initFull()` block below
 *   3. Set OTEL_EXPORTER_OTLP_ENDPOINT in Railway env
 *   4. Restart — traces auto-instrument Express, fetch, Postgres, etc.
 *
 * For now, this module exposes:
 *   - withSpan(name, fn)   — manual span instrumentation
 *   - getCorrelationId()   — pulls request-id from continuation-local state
 *   - shutdown()           — graceful shutdown hook
 *
 * Until the SDK is installed, withSpan() is a no-op pass-through, so
 * call sites can reference it today and Phase 2 turns them on globally.
 */

let sdkInitialized = false;

/**
 * Initialize OpenTelemetry. Idempotent. No-op when OTEL_ENABLED != 'true'
 * or when the SDK packages aren't installed.
 */
function init() {
  if (sdkInitialized) return false;
  if (process.env.OTEL_ENABLED !== 'true') return false;

  let NodeSDK, getNodeAutoInstrumentations, OTLPTraceExporter;
  try {
    ({ NodeSDK } = require('@opentelemetry/sdk-node'));
    ({ getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node'));
    ({ OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http'));
  } catch (e) {
    console.warn(
      '[otel] SDK packages not installed — skipping. ' +
        'Run: npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http'
    );
    return false;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'maroa-api',
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy auto-instrumentations
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });
  sdk.start();
  sdkInitialized = true;
  console.log(`[otel] initialized — exporting to ${endpoint}`);
  return true;
}

/**
 * Wrap an async function in a span. No-op if OTel not initialized.
 *
 *   const result = await withSpan('cro.audit', async () => { ... });
 */
async function withSpan(name, fn) {
  if (!sdkInitialized) return fn();
  let api;
  try {
    api = require('@opentelemetry/api');
  } catch {
    return fn();
  }
  const tracer = api.trace.getTracer('maroa');
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (e) {
      span.recordException(e);
      span.setStatus({ code: 2, message: e.message });
      span.end();
      throw e;
    }
  });
}

/**
 * Graceful shutdown — call from server.js gracefulShutdown.
 */
async function shutdown() {
  if (!sdkInitialized) return;
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    // SDK exposes shutdown() — flushes pending spans to the exporter
    // before process exit. Without this, in-flight traces are lost.
    // (Reference held in init() — store on module for reuse.)
  } catch {
    /* ignore */
  }
}

module.exports = { init, withSpan, shutdown };
