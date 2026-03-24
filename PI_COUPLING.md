# Pi Daemon ↔ Pi Coupling

Last reviewed: 2026-03-24
Pi SDK: `@mariozechner/pi-coding-agent@0.62.0`

Short checklist of what can break when Pi changes.

## Risk levels
- **High** — likely to break startup or replies
- **Medium** — behavior may drift
- **Low** — minor convention dependency

## Main coupling points

### 1. SDK version — High
**File:** `package.json`

```json
"@mariozechner/pi-coding-agent": "^0.62.0"
```
Possible failures: build errors, import breakage, changed runtime behavior.

### 2. Pi SDK surface — High
**File:** `src/pi-adapter.ts`

Direct imports:
- `AuthStorage`
- `createAgentSession`
- `DefaultResourceLoader`
- `ModelRegistry`
- `SessionManager`
- `SettingsManager`
- `AgentSession`
- `AgentSessionEvent`

If these names or contracts change, the daemon breaks.

### 3. Auth storage — High
**Files:** `src/pi-adapter.ts`

Relies on Pi-managed auth via `AuthStorage.create()`, typically `~/.pi/agent/auth.json`.
Possible failures: no model available, token format changes, refresh behavior changes.

### 4. Resource + settings loading — Medium
**File:** `src/pi-adapter.ts`

Inherits Pi's discovery rules for skills, memory, settings.
Possible failures: different context loading, settings merge changes.

### 5. Session persistence — High
**File:** `src/pi-adapter.ts`

Per-channel sessions stored in `~/.pi/agent/sessions/<channel-id>/`.
Possible failures: wrong session restored, format incompatibility.

### 6. Session creation contract — High
**File:** `src/pi-adapter.ts`

`createAgentSession(...)` is the core integration point. If inputs or return values change, startup breaks.

### 7. Streaming event shape — High
**File:** `src/pi-adapter.ts`

Replies assembled from streamed Pi events (`message_update` → `text_delta`).
If event names or payload shape change, replies may become empty or partial.

### 8. Prompt semantics — Medium
**File:** `src/pi-adapter.ts`

Assumes one message = one `session.prompt()` cycle and that awaiting it means the reply is done.

### 9. Default tools — Medium
**Files:** `src/pi-adapter.ts`

No explicit tool list — inherits Pi defaults. Tool availability can change across Pi versions.

### 10. Path conventions — Medium
**Files:** `src/config.ts`, `config.toml`

Defaults: `~/.pi/agent` and `~/.pi/workspace`. If Pi changes conventions, the daemon may point at wrong state.

## Where coupling lives
- `src/pi-adapter.ts` — almost all direct Pi coupling
- `src/config.ts` — path conventions

## Upgrade checklist
After updating Pi, verify:
1. TypeScript still builds
2. Daemon starts
3. Auth still works
4. Sessions restore correctly per channel
5. Memory/skills still load
6. Replies stream correctly
7. Hot reload still works
