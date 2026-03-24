// Channel interface — the contract every channel must implement.
// ----------------------------------------------------------------
// A channel is a messaging surface (Telegram, Discord, IRC, etc.)
// that bridges external messages to the Pi agent and back.

/** A file or image attached to a message */
export interface Attachment {
  /** Original filename */
  filename: string;
  /** Remote URL (set by channel before download) */
  url?: string;
  /** Local file path (set after download or for outgoing files) */
  path?: string;
  /** MIME type, e.g. "image/png", "application/pdf" */
  mimeType?: string;
}

export interface IncomingMessage {
  channelId: string;
  senderId: string;
  text?: string;
  attachments?: Attachment[];
  /** Parsed command name without slash, e.g. "new", "status" */
  command?: string;
  /** Arguments after the command, e.g. "/model gpt-4" → commandArgs = "gpt-4" */
  commandArgs?: string;
}

export interface ChannelResponse {
  text: string;
  attachments?: Attachment[];
}

export type OnMessage = (message: IncomingMessage) => Promise<ChannelResponse>;

export interface Channel {
  /** Unique channel identifier, e.g. "telegram" */
  readonly id: string;

  /** Start the channel (connect, begin polling/listening) */
  start(onMessage: OnMessage): Promise<void>;

  /** Stop the channel gracefully */
  stop(): Promise<void>;
}

/** What a channel module's default export must look like */
export type ChannelFactory = (config: ChannelConfig) => Channel;

/** Parsed channel-config.toml with env vars resolved */
export interface ChannelConfig {
  enabled: boolean;
  /** Injected by core — directory for saving incoming file attachments */
  downloadDir?: string;
  [key: string]: unknown;
}
