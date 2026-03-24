# Pi Daemon

A lightweight, multi-channel AI assistant daemon powered by [Pi's](https://github.com/mariozechner/pi-coding-agent) agent SDK.

## What it does
- Runs as an always-on daemon bridging messaging platforms to Pi
- Each channel gets its own Pi session with shared memory, skills, and tools
- Channels are externally loadable — drop a folder in `channels/` and go
- Hot reload — change a channel config without restarting the daemon
- Only authorized users can interact (per-channel allowlists)

## Architecture

```
              ┌─────────────┐
              │    Core      │
              │   (router)   │
              └──────┬───────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
  ┌─────┴──┐  ┌─────┴──┐  ┌─────┴──┐
  │Telegram│  │Discord │  │  ...   │
  │Channel │  │Channel │  │        │
  └────────┘  └────────┘  └────────┘
```

## Files

```
config.toml                  # daemon settings (workDir, agentDir)
.env                         # secrets (tokens, API keys)
src/
  index.ts                   # startup and shutdown
  core.ts                    # channel loader, message router, hot reload
  pi-adapter.ts              # Pi SDK boundary (multi-session)
  channel.ts                 # Channel interface and types
channels/
  telegram/
    channel-config.toml      # channel-specific config
    index.ts                 # Channel implementation
```

## Requirements
- Node.js 22+
- Pi already authenticated (`~/.pi/agent/auth.json`)

## Setup

```bash
npm install
cp .env.example .env
# Fill in .env with your secrets
npm run build
```

## Configuration

**`config.toml`** — daemon-level settings:
```toml
[daemon]
workDir = "~/.pi/workspace"
agentDir = "~/.pi/agent"
```

**`.env`** — secrets only:
```
TELEGRAM_BOT_TOKEN=your-token-here
BRAVE_API_KEY=your-key-here
```

**`channels/<name>/channel-config.toml`** — per-channel config:
```toml
id = "telegram"
enabled = true
token = "$TELEGRAM_BOT_TOKEN"      # $ENV_VAR references resolved from .env
allowedUsers = [123456789]
```

TOML values starting with `$` are resolved from environment variables / `.env`.

## Adding a channel

1. Create `channels/<name>/`
2. Add `channel-config.toml` with at least `id` and `enabled`
3. Add `index.ts` that default-exports a `ChannelFactory`
4. Build and restart (or let hot reload pick it up)

See `src/channel.ts` for the interface, and `channels/telegram/` for a reference implementation.

## Run

```bash
npm start
```

Or as a systemd user service — see `DESIGN.md` for details.

## Paths
- Sessions: `~/.pi/agent/sessions/<channel-id>/`
- Working dir: `~/.pi/workspace/` (default)
- Service: `~/.config/systemd/user/pi-gateway.service`
