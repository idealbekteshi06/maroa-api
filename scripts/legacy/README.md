# scripts/legacy/

Historical one-shot scripts kept for reference. NONE of these are imported
by live code (verified via grep on 2026-05-18) — they ran once during the
n8n → Express migration and have no business in the active codebase.

| File                              | Original purpose                                                            | Last useful date |
| --------------------------------- | --------------------------------------------------------------------------- | ---------------- |
| `apply_improvements.py`           | Batch-apply prompt improvements to n8n workflow JSON files.                 | Mar 2026         |
| `inject_intelligence.py`          | Inject the "AI Brain" decisioning layer into legacy workflows.              | Mar 2026         |
| `generate_max_workflows.py`       | Generated the maximal-workflow set (wf16-wf28) that we later carved.        | Apr 2026         |
| `generate_workflows_29_31.py`     | Generated three additional workflows that never shipped.                    | Apr 2026         |
| `rebuild_wf01.py`                 | Rebuilt the WF1 daily-content workflow before the carve to services/wf1.    | Apr 2026         |
| `upgrade_bulk.py`                 | Bulk-upgraded plan tier for early-adopter accounts.                         | Apr 2026         |

Audit reference: 2026-05-18 L1. Moved here from repo root to declutter the
top-level listing without losing history. Safe to delete entirely once the
team is comfortable; nothing tests, imports, or schedules them.
