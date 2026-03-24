// Telegram channel — bridges Telegram messages to the core.
// -----------------------------------------------------------

import TelegramBot, { type Message } from "node-telegram-bot-api";
import type {
  Channel,
  ChannelConfig,
  ChannelFactory,
  OnMessage,
} from "../../src/channel.js";

interface TelegramConfig extends ChannelConfig {
  token: string;
  allowedUsers: number[];
}

function validateConfig(raw: ChannelConfig): TelegramConfig {
  const token = raw.token as string | undefined;
  const allowedUsers = raw.allowedUsers as number[] | undefined;

  if (!token) throw new Error("Telegram channel: missing 'token' in config.");
  if (!allowedUsers?.length)
    throw new Error("Telegram channel: missing 'allowedUsers' in config.");

  return { ...raw, token, allowedUsers };
}

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
        const text = msg.text;

        // Auth check
        if (!userId || !config.allowedUsers.includes(userId)) {
          console.log(`[telegram] Rejected message from unauthorized user: ${userId}`);
          await bot.sendMessage(chatId, "🐉 Sorry, I only talk to my human.");
          return;
        }

        if (!text) {
          await bot.sendMessage(chatId, "🐉 I can only read text messages for now.");
          return;
        }

        // Dedup
        const msgId = msg.message_id;
        if (processingMessages.has(msgId)) return;
        processingMessages.add(msgId);

        const firstName = msg.from?.first_name ?? "unknown";
        const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
        console.log(`[telegram] Message from ${firstName}: ${preview}`);

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
            text,
          });

          const chunks = splitMessage(response.text, 4000);

          for (const chunk of chunks) {
            await bot
              .sendMessage(chatId, chunk, { parse_mode: "Markdown" })
              .catch(async () => {
                await bot?.sendMessage(chatId, chunk);
              });
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
