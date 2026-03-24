// Channel interface — the contract every channel must implement.
// ----------------------------------------------------------------
// A channel is a messaging surface (Telegram, Discord, IRC, etc.)
// that bridges external messages to the Pi agent and back.

export interface IncomingMessage {
  channelId: string;
  senderId: string;
  text?: string;
  // Future: images, voice, files
}

export interface ChannelResponse {
  text: string;
  // Future: images, files, structured content
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
  [key: string]: unknown;
}
