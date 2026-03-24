// Pi Adapter — the sole runtime boundary to Pi's SDK
// --------------------------------------------------
// Now supports multiple sessions (one per channel).
// If Pi changes, start here.

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { DaemonConfig } from "./config.js";

interface SessionEntry {
  session: AgentSession;
  channelId: string;
  queue: Promise<unknown>;
}

const sessions = new Map<string, SessionEntry>();

let sharedAuthStorage: ReturnType<typeof AuthStorage.create> | null = null;
let sharedModelRegistry: ModelRegistry | null = null;

function getSharedAuth() {
  if (!sharedAuthStorage) {
    sharedAuthStorage = AuthStorage.create();
    sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
  }
  return { authStorage: sharedAuthStorage, modelRegistry: sharedModelRegistry! };
}

export async function createChannelSession(
  channelId: string,
  daemon: DaemonConfig,
): Promise<void> {
  if (sessions.has(channelId)) {
    console.warn(`[pi-adapter] Session for "${channelId}" already exists.`);
    return;
  }

  const { authStorage, modelRegistry } = getSharedAuth();

  const resourceLoader = new DefaultResourceLoader({
    cwd: daemon.workDir,
    agentDir: daemon.agentDir,
  });
  await resourceLoader.reload();

  const sessionDir = `${daemon.agentDir}/sessions/${channelId}`;

  const sessionManager = SessionManager.continueRecent(
    daemon.workDir,
    sessionDir,
  );

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: daemon.workDir,
    agentDir: daemon.agentDir,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager: SettingsManager.create(daemon.workDir, daemon.agentDir),
  });

  if (modelFallbackMessage) {
    console.log(`[pi-adapter] [${channelId}] Model fallback: ${modelFallbackMessage}`);
  }

  console.log(
    `[pi-adapter] [${channelId}] Session file: ${session.sessionFile ?? "(in-memory)"}`,
  );

  sessions.set(channelId, { session, channelId, queue: Promise.resolve() });
}

function getTextDelta(event: AgentSessionEvent): string | null {
  if (event.type !== "message_update") return null;
  if (event.assistantMessageEvent.type !== "text_delta") return null;
  return event.assistantMessageEvent.delta;
}

async function doSendMessage(entry: SessionEntry, text: string): Promise<string> {
  let responseText = "";

  const unsubscribe = entry.session.subscribe((event: AgentSessionEvent) => {
    const delta = getTextDelta(event);
    if (delta) {
      responseText += delta;
    }
  });

  try {
    await entry.session.prompt(text);
  } finally {
    unsubscribe();
  }

  return responseText || "(no response)";
}

export function sendMessage(
  channelId: string,
  text: string,
): Promise<string> {
  const entry = sessions.get(channelId);
  if (!entry) {
    return Promise.reject(new Error(`No session for channel "${channelId}"`));
  }

  // Queue messages so concurrent prompts don't overlap on the same session.
  // Each message waits for the previous one to finish (or fail) before starting.
  const result = entry.queue.then(
    () => doSendMessage(entry, text),
    () => doSendMessage(entry, text),
  );
  entry.queue = result.catch(() => {}); // swallow so the queue chain doesn't break
  return result;
}

export function disposeSession(channelId: string): void {
  const entry = sessions.get(channelId);
  if (entry) {
    try {
      entry.session.dispose();
    } catch {
      // Best-effort cleanup
    }
    sessions.delete(channelId);
    console.log(`[pi-adapter] [${channelId}] Session disposed.`);
  }
}

export function shutdown(): void {
  for (const [channelId] of sessions) {
    disposeSession(channelId);
  }
  sharedAuthStorage = null;
  sharedModelRegistry = null;
}
