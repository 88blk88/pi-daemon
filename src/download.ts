// File download utility — downloads a URL to a local path.
// ---------------------------------------------------------

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/**
 * Download a file from a URL to a local path.
 * Creates parent directories automatically.
 */
export async function downloadFile(
  url: string,
  destPath: string,
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  if (!response.body) {
    throw new Error(`No response body: ${url}`);
  }

  const readable = Readable.fromWeb(response.body as never);
  await pipeline(readable, createWriteStream(destPath));
}

/**
 * Generate a unique filename to avoid collisions.
 * Prepends a timestamp: "1711234567890-photo.png"
 */
export function uniqueFilename(filename: string): string {
  return `${Date.now()}-${filename}`;
}

/**
 * Build a download path: downloadDir/filename (unique).
 */
export function downloadPath(downloadDir: string, filename: string): string {
  return join(downloadDir, uniqueFilename(filename));
}
