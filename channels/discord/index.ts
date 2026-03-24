// Discord channel — bridges Discord messages to the core.
// ---------------------------------------------------------

import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
} from "discord.js";
import type {
  Attachment,
  Channel,
  ChannelConfig,
  ChannelFactory,
  OnMessage,
} from "../../src/channel.js";
import { downloadFile, downloadPath } from "../../src/download.js";

interface DiscordConfig extends ChannelConfig {
  token: string;
  allowedUsers: string[];
  allowedChannels: string[];
  respondToReplies: boolean;
  downloadDir: string;
}

function validateConfig(raw: ChannelConfig): DiscordConfig {
  const token = raw.token as string | undefined;
  const allowedUsers = (raw.allowedUsers as string[] | undefined) ?? [];
  const allowedChannels = (raw.allowedChannels as string[] | undefined) ?? [];
  const respondToReplies = (raw.respondToReplies as boolean | undefined) ?? true;
  const downloadDir = raw.downloadDir as string | undefined;

  if (!token) throw new Error("Discord channel: missing 'token' in config.");
  if (!allowedUsers.length)
    throw new Error("Discord channel: missing 'allowedUsers' in config.");
  if (!downloadDir)
    throw new Error("Discord channel: missing 'downloadDir' (should be injected by core).");

  // Coerce to strings — Discord IDs are snowflakes (big ints), TOML may parse them as numbers
  return {
    ...raw,
    token,
    allowedUsers: allowedUsers.map(String),
    allowedChannels: allowedChannels.map(String),
    respondToReplies,
    downloadDir,
  };
}

// ── Command parsing ──────────────────────────────────────────

interface ParsedCommand {
  command: string;
  args: string;
}

function parseCommand(text: string): ParsedCommand | null {
  const match = text.match(/^\/([a-zA-Z0-9_]+)\s*(.*)/s);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: match[2].trim() };
}

// ── Attachment extraction ────────────────────────────────────

async function extractAttachments(
  msg: DiscordMessage,
  downloadDir: string,
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];

  for (const [, discordAtt] of msg.attachments) {
    try {
      const filename = discordAtt.name ?? "file";
      const destPath = downloadPath(downloadDir, filename);
      await downloadFile(discordAtt.url, destPath);

      attachments.push({
        filename,
        url: discordAtt.url,
        path: destPath,
        mimeType: discordAtt.contentType ?? undefined,
      });
    } catch (err) {
      console.error(
        `[discord] Failed to download attachment "${discordAtt.name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return attachments;
}

// ── Channel factory ──────────────────────────────────────────

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

        const rawText = stripMention(msg.content, client.user?.id);
        const parsed = parseCommand(rawText);
        const text = parsed ? parsed.args : rawText;

        // Extract attachments
        const attachments = await extractAttachments(msg, config.downloadDir);

        if (!text && !attachments.length && !parsed) {
          await msg.reply("🐉 I can only read text and file messages for now.");
          processingMessages.delete(msg.id);
          return;
        }

        const preview = rawText.length > 100 ? `${rawText.slice(0, 100)}...` : rawText;
        const attachInfo = attachments.length ? ` [+${attachments.length} file(s)]` : "";
        console.log(`[discord] Message from ${msg.author.username}: ${preview}${attachInfo}`);

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
            text: text || undefined,
            attachments: attachments.length ? attachments : undefined,
            command: parsed?.command,
            commandArgs: parsed?.args || undefined,
          });

          // Send response attachments
          const files: AttachmentBuilder[] = [];
          if (response.attachments?.length) {
            for (const att of response.attachments) {
              if (!att.path) continue;
              files.push(
                new AttachmentBuilder(att.path).setName(att.filename),
              );
            }
          }

          // Send text response (with files on first message)
          const chunks = splitMessage(response.text, 2000);

          for (let i = 0; i < chunks.length; i++) {
            if (i === 0) {
              await msg.reply({
                content: chunks[i],
                files: files.length ? files : undefined,
              });
            } else if ("send" in channel) {
              await channel.send(chunks[i]);
            }
          }

          // If no text but files, send files alone
          if (!response.text && files.length) {
            await msg.reply({ files });
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
