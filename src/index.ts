#!/usr/bin/env node

// 🐉 Pi Daemon — always-on dragon assistant
// ===========================================================
// Multi-channel bridge between messaging platforms and Pi's agent SDK.
// Each channel gets its own Pi session with shared memory, skills, and tools.

import { resolve } from "node:path";
import { startAll, stopAll } from "./core.js";
import { shutdown } from "./pi-adapter.js";

const VERSION = "0.2.0";
// At runtime we're in dist/src/, project root is two levels up
const projectDir = resolve(import.meta.dirname, "../..");

console.log(`🐉 Pi Daemon v${VERSION}`);
console.log("----------------------------");

await startAll(projectDir);

console.log("🐉 Dragon is awake and listening!");

let exiting = false;

function handleExit(signal: NodeJS.Signals): void {
  if (exiting) return;
  exiting = true;

  console.log(`\n[shutdown] Received ${signal}, shutting down...`);

  void (async () => {
    await stopAll();
    shutdown();
    console.log("[shutdown] 🐉 Dragon sleeps. Goodbye!");
    process.exit(0);
  })();
}

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);

process.on("uncaughtException", (error: Error) => {
  console.error("[error] Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (error: unknown) => {
  console.error("[error] Unhandled rejection:", error);
});
