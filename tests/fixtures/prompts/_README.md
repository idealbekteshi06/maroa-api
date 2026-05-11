# Prompt regression fixtures

One JSON file per skill in `services/prompts/<skill>/`. Each fixture
captures a representative input + a set of assertions that the prompt
module's structured output must satisfy.

The eval harness (`scripts/eval-prompts.js`) runs every fixture in either:

- **dry mode** (default) — uses `stubbed_output` as if Claude returned
  that text. Validates the prompt module's pre/post processing.
- **live mode** (`--live`) — calls real Claude. Costs ~$0.02/sample.
  Run weekly via cron to catch model-drift regressions.

## Fixture shape

```json
{
  "version": "v1",
  "skill": "ad-optimizer",
  "samples": [
    {
      "name": "scale_winner",
      "input": {
        "business": { "industry": "cafe", "plan": "growth" },
        "metrics": { "roas": 3.4, "ctr": 2.8, "spend": 18 },
        "history": [
          /* 14 days */
        ]
      },
      "stubbed_output": "{\"decision\":\"scale\",\"decision_reason\":\"Strong ROAS sustained 14 days past learning phase\",\"audit_score\":86,\"new_daily_budget\":25}",
      "golden": {
        "decision": "scale",
        "audit_score": { "min": 75, "max": 100 },
        "must_mention": ["ROAS", "learning"],
        "must_not_contain": ["fast-paced", "leverage"],
        "must_not_contain_slop": true
      }
    }
  ]
}
```

## Golden assertions supported

- `decision` — exact string match
- `audit_score` — `{ min, max }` numeric bounds
- `must_mention` — array of strings; case-insensitive substring match
- `must_not_contain` — array of strings; case-insensitive
- `must_not_contain_slop` — boolean; runs voice-polish detector,
  fails if slop_score > 40

## Adding a new fixture

1. Pick a real customer scenario the prompt has handled well.
2. Capture the exact input shape (anonymized — no real customer data).
3. Run the prompt once with real Claude to capture `stubbed_output`.
4. Write golden assertions covering the dimensions you care about.
5. Run `node scripts/eval-prompts.js` and verify all samples pass.
6. Commit the fixture. CI will run dry mode on every PR.

## Live-mode budget

Live mode is rate-limited to keep weekly cost under $5 across all
skills. If you have more than ~250 samples globally, paginate them
across weekly runs or sample stochastically.
