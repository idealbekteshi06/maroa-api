# @maroa/cli — Maroa from the terminal

Run your AI marketing operations from iTerm/Warp without opening the browser.

## Install

```bash
npx maroa setup
```

This walks you through:
1. The API URL (defaults to production)
2. Your Maroa API token (paste from `https://maroa.ai/settings → API tokens`)

The config is saved to `~/.maroa/config.json` with `chmod 600`.

## Commands

| Command | What it does |
|---|---|
| `maroa setup` | First-time configuration |
| `maroa status` | One-line workspace summary |
| `maroa pending` | List things waiting on your approval |
| `maroa approve <id>` | Approve a specific decision |
| `maroa reject <id> [reason]` | Reject a decision, optional reason |
| `maroa draft "theme"` | Ask Maroa to draft new content with a theme |
| `maroa whoami` | Show your configured account + accessible workspaces |
| `maroa logout` | Clear stored credentials |

## Examples

```bash
# Check what's waiting
maroa pending
# 3 pending
#
# d-abc123  [Tirana Roastery · creative-engine]
#   Approve this Instagram post for Friday: "Friday lunch special..."
#   (92% sure)
#
# → Approve with `maroa approve <id>` or reject with `maroa reject <id> <reason>`

# Approve one
maroa approve d-abc123
# ✓ Approved. Maroa is shipping it now.

# Draft something new
maroa draft "weekend brunch menu"
# ✓ Drafting now. Run `maroa pending` in a minute or two.
```

## Auth

The CLI uses a Bearer JWT — the same Supabase token the dashboard uses.
Two ways to get one:

- **Dashboard:** Settings → API tokens → Create
- **Browser DevTools:** Application → Cookies on `app.maroa.ai` → copy `sb-access-token`

Tokens expire (~1h by default). Re-run `maroa setup` when that happens.

## Privacy

The CLI talks only to the API URL you configure. No telemetry, no third-party
calls. The Idempotency-Key on every mutating call means double-pressing
Enter on `maroa approve` is safe.

## License

MIT
