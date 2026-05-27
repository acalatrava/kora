import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import type { IncomingEvent, MqttChannelConfig } from '../../core/types.js';
import { logger } from '../../core/logger.js';

const SCOPE = 'MqttChannel';

export function buildIdentityId(topic: string): string {
  return `mqtt:${topic}`;
}

export class MqttChannel {
  private client: MqttClient | null = null;
  private config: MqttChannelConfig;
  private onMessage: (event: IncomingEvent) => Promise<void>;
  private shouldReconnect = true;

  constructor(
    config: MqttChannelConfig,
    options: { onMessage: (event: IncomingEvent) => Promise<void> },
  ) {
    this.config = config;
    this.onMessage = options.onMessage;
  }

  async start(): Promise<void> {
    const opts: mqtt.IClientOptions = {};
    if (this.config.username) opts.username = this.config.username;
    if (this.config.password) opts.password = this.config.password;
    if (this.config.client_id) opts.clientId = this.config.client_id;

    this.client = mqtt.connect(this.config.broker_url, opts);

    this.client.on('connect', () => {
      logger.info(SCOPE, `Connected to MQTT broker ${this.config.broker_url}`);
      for (const topic of this.config.subscribe_topics) {
        this.client!.subscribe(topic, (err) => {
          if (err) logger.error(SCOPE, `Failed to subscribe to "${topic}": ${err.message}`);
          else logger.info(SCOPE, `Subscribed to "${topic}"`);
        });
      }
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      const content = payload.toString('utf-8');
      if (!content.trim()) return;

      logger.debug(SCOPE, `Message on "${topic}": ${content.slice(0, 200)}`);

      const event: IncomingEvent = {
        channel: 'mqtt',
        identityId: buildIdentityId(topic),
        type: 'message',
        content,
        metadata: { topic, raw: content },
      };

      this.onMessage(event).catch((err) => {
        logger.error(SCOPE, `Handler error for topic "${topic}": ${(err as Error).message}`);
      });
    });

    this.client.on('error', (err) => {
      logger.error(SCOPE, `MQTT error: ${err.message}`);
    });

    this.client.on('close', () => {
      if (this.shouldReconnect) {
        logger.warn(SCOPE, 'MQTT connection closed, will auto-reconnect');
      }
    });

    logger.info(SCOPE, `MQTT channel started (topics: ${this.config.subscribe_topics.join(', ')})`);
  }

  async publish(topic: string, message: string): Promise<void> {
    if (!this.client || !this.client.connected) {
      logger.warn(SCOPE, 'Cannot publish: MQTT client not connected');
      return;
    }
    return new Promise((resolve, reject) => {
      this.client!.publish(topic, message, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async send(topic: string, message: string): Promise<void> {
    await this.publish(topic, message);
  }

  getResponseTopic(): string {
    return this.config.response_topic || 'korabot/response';
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    logger.info(SCOPE, 'MQTT channel stopped');
  }
}
