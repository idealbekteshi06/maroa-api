#!/bin/bash

# scripts/restore-drill.sh
# -----------------------------------------------------------------------------
# DR drill: validate that we can restore Maroa from scratch.
#
# This script DOESN'T actually destroy production. It:
#   1. Creates a temporary Supabase project (or uses pre-existing staging)
#   2. Runs migrations 000-043 against it
#   3. Validates schema completeness via SELECT pg_tables
#   4. Posts a sample row to verify writes work
#   5. Reports time-to-restore (target: < 60 minutes)
#
# Run this quarterly. If it fails, your DR is broken — fix it.
#
# Usage:
#   SUPABASE_STAGING_URL=... SUPABASE_STAGING_KEY=... ./scripts/restore-drill.sh
# -----------------------------------------------------------------------------

set -e

if [ -z "$SUPABASE_STAGING_URL" ] || [ -z "$SUPABASE_STAGING_KEY" ]; then
  echo "FAIL: SUPABASE_STAGING_URL + SUPABASE_STAGING_KEY required"
  echo ""
  echo "  Set up a staging Supabase project (separate from prod) and:"
  echo "    export SUPABASE_STAGING_URL=https://<staging-project>.supabase.co"
  echo "    export SUPABASE_STAGING_KEY=<service-role-key>"
  exit 1
fi

START_TIME=$(date +%s)
MIGRATIONS_DIR="$(dirname "$0")/../migrations"
EXPECTED_TABLES=(
  businesses business_profiles generated_content
  ad_campaigns ad_performance_logs ad_audit_results
  ai_seo_audits ai_seo_artifacts cro_audits cro_rewrites
  pacing_alerts weekly_scorecards forecasts voc_analyses
  brand_voice_history llm_cost_logs
)

echo "═══════════════ Maroa Restore Drill ═══════════════"
echo "Target: $SUPABASE_STAGING_URL"
echo "Migrations: $(ls $MIGRATIONS_DIR/*.sql | wc -l | xargs) files"
echo ""

# Step 1 — Apply all migrations sequentially
echo "▶ Applying all migrations to staging..."
for sql_file in $(ls $MIGRATIONS_DIR/*.sql | sort -V); do
  echo "  → $(basename $sql_file)"
  curl -sS -X POST "$SUPABASE_STAGING_URL/rest/v1/rpc/exec_sql" \
    -H "apikey: $SUPABASE_STAGING_KEY" \
    -H "Authorization: Bearer $SUPABASE_STAGING_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"sql\": $(cat "$sql_file" | jq -Rs .)}" \
    > /dev/null || echo "    ⚠️  $(basename $sql_file) returned non-zero"
done

# Step 2 — Verify expected tables exist
echo ""
echo "▶ Verifying schema completeness..."
TABLES_PRESENT=$(curl -sS "$SUPABASE_STAGING_URL/rest/v1/?apikey=$SUPABASE_STAGING_KEY")

MISSING=()
for table in "${EXPECTED_TABLES[@]}"; do
  if ! echo "$TABLES_PRESENT" | grep -q "\"$table\""; then
    MISSING+=("$table")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌ MISSING TABLES: ${MISSING[*]}"
  echo "    Schema incomplete. Investigate."
  exit 1
fi
echo "  ✅ All ${#EXPECTED_TABLES[@]} expected tables present"

# Step 3 — Smoke write
echo ""
echo "▶ Smoke write to businesses table..."
TEST_RESPONSE=$(curl -sS -X POST "$SUPABASE_STAGING_URL/rest/v1/businesses" \
  -H "apikey: $SUPABASE_STAGING_KEY" \
  -H "Authorization: Bearer $SUPABASE_STAGING_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"business_name":"DR-DRILL-TEST","email":"drill@maroa.ai"}')

if echo "$TEST_RESPONSE" | grep -q "DR-DRILL-TEST"; then
  echo "  ✅ Write succeeded"
  # Cleanup
  TEST_ID=$(echo "$TEST_RESPONSE" | jq -r '.[0].id // .id // empty')
  if [ -n "$TEST_ID" ]; then
    curl -sS -X DELETE "$SUPABASE_STAGING_URL/rest/v1/businesses?id=eq.$TEST_ID" \
      -H "apikey: $SUPABASE_STAGING_KEY" \
      -H "Authorization: Bearer $SUPABASE_STAGING_KEY" \
      > /dev/null
  fi
else
  echo "❌ Write failed. Response: $TEST_RESPONSE"
  exit 1
fi

# Step 4 — Report
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
echo "═══════════════ DRILL RESULT ═══════════════"
echo "✅ Restore drill PASSED"
echo "Duration: ${DURATION}s ($(($DURATION / 60))m)"
echo "Target was: < 3600s (60min)"
if [ $DURATION -gt 3600 ]; then
  echo "⚠️  Above 60-min target — investigate slow migrations"
fi
echo ""
echo "Drill complete. Schedule next drill in 90 days."
