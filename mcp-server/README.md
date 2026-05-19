# Maroa MCP server

Exposes Maroa's data + actions to any [Model Context Protocol](https://modelcontextprotocol.io)
client (Claude Desktop, Claude Code, Cursor, custom). Lets a customer ask
*"What does Maroa need from me today?"* in their AI host of choice and
get a real, live answer — plus take action (approve, draft, reject)
without ever opening the Maroa dashboard.

## Tools

### Read-only (Supabase service-role key)

| Tool | Purpose |
| --- | --- |
| `get_business_profile` | Full business + profile row (brand DNA, tone, audience). |
| `get_content_history` | Recent content_concepts + content_assets. |
| `get_performance_metrics` | Last N days of daily_stats + content_performance. |
| `list_creative_concepts` | Creative-director concepts with scoring. |
| `list_recent_events` | Unified events table (debugging). |
| `list_characters` | Soul ID characters trained for this business. |

### Action (Maroa API, requires `MAROA_API_TOKEN`)

| Tool | Purpose |
| --- | --- |
| `list_workspaces` | Workspaces the authenticated user is a member of. |
| `get_war_room` | Full feed: clients, decisions, KPIs, pending approvals. |
| `list_pending_approvals` | Just the things waiting for a human yes/no. |
| `approve_decision` | Approve a pending decision (idempotent). |
| `reject_decision` | Reject with an optional reason. |
| `get_brand_voice` | Current brand-voice anchor for a business. |
| `draft_post` | Ask Maroa to draft a new piece (fire-and-forget). |
| `cron_health` | Status of every background job per business. |

## Setup

### Required env

| Var | Purpose |
| --- | --- |
| `SUPABASE_URL` | Maroa's Supabase project URL — read-only tools use this. |
| `SUPABASE_KEY` | Supabase service-role key. Same caveat. |
| `MAROA_API_URL` | Defaults to `https://maroa-api-production.up.railway.app`. |
| `MAROA_API_TOKEN` | Bearer JWT for the customer. Without it, action tools 401. |

### Claude Desktop / Claude Code config

Add to `~/.claude/mcp.json` (or your platform's equivalent):

```json
{
  "mcpServers": {
    "maroa": {
      "command": "node",
      "args": ["/absolute/path/to/Maroa.ai/mcp-server/server.js"],
      "env": {
        "SUPABASE_URL": "https://<project>.supabase.co",
        "SUPABASE_KEY": "<service-role-key>",
        "MAROA_API_URL": "https://maroa-api-production.up.railway.app",
        "MAROA_API_TOKEN": "<your-bearer-jwt>"
      }
    }
  }
}
```

Restart the host. Then in any chat you can say:

> "Maroa, what's waiting for my approval?"

Claude routes to `list_pending_approvals`, returns the list, and you can
follow up with *"approve all of them"* or *"approve the Instagram one
and reject the Meta ad."*

### Issuing a Maroa API token

The token is the same Supabase JWT the dashboard uses. From the dashboard:

1. Open DevTools → Application → Cookies on `app.maroa.ai`
2. Copy the `sb-access-token` value (starts with `eyJ...`)
3. Use that as `MAROA_API_TOKEN`

Token expires; refresh by logging in again. A dedicated long-lived MCP
token endpoint is on the roadmap (see Maroa backend `routes/auth.js`).

## Security model

- READ tools use the Supabase service-role key and only query rows
  scoped to the businessId you pass. Don't share your service-role key.
- ACTION tools use a Bearer JWT — Maroa's regular `requireAnyUserId`
  middleware enforces ownership. A leaked JWT lets the holder act as
  you on your workspaces until the token expires (~1h by default).
- Every action tool sets an `Idempotency-Key` header so accidental
  double-invocations (e.g., the host retries) don't double-fire.

## Local dev

```bash
node mcp-server/server.js
# in another shell, talk to it directly:
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | node mcp-server/server.js
```

## Roadmap

- HTTP/SSE transport so the MCP server can run as a hosted service.
- OAuth-style token exchange so we stop asking customers to paste JWTs.
- `subscribe_to_approvals` — server-sent stream of new approval events.
- Workspace-level OAuth scopes (read-only vs read-write).

Audit reference: this is the 2026-05-19 Anthropic-integration ship.
