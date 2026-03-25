# Pi Daemon — Design

## Purpose
Multi-channel AI assistant daemon backed by Pi's SDK. Bridges messaging platforms
to a persistent Pi agent so the assistant is always-on outside the terminal.

## Architecture
```text
Messaging platforms ↔ Channel adapters ↔ Core router ↔ Pi SDK (AgentSession per channel)
                                                    ↕
                                             model provider via Pi auth
                                             tools, skills, memory, settings
```

Each channel is a self-contained module in `channels/`. The core scans for channels
at startup and dynamically imports them. Channels communicate with the core through
a simple callback interface — no shared state, no coupling between channels.

## Key paths
- Project: `~/.pi/pi-daemon/`
- Daemon config: `config.toml`
- Secrets: `.env`
- Channel configs: `channels/<name>/channel-config.toml`
- Session storage: `~/.pi/agent/sessions/<channel-id>/`
- Working dir: `~/.pi/workspace/`
- systemd unit: `~/.config/systemd/user/pi-gateway.service`

## Main files
- `src/index.ts` — process lifecycle
- `src/core.ts` — channel loader, message router, hot reload watcher
- `src/pi-adapter.ts` — Pi SDK boundary (multi-session)
- `src/channel.ts` — Channel interface and types
- `src/config.ts` — TOML + .env config loading

## Decisions
- **Sessions:** one Pi session per channel, shared auth and model registry
- **Config:** TOML for structure, `.env` for secrets, `$ENV_VAR` references
- **Channels:** externally loadable from `channels/` directory
- **Hot reload:** fs.watch on `channels/`, debounced, reload individual channels
- **Security:** per-channel user allowlists; secrets never in TOML
- **Error handling:** bad channel = skip + warn + log, never crash the daemon
- **Deployment:** systemd user service running `dist/src/index.js`
- **Working dir:** `~/.pi/workspace/` by default

## Secrets
- Pi auth: `~/.pi/agent/auth.json`
- Channel tokens: `~/.pi/pi-daemon/.env`
- Brave key: `~/.pi/pi-daemon/.env`
- GitHub auth: OS keyring via `gh`

## Channel interface
Channels must default-export a `ChannelFactory` function that returns a `Channel`:
```typescript
interface Channel {
  readonly id: string;
  start(onMessage: OnMessage): Promise<void>;
  stop(): Promise<void>;
}

type ChannelFactory = (config: ChannelConfig) => Channel;
```

The `onMessage` callback routes incoming messages to the channel's Pi session
and returns a response. Channels handle their own platform-specific formatting.

## Platform API comparison (2026-03-24)

Researched Telegram Bot API (v9.5) and Discord Bot API to inform interface evolution.

### Message capabilities

| Capability | Telegram Bot API | Discord Bot API | Our status |
|---|---|---|---|
| Send text | `sendMessage` (4096 chars) | `channel.send` (2000 chars) | ✅ Both |
| Receive text | ✅ | ✅ | ✅ Both |
| Markdown/formatting | Markdown/HTML parse modes | Native markdown rendering | ✅ Both |
| Send files | `sendDocument` (50MB, 2GB local) | `AttachmentBuilder` (25MB, 100MB boosted) | ❌ |
| Receive files | `file_id` → `getFile` → download URL | `msg.attachments` → URL | ❌ |
| Send images | `sendPhoto` | embed or attachment | ❌ |
| Receive images | `photo` array on message | `msg.attachments` | ❌ |
| Edit messages | `editMessageText` | `msg.edit()` | ❌ |
| Delete messages | `deleteMessage` | `msg.delete()` | ❌ |
| Reply to specific msg | `reply_to_message_id` | `msg.reply()` | ⚠️ Discord only |
| Typing indicator | `sendChatAction("typing")` | `channel.sendTyping()` | ✅ Both (channel code) |
| Reactions | Limited (bot can set) | Full (`msg.react()`) | ❌ |
| Message streaming | `sendMessageDraft` (API 9.3+) | Edit message repeatedly | ❌ |

### Rich content

| Capability | Telegram | Discord |
|---|---|---|
| Inline keyboards/buttons | `InlineKeyboardMarkup` | `ActionRowBuilder` + `ButtonBuilder` |
| Embeds | No native equivalent | `EmbedBuilder` (rich cards) |
| Threads | Forum topics (API 9.3+) | Native threads (`startThread()`) |
| Slash commands | `BotCommand` + menu | Full interaction API with autocomplete |
| Voice | `sendVoice`, `sendVideoNote` | Voice channels (streaming) |

### Evolution plan (tiers)

**Tier 1 — blocks real functionality (do next):**
- File/image attachments in and out (Pi tools create files; users send screenshots)
- Message editing for streaming responses (TG: `sendMessageDraft`, Discord: edit)

**Tier 2 — quality of life:**
- Slash/bot commands: `/new`, `/status`, `/model` (TG: `BotCommand`, Discord: interactions)
- Threads for conversation isolation (Discord native, TG forum topics)

**Tier 3 — someday:**
- Embeds, buttons, reactions, voice

### Interface evolution path

**Current (v0.2–0.3): Option A — extend with attachments**
```typescript
interface IncomingMessage {
  channelId: string;
  senderId: string;
  text?: string;
  attachments?: Attachment[];
  command?: string;
}

interface ChannelResponse {
  text: string;
  attachments?: Attachment[];
}

interface Attachment {
  filename: string;
  url?: string;
  path?: string;
  mimeType?: string;
}
```

**Future: Option B — streaming callback (when we tackle message streaming)**
```typescript
type OnMessage = (message: IncomingMessage, reply: ReplyHandle) => Promise<void>;

interface ReplyHandle {
  sendText(text: string): Promise<void>;
  updateText(text: string): Promise<void>;  // edit last msg
  sendFile(path: string, filename?: string): Promise<void>;
}
```

Option A doesn't block Option B — we can migrate when streaming becomes priority.

## Open questions
- Pi auth token expiry/refresh behavior — untested with long-running daemon
- Model routing design (simple→cheap model, complex→expensive model)
- Cost monitoring — no per-conversation cost tracking yet
- MCP (Model Context Protocol) integration — expose daemon capabilities as MCP server,
  consume external MCP servers for tool extensibility
- Whether memory updates should be automatic
- Can Pi sessions be forked? (e.g. fresh session for a task without polluting channel context)
- Project naming (pre-open-source)

## Ideas & inspiration

### From mom (Pi mono-repo)
- **Events system** — immediate, one-shot, and periodic (cron) scheduled wake-ups.
  JSON files in a directory, daemon watches and triggers. Clean pattern for
  reminders and scheduled tasks.
- **Per-channel context management** — `log.jsonl` (full history, source of truth) +
  `context.jsonl` (what LLM sees) + compaction when context overflows. Gives the
  agent searchable infinite history beyond its context window.
- **File attachments** — receiving files/images from users, sending files back
  through the channel.
- **Self-managing skills** — agent creates its own CLI tools and remembers them
  across sessions. Skills stored per-channel or globally.

### Proactive & autonomous
- **Cron awareness / autonomous check-ins** — wake up on schedule, notice things,
  be proactive. Morning briefings, overnight error checks, periodic inbox scans.
- **Ambient system awareness** — lightweight knowledge of what's running, disk
  usage, git activity, systemd failures — without having to manually check.
- **Morning briefing format** — weather, systemd failures overnight, calendar
  events, anything notable. Delivered to a channel on schedule.

### Learning & memory
- **Session learning** — periodic review of past conversations to distill patterns,
  preferences, and recurring topics. Get better over time.
- **Auto-summarizing** — journal entries into weekly digests, long conversations
  into key takeaways.

### Multi-channel
- **Channel-specific personality/formatting** — same dragon, different doors.
  Telegram gets compact messages, Discord gets embeds, IRC gets plain text.

## TODO

### v0.2 (current) ✅
- [x] Multi-channel architecture
- [x] TOML config with env var resolution
- [x] Per-channel sessions
- [x] Hot reload
- [x] Telegram channel extracted

### v0.3 — validate & harden
- [x] Second channel (Discord) to validate architecture
- [x] Session management commands (/new, /status)
- [x] Image/file support in channel interface
- [ ] Structured logging
- [ ] Model routing (simple→local/cheap, complex→cloud/expensive)
- [ ] Hot reload: bust Node import cache (append `?t=Date.now()` to dynamic import URL)
- [ ] Shutdown timeout — force exit after 10s if `stopAll()` hangs
- [ ] Share one `DefaultResourceLoader` across channels instead of creating per-channel
- [ ] Telegram: switch from `Markdown` to `HTML` parse mode (more forgiving with LLM output)
- [ ] Telegram: guard against empty chunks in `splitMessage`
- [ ] Consider exiting on `unhandledRejection` if it originates from pi SDK (broken session state)
- [ ] Health check — tiny HTTP endpoint or PID file with last-active timestamp

### v0.4 — proactive features
- [ ] Events system (immediate, one-shot, periodic/cron)
- [ ] Morning briefing / scheduled check-ins
- [ ] Ambient system awareness (systemd, disk, git)

### v0.5 — integrations
- [ ] MCP server — expose daemon capabilities via Model Context Protocol
- [ ] MCP client — consume external MCP servers for tool extensibility
- [ ] Home Assistant integration (via MCP or REST)

### v0.6 — smarter context
- [ ] Per-channel context management (log + context + compaction)
- [ ] Session learning / conversation review
- [ ] Cost/token tracking

### v1.0 — open source release
- [ ] Project naming
- [ ] License, contributing guide
- [ ] Documentation for channel authors
- [ ] Example channel template
- [ ] Onboarding wizard or setup script
