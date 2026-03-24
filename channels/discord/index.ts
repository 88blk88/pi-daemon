// Discord channel — bridges Discord messages to the core.
// ---------------------------------------------------------

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
} from "discord.js";
import type {
  Channel,
  ChannelConfig,
  ChannelFactory,
  OnMessage,
} from "../../src/channel.js";

interface DiscordConfig extends ChannelConfig {
  token: string;
  allowedUsers: string[];
  allowedChannels: string[];
  respondToReplies: boolean;
}

function validateConfig(raw: ChannelConfig): DiscordConfig {
  const token = raw.token as string | undefined;
  const allowedUsers = (raw.allowedUsers as string[] | undefined) ?? [];
  const allowedChannels = (raw.allowedChannels as string[] | undefined) ?? [];
  const respondToReplies = (raw.respondToReplies as boolean | undefined) ?? true;

  if (!token) throw new Error("Discord channel: missing 'token' in config.");
  if (!allowedUsers.length)
    throw new Error("Discord channel: missing 'allowedUsers' in config.");

  // Coerce to strings — Discord IDs are snowflakes (big ints), TOML may parse them as numbers
  return {
    ...raw,
    token,
    allowedUsers: allowedUsers.map(String),
    allowedChannels: allowedChannels.map(String),
    respondToReplies,
  };
}

function createDiscordChannel(raw: ChannelConfig): Channel {
  const config = validateConfig(raw);
  let client: Client | null = null;
  const processingMessages = new Set<string>();

  return {
    id: "discord",

    async start(onMessage: OnMessage): Promise<void> {
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [
          // Needed to receive DMs
          Partials.Channel,
        ],
      });

      // Wait for the bot to be fully connected before resolving start()
      const ready = new Promise<void>((resolve) => {
        client!.once("clientReady", (c) => {
          console.log(`[discord] Bot online as ${c.user.tag}`);
          resolve();
        });
      });

      client.on("messageCreate", async (msg: DiscordMessage) => {
        if (!client) return;

        // Ignore own messages
        if (msg.author.id === client.user?.id) return;

        // Ignore other bots
        if (msg.author.bot) return;

        // Auth check
        if (!config.allowedUsers.includes(msg.author.id)) {
          // Silently ignore in servers, respond in DMs
          if (isDM(msg)) {
            await msg.reply("🐉 Sorry, I only talk to my human.");
          }
          return;
        }

        // Channel restriction (only applies in servers, not DMs)
        if (
          !isDM(msg) &&
          config.allowedChannels.length > 0 &&
          !config.allowedChannels.includes(msg.channelId)
        ) {
          return; // Silently ignore — not our channel
        }

        // In servers, only respond when mentioned or replied to
        if (!isDM(msg)) {
          const mentioned = isMentioned(msg, client);
          const repliedToBot =
            config.respondToReplies && isReplyToBot(msg, client);
          if (!mentioned && !repliedToBot) return;
        }

        // Dedup — websocket reconnects can replay events
        if (processingMessages.has(msg.id)) return;
        processingMessages.add(msg.id);

        const text = stripMention(msg.content, client.user?.id);

        if (!text) {
          await msg.reply("🐉 I can only read text messages for now.");
          return;
        }

        const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
        console.log(`[discord] Message from ${msg.author.username}: ${preview}`);

        // Typing indicator
        const channel = msg.channel;
        let typingInterval: NodeJS.Timeout | null = null;
        if ("sendTyping" in channel) {
          try {
            await channel.sendTyping();
            // sendTyping lasts ~10s, refresh it
            typingInterval = setInterval(async () => {
              try {
                if ("sendTyping" in channel) await channel.sendTyping();
              } catch {
                // Non-fatal
              }
            }, 8000);
          } catch {
            // Non-fatal
          }
        }

        try {
          const response = await onMessage({
            channelId: "discord",
            senderId: msg.author.id,
            text,
          });

          const chunks = splitMessage(response.text, 2000);

          for (let i = 0; i < chunks.length; i++) {
            if (i === 0) {
              await msg.reply(chunks[i]);
            } else if ("send" in channel) {
              await channel.send(chunks[i]);
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("[discord] Error processing message:", errMsg);
          await msg.reply(`🐉💥 Something went wrong: ${errMsg}`);
        } finally {
          if (typingInterval) clearInterval(typingInterval);
          processingMessages.delete(msg.id);
        }
      });

      await client.login(config.token);
      await ready;
    },

    async stop(): Promise<void> {
      if (client) {
        await client.destroy();
        client = null;
        console.log("[discord] Bot stopped.");
      }
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

function isDM(msg: DiscordMessage): boolean {
  return msg.guild === null;
}

function isMentioned(msg: DiscordMessage, client: Client): boolean {
  if (!client.user) return false;
  return msg.mentions.has(client.user);
}

function isReplyToBot(msg: DiscordMessage, client: Client): boolean {
  if (!client.user || !msg.reference) return false;
  // msg.reference.messageId exists, but we need to check who authored that message.
  // The replied-to message may be in the cache via msg.mentions.repliedUser.
  return msg.mentions.repliedUser?.id === client.user.id;
}

/** Remove the bot's @mention from the message text */
function stripMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
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

    // Try to break at a newline
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

export default createDiscordChannel satisfies ChannelFactory;
