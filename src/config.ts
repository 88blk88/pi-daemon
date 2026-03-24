// Configuration loader
// ---------------------
// Loads .env for secrets, config.toml for daemon settings,
// and per-channel channel-config.toml files.
// Supports $ENV_VAR references in TOML values, resolved from .env / process.env.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseTOML } from "smol-toml";

// ── .env loader ──────────────────────────────────────────────

function loadEnv(projectDir: string): void {
  try {
    const envPath = resolve(projectDir, ".env");
    const content = readFileSync(envPath, "utf-8");

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — that's fine, env vars may be set externally
  }
}

// ── Env var resolution ───────────────────────────────────────

function resolveEnvVars(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const envKey = value.slice(1);
    const resolved = process.env[envKey];
    if (resolved === undefined) {
      console.warn(`[config] Warning: env var ${value} is not set`);
      return "";
    }
    return resolved;
  }

  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }

  if (typeof value === "object" && value !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveEnvVars(v);
    }
    return resolved;
  }

  return value;
}

// ── TOML loader ──────────────────────────────────────────────

function loadTOML(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8");
  return parseTOML(content) as Record<string, unknown>;
}

// ── Home path resolution ─────────────────────────────────────

function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) throw new Error("HOME is not set; cannot expand ~.");
    return resolve(home, p.slice(2));
  }
  return resolve(p);
}

// ── Types ────────────────────────────────────────────────────

export interface DaemonConfig {
  workDir: string;
  agentDir: string;
}

export interface ChannelEntry {
  dir: string;
  modulePath: string;
  config: Record<string, unknown>;
}

export interface LoadedConfig {
  daemon: DaemonConfig;
  channels: ChannelEntry[];
}

// ── Main loader ──────────────────────────────────────────────

export function loadConfig(projectDir: string): LoadedConfig {
  // Load .env first so TOML can reference env vars
  loadEnv(projectDir);

  // Load daemon config
  const configPath = resolve(projectDir, "config.toml");
  let rawDaemon: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    rawDaemon = loadTOML(configPath);
  } else {
    console.warn("[config] No config.toml found, using defaults.");
  }

  const daemonSection = (rawDaemon.daemon ?? {}) as Record<string, unknown>;

  const daemon: DaemonConfig = {
    workDir: expandTilde(
      String(resolveEnvVars(daemonSection.workDir) || "~/.pi/workspace"),
    ),
    agentDir: expandTilde(
      String(resolveEnvVars(daemonSection.agentDir) || "~/.pi/agent"),
    ),
  };

  // Scan channels directory
  const channelsDir = resolve(projectDir, "channels");
  const channels: ChannelEntry[] = [];

  if (!existsSync(channelsDir)) {
    console.warn("[config] No channels/ directory found.");
    return { daemon, channels };
  }

  const entries = readdirSync(channelsDir);

  for (const entry of entries) {
    const channelDir = join(channelsDir, entry);

    if (!statSync(channelDir).isDirectory()) continue;

    const configFile = join(channelDir, "channel-config.toml");
    const modulePath = join(channelDir, "index.ts");

    if (!existsSync(configFile)) {
      console.warn(`[config] Skipping channel "${entry}": no channel-config.toml`);
      continue;
    }

    if (!existsSync(modulePath)) {
      console.warn(`[config] Skipping channel "${entry}": no index.ts`);
      continue;
    }

    try {
      const rawConfig = loadTOML(configFile);
      const resolved = resolveEnvVars(rawConfig) as Record<string, unknown>;

      if (resolved.enabled === false) {
        console.log(`[config] Channel "${entry}" is disabled, skipping.`);
        continue;
      }

      channels.push({
        dir: channelDir,
        modulePath,
        config: { ...resolved, enabled: resolved.enabled !== false },
      });

      console.log(`[config] Found channel: ${entry}`);
    } catch (err) {
      console.error(
        `[config] Error loading channel "${entry}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { daemon, channels };
}
