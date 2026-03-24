// Telegram channel — bridges Telegram messages to the core.
// -----------------------------------------------------------

import TelegramBot, { type Message } from "node-telegram-bot-api";
import type {
  Attachment,
  Channel,
  ChannelConfig,
  ChannelFactory,
  OnMessage,
} from "../../src/channel.js";
import { downloadFile, downloadPath } from "../../src/download.js";

interface TelegramConfig extends ChannelConfig {
  token: string;
  allowedUsers: number[];
  downloadDir: string;
}

function validateConfig(raw: ChannelConfig): TelegramConfig {
  const token = raw.token as string | undefined;
  const allowedUsers = raw.allowedUsers as number[] | undefined;
  const downloadDir = raw.downloadDir as string | undefined;

  if (!token) throw new Error("Telegram channel: missing 'token' in config.");
  if (!allowedUsers?.length)
    throw new Error("Telegram channel: missing 'allowedUsers' in config.");
  if (!downloadDir)
    throw new Error("Telegram channel: missing 'downloadDir' (should be injected by core).");

  return { ...raw, token, allowedUsers, downloadDir };
}

// ── Command parsing ──────────────────────────────────────────

interface ParsedCommand {
  command: string;
  args: string;
}

function parseCommand(text: string): ParsedCommand | null {
  // Telegram commands: /command or /command@botname
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?\s*(.*)/s);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2].trim() };
}

// ── Attachment extraction ────────────────────────────────────

async function extractAttachments(
  msg: Message,
  bot: TelegramBot,
  downloadDir: string,
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];

  // Photos — take the largest resolution
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    const attachment = await downloadTelegramFile(
      bot,
      largest.file_id,
      "photo.jpg",
      "image/jpeg",
      downloadDir,
    );
    if (attachment) attachments.push(attachment);
  }

  // Documents (files)
  if (msg.document) {
    const attachment = await downloadTelegramFile(
      bot,
      msg.document.file_id,
      msg.document.file_name ?? "document",
      msg.document.mime_type,
      downloadDir,
    );
    if (attachment) attachments.push(attachment);
  }

  // Voice messages
  if (msg.voice) {
    const attachment = await downloadTelegramFile(
      bot,
      msg.voice.file_id,
      "voice.ogg",
      msg.voice.mime_type ?? "audio/ogg",
      downloadDir,
    );
    if (attachment) attachments.push(attachment);
  }

  // Audio files
  if (msg.audio) {
    const attachment = await downloadTelegramFile(
      bot,
      msg.audio.file_id,
      msg.audio.title ? `${msg.audio.title}.mp3` : "audio.mp3",
      msg.audio.mime_type ?? "audio/mpeg",
      downloadDir,
    );
    if (attachment) attachments.push(attachment);
  }

  // Video
  if (msg.video) {
    const attachment = await downloadTelegramFile(
      bot,
      msg.video.file_id,
      "video.mp4",
      msg.video.mime_type ?? "video/mp4",
      downloadDir,
    );
    if (attachment) attachments.push(attachment);
  }

  // Stickers (as images)
  if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) {
    const attachment = await downloadTelegramFile(
      bot,
      msg.sticker.file_id,
      "sticker.webp",
      "image/webp",
      downloadDir,
    );
    if (attachment) attachments.push(attachment);
  }

  return attachments;
}

async function downloadTelegramFile(
  bot: TelegramBot,
  fileId: string,
  filename: string,
  mimeType: string | undefined,
  downloadDir: string,
): Promise<Attachment | null> {
  try {
    const url = await bot.getFileLink(fileId);
    const destPath = downloadPath(downloadDir, filename);
    await downloadFile(url, destPath);

    return {
      filename,
      url,
      path: destPath,
      mimeType,
    };
  } catch (err) {
    console.error(
      `[telegram] Failed to download file "${filename}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Channel factory ──────────────────────────────────────────

function createTelegramChannel(raw: ChannelConfig): Channel {
  const config = validateConfig(raw);
  let bot: TelegramBot | null = null;
  const processingMessages = new Set<number>();

  return {
    id: "telegram",

    async start(onMessage: OnMessage): Promise<void> {
      bot = new TelegramBot(config.token, { polling: true });

      console.log("[telegram] Bot started, polling for messages...");

      bot.on("message", async (msg: Message) => {
        if (!bot) return;

        const chatId = msg.chat.id;
        const userId = msg.from?.id;

        // Auth check
        if (!userId || !config.allowedUsers.includes(userId)) {
          console.log(`[telegram] Rejected message from unauthorized user: ${userId}`);
          await bot.sendMessage(chatId, "🐉 Sorry, I only talk to my human.");
          return;
        }

        // Dedup
        const msgId = msg.message_id;
        if (processingMessages.has(msgId)) return;
        processingMessages.add(msgId);

        const firstName = msg.from?.first_name ?? "unknown";

        // Extract text and parse commands
        const text = msg.text ?? msg.caption ?? "";
        const parsed = parseCommand(text);
        const messageText = parsed ? parsed.args : text;

        // Extract attachments
        const attachments = await extractAttachments(msg, bot!, config.downloadDir);

        // Skip if no content at all
        if (!messageText && !attachments.length && !parsed) {
          await bot.sendMessage(chatId, "🐉 I can only read text and file messages for now.");
          processingMessages.delete(msgId);
          return;
        }

        const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
        const attachInfo = attachments.length ? ` [+${attachments.length} file(s)]` : "";
        console.log(`[telegram] Message from ${firstName}: ${preview}${attachInfo}`);

        // Typing indicator
        try {
          await bot.sendChatAction(chatId, "typing");
        } catch {
          // Non-fatal
        }

        const typingInterval = setInterval(async () => {
          try {
            await bot?.sendChatAction(chatId, "typing");
          } catch {
            // Non-fatal
          }
        }, 4000);

        try {
          const response = await onMessage({
            channelId: "telegram",
            senderId: String(userId),
            text: messageText || undefined,
            attachments: attachments.length ? attachments : undefined,
            command: parsed?.command,
            commandArgs: parsed?.args || undefined,
          });

          // Send response attachments first
          if (response.attachments?.length) {
            for (const att of response.attachments) {
              if (!att.path) continue;
              try {
                if (att.mimeType?.startsWith("image/")) {
                  await bot.sendPhoto(chatId, att.path);
                } else {
                  await bot.sendDocument(chatId, att.path);
                }
              } catch (err) {
                console.error(
                  `[telegram] Failed to send file "${att.filename}":`,
                  err instanceof Error ? err.message : err,
                );
              }
            }
          }

          // Send text response
          if (response.text) {
            const chunks = splitMessage(response.text, 4000);
            for (const chunk of chunks) {
              await bot
                .sendMessage(chatId, chunk, { parse_mode: "Markdown" })
                .catch(async () => {
                  await bot?.sendMessage(chatId, chunk);
                });
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("[telegram] Error processing message:", errMsg);
          await bot.sendMessage(chatId, `🐉💥 Something went wrong: ${errMsg}`);
        } finally {
          clearInterval(typingInterval);
          processingMessages.delete(msgId);
        }
      });

      bot.on("polling_error", (error: Error) => {
        console.error("[telegram] Polling error:", error.message);
      });
    },

    async stop(): Promise<void> {
      if (bot) {
        await bot.stopPolling();
        bot = null;
        console.log("[telegram] Bot stopped.");
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.5) {
      breakAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakAt < maxLen * 0.3) {
      breakAt = maxLen;
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}

export default createTelegramChannel satisfies ChannelFactory;
