-- Strategy one-liner for dashboard; idempotency task name on orchestration logs
ALTER TABLE generated_content ADD COLUMN IF NOT EXISTS strategy_reason TEXT;
ALTER TABLE orchestration_logs ADD COLUMN IF NOT EXISTS task TEXT;
