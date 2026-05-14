'use strict';

/**
 * tests/ai-gateway-guard.test.js
 *
 * Per the 2026-05-13 audit + strategy doc Phase 1:
 *   "Add a CI test that fails if production code calls
 *    api.anthropic.com/v1/messages outside approved files."
 *
 * The point: every Anthropic call must route through callClaude() so
 * cost-tracking, retries, prompt-cache, and per-business budget gates
 * all apply uniformly. Drift kills the cost discipline.
 *
 * Approved direct-call sites (must be explicitly allowlisted):
 *   - server.js itself (defines callClaude — the one legitimate caller)
 *   - server.js /debug route (5-token health probe, intentionally bypasses)
 *   - services/higgsfield.js fallback paths (only fire when callClaude
 *     is not wired — i.e. standalone tooling)
 *
 * Anything else hitting api.anthropic.com fails this test. The author
 * must either route through callClaude or add their file to the
 * allowlist with a comment explaining why.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// Files allowed to call api.anthropic.com directly. Every entry needs a
// comment explaining why the bypass is legitimate.
const APPROVED_FILES = new Set([
  // server.js defines callClaude itself + has the /debug health probe
  // that intentionally bypasses (5-token ping with explicit eslint-disable).
  'server.js',

  // services/higgsfield.js has BOTH paths: when callClaude is wired
  // (production path) it routes through it; when it's not (standalone
  // tests / scripts) it falls back to direct apiRequest. The fallback
  // is intentional + documented.
  'services/higgsfield.js',
]);

const SCAN_DIRS = ['lib', 'middleware', 'routes', 'services'];
const SCAN_TOP_FILES = ['server.js'];
const ANTHROPIC_PATTERN = /api\.anthropic\.com\/v1\/messages/;
const SKIP_EXTENSIONS = new Set(['.md', '.test.js', '.test.ts', '.test.mjs', '.sql']);

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (ext === '.js' || ext === '.mjs' || ext === '.ts') {
        out.push(full);
      }
    }
  }
  return out;
}

function getRelative(absPath) {
  return path.relative(PROJECT_ROOT, absPath);
}

function isTestFile(rel) {
  return /(^|\/)tests\//.test(rel) || /\.test\.(js|ts|mjs)$/.test(rel);
}

test('ai-gateway-guard: no direct api.anthropic.com calls outside approved files', () => {
  const candidates = [];
  for (const top of SCAN_TOP_FILES) {
    const p = path.join(PROJECT_ROOT, top);
    if (fs.existsSync(p)) candidates.push(p);
  }
  for (const d of SCAN_DIRS) {
    candidates.push(...walk(path.join(PROJECT_ROOT, d)));
  }

  const violations = [];
  for (const file of candidates) {
    const rel = getRelative(file);
    if (isTestFile(rel)) continue;
    if (APPROVED_FILES.has(rel)) continue;

    const ext = path.extname(file);
    if (SKIP_EXTENSIONS.has(ext)) continue;

    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    if (ANTHROPIC_PATTERN.test(src)) {
      // Allow eslint-disable-next-line no-restricted-syntax for the exact
      // anthropic pattern — same escape hatch the lint rule uses.
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (ANTHROPIC_PATTERN.test(line)) {
          const prev = (lines[i - 1] || '') + (lines[i - 2] || '');
          const explicitlyAllowed =
            /eslint-disable-next-line[^\n]*no-restricted-syntax/.test(prev) ||
            /eslint-disable[^\n]*no-restricted-syntax/.test(prev);
          if (!explicitlyAllowed) {
            violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }
  }

  assert.strictEqual(
    violations.length,
    0,
    `\nFound ${violations.length} direct calls to api.anthropic.com outside the AI gateway:\n  ` +
      violations.slice(0, 20).join('\n  ') +
      `\n\nFix: route through callClaude() (server.js) so cost-tracking + retries + prompt-cache apply.\n` +
      `If you have a legitimate reason to bypass (e.g. a 5-token health probe), add the file to\n` +
      `APPROVED_FILES in tests/ai-gateway-guard.test.js with a comment explaining why.`
  );
});

test('ai-gateway-guard: APPROVED_FILES list stays small', () => {
  // If this list grows past ~5, the gateway abstraction is leaking. Each
  // new addition is a code-review event.
  assert.ok(
    APPROVED_FILES.size <= 5,
    `APPROVED_FILES has ${APPROVED_FILES.size} entries — every new bypass weakens the AI gateway moat`
  );
});

test('ai-gateway-guard: APPROVED_FILES contents still exist', () => {
  for (const rel of APPROVED_FILES) {
    const abs = path.join(PROJECT_ROOT, rel);
    assert.ok(fs.existsSync(abs), `APPROVED_FILES references ${rel} but it does not exist`);
  }
});
