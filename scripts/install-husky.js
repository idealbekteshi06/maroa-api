#!/usr/bin/env node
/**
 * scripts/install-husky.js
 * ----------------------------------------------------------------------------
 * One-time idempotent installer for the husky pre-commit hook.
 *
 * Run automatically by `npm install` (via the "prepare" script in
 * package.json). Manual run is fine too. Skips silently when we're not
 * in a git repo (e.g. running inside a Docker build).
 *
 * Audit 2026-05-18 L7 hardening — adds local lint/format feedback so dev
 * commits don't burn CI minutes on style nits.
 * ----------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const HUSKY_DIR = path.join(REPO_ROOT, '.husky');
const HOOK_PATH = path.join(HUSKY_DIR, 'pre-commit');

const HOOK_CONTENT = `#!/usr/bin/env sh
# Maroa.ai pre-commit — installed by scripts/install-husky.js.
# Runs eslint + prettier on staged files via lint-staged, then verifies
# OpenAPI is regenerated when route files changed. Bypass with --no-verify
# only if you really know what you're doing.

set -e

# 1. Lint + format on staged files
if [ -x "./node_modules/.bin/lint-staged" ]; then
  ./node_modules/.bin/lint-staged
else
  npx --no-install lint-staged 2>/dev/null || npx --yes lint-staged
fi

# 2. OpenAPI drift check — only when server.js or routes/ changed (L9)
if git diff --cached --name-only | grep -qE '^(server\\.js|routes/)'; then
  if [ -f docs/openapi.yml ]; then
    npm run generate-openapi >/dev/null 2>&1 || true
    if ! git diff --quiet docs/openapi.yml; then
      echo ""
      echo "WARN: docs/openapi.yml is stale after route changes."
      echo "      Run: npm run generate-openapi && git add docs/openapi.yml"
      echo ""
      # Don't block the commit — soft warning. CI's existing check is the
      # hard gate. We only warn here so devs hear about it early.
    fi
  fi
fi
`;

function main() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    // Not a git repo — likely a Docker build context. Skip silently.
    return;
  }
  try {
    fs.mkdirSync(HUSKY_DIR, { recursive: true });
    fs.writeFileSync(HOOK_PATH, HOOK_CONTENT, { mode: 0o755 });
    // Make sure git uses this directory.
    const { execSync } = require('child_process');
    try {
      execSync('git config core.hooksPath .husky', {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      /* user may not have permission — that's fine */
    }
    // eslint-disable-next-line no-console
    console.log('[install-husky] pre-commit hook installed at .husky/pre-commit');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[install-husky] could not install hook:', e.message);
  }
}

if (require.main === module) main();
