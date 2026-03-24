// Core — loads channels, manages sessions, routes messages, hot reload.
// ---------------------------------------------------------------------

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type {
  Channel,
  ChannelFactory,
  IncomingMessage,
  ChannelResponse,
  ChannelConfig,
} from "./channel.js";
import type { LoadedConfig, ChannelEntry, DaemonConfig } from "./config.js";
import { loadConfig } from "./config.js";
import {
  createChannelSession,
  sendMessage,
  disposeSession,
} from "./pi-adapter.js";

interface ActiveChannel {
  channel: Channel;
  entry: ChannelEntry;
}

const activeChannels = new Map<string, ActiveChannel>();
let watcher: FSWatcher | null = null;
let projectDir: string;
let daemonConfig: DaemonConfig;

// ── Message routing ──────────────────────────────────────────

async function handleMessage(msg: IncomingMessage): Promise<ChannelResponse> {
  const text = msg.text?.trim();
  if (!text) {
    return { text: "🐉 I can only read text messages for now." };
  }

  try {
    const response = await sendMessage(msg.channelId, text);
    return { text: response };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[core] Error routing message from ${msg.channelId}:`, errMsg);
    return { text: `🐉💥 Something went wrong: ${errMsg}` };
  }
}

// ── Channel lifecycle ────────────────────────────────────────

async function startChannel(entry: ChannelEntry): Promise<void> {
  const channelId = entry.config.id as string | undefined;

  if (!channelId) {
    console.error(`[core] Channel at ${entry.dir} has no "id" in config.`);
    return;
  }

  if (activeChannels.has(channelId)) {
    console.warn(`[core] Channel "${channelId}" already running, stopping first.`);
    await stopChannel(channelId);
  }

  try {
    // Dynamic import — the channel module must default-export a ChannelFactory
    // At runtime we're in dist/src/, channel compiled output is in dist/channels/
    const compiledPath = entry.modulePath
      .replace(/\.ts$/, ".js")
      .replace(projectDir, resolve(projectDir, "dist"));
    const modulePath = `file://${compiledPath}`;
    const mod = await import(modulePath);
    const factory: ChannelFactory = mod.default;

    if (typeof factory !== "function") {
      console.error(
        `[core] Channel "${channelId}": default export is not a function.`,
      );
      return;
    }

    const config: ChannelConfig = {
      enabled: true,
      ...entry.config,
    };

    const channel = factory(config);

    // Create Pi session for this channel
    await createChannelSession(channelId, daemonConfig);

    // Start the channel
    await channel.start(handleMessage);

    activeChannels.set(channelId, { channel, entry });
    console.log(`[core] ✅ Channel "${channelId}" started.`);
  } catch (err) {
    console.error(
      `[core] Failed to start channel "${channelId}":`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function stopChannel(channelId: string): Promise<void> {
  const active = activeChannels.get(channelId);
  if (!active) return;

  try {
    await active.channel.stop();
  } catch (err) {
    console.error(
      `[core] Error stopping channel "${channelId}":`,
      err instanceof Error ? err.message : err,
    );
  }

  disposeSession(channelId);
  activeChannels.delete(channelId);
  console.log(`[core] Channel "${channelId}" stopped.`);
}

// ── Hot reload ───────────────────────────────────────────────

let reloadTimeout: NodeJS.Timeout | null = null;

function scheduleReload(): void {
  // Debounce — file watchers often fire multiple events
  if (reloadTimeout) clearTimeout(reloadTimeout);
  reloadTimeout = setTimeout(() => {
    void reloadChannels();
  }, 1000);
}

async function reloadChannels(): Promise<void> {
  console.log("[core] 🔄 Reloading channels...");

  const fresh = loadConfig(projectDir);

  // Determine which channels should be running
  const freshIds = new Set<string>();

  for (const entry of fresh.channels) {
    const id = entry.config.id as string | undefined;
    if (!id) continue;
    freshIds.add(id);

    const existing = activeChannels.get(id);

    // If config changed or channel is new, restart it
    if (!existing || JSON.stringify(existing.entry.config) !== JSON.stringify(entry.config)) {
      console.log(`[core] Channel "${id}" changed or new, restarting...`);
      await stopChannel(id);
      await startChannel(entry);
    }
  }

  // Stop channels that were removed
  for (const [id] of activeChannels) {
    if (!freshIds.has(id)) {
      console.log(`[core] Channel "${id}" removed, stopping...`);
      await stopChannel(id);
    }
  }
}

// ── Public API ───────────────────────────────────────────────

export async function startAll(dir: string): Promise<void> {
  projectDir = dir;

  const config = loadConfig(projectDir);
  daemonConfig = config.daemon;

  console.log(`[core] Work dir: ${daemonConfig.workDir}`);
  console.log(`[core] Agent dir: ${daemonConfig.agentDir}`);
  console.log(`[core] Found ${config.channels.length} channel(s).`);

  for (const entry of config.channels) {
    await startChannel(entry);
  }

  // Watch channels directory for hot reload
  const channelsDir = resolve(projectDir, "channels");
  try {
    watcher = watch(channelsDir, { recursive: true }, (_event, _filename) => {
      scheduleReload();
    });
    console.log("[core] 👁️ Watching channels/ for changes.");
  } catch {
    console.warn("[core] Could not watch channels/ — hot reload disabled.");
  }
}

export async function stopAll(): Promise<void> {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  if (reloadTimeout) {
    clearTimeout(reloadTimeout);
    reloadTimeout = null;
  }

  const ids = [...activeChannels.keys()];
  for (const id of ids) {
    await stopChannel(id);
  }
}
