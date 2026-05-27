import { logger } from './logger.js';
import type { Dispatcher } from './dispatcher.js';
import type { IncomingEvent, OutgoingEvent } from './types.js';

type ChannelSendFn = (identityId: string, event: OutgoingEvent) => Promise<void>;
type ChannelTypingFn = (identityId: string) => Promise<void>;

const SCOPE = 'router';

export class Router {
  private dispatcher: Dispatcher;
  private channels: Map<string, ChannelSendFn> = new Map();
  private typingFns: Map<string, ChannelTypingFn> = new Map();
  private processing: Map<string, boolean> = new Map();
  private pendingMessages: Map<string, IncomingEvent[]> = new Map();
  private replyWaiters: Map<string, (reply: IncomingEvent) => void> = new Map();

  constructor(dispatcher: Dispatcher) {
    this.dispatcher = dispatcher;
  }

  registerChannel(
    channelName: string,
    sendFn: ChannelSendFn,
    typingFn?: ChannelTypingFn,
  ): void {
    this.channels.set(channelName, sendFn);
    if (typingFn) this.typingFns.set(channelName, typingFn);
    logger.info(SCOPE, `Registered channel "${channelName}"`);
  }

  private eventKey(event: IncomingEvent): string {
    const routingKey = event.metadata?.routingKey as string | undefined;
    if (routingKey) return routingKey;
    return `${event.channel}:${event.identityId}`;
  }

  waitForReplyFromAny(
    targets: Array<{ channel: string; identityId: string }>,
    timeoutMs: number,
  ): Promise<IncomingEvent | null> {
    return new Promise<IncomingEvent | null>((resolve) => {
      const keys = targets.map(t => `${t.channel}:${t.identityId}`);
      let resolved = false;

      const cleanup = () => {
        for (const key of keys) {
          this.replyWaiters.delete(key);
          this.processing.delete(key);
        }
      };

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(null);
      }, timeoutMs);

      for (const key of keys) {
        this.processing.set(key, true);
        this.replyWaiters.set(key, (reply: IncomingEvent) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          cleanup();
          resolve(reply);
        });
      }
    });
  }

  async handleEvent(event: IncomingEvent): Promise<void> {
    const key = this.eventKey(event);

    if (this.processing.get(key)) {
      const text = event.content ?? '';
      const hasAttachments = event.attachments && event.attachments.length > 0;
      if (text.trim() || hasAttachments) {
        const waiter = this.replyWaiters.get(key);
        if (waiter) {
          logger.info(SCOPE, `User replied while agent waited for ${key}: "${text.slice(0, 80)}"${hasAttachments ? ` (${event.attachments!.length} attachment(s))` : ''}`);
          this.replyWaiters.delete(key);
          waiter(event);
          return;
        }
        logger.info(SCOPE, `Agent busy for ${key}, queuing message for next iteration: "${text.slice(0, 80)}"`);
        const queue = this.pendingMessages.get(key) ?? [];
        queue.push(event);
        this.pendingMessages.set(key, queue);
      }
      return;
    }

    event.drainPendingMessages = () => {
      const queue = this.pendingMessages.get(key);
      if (!queue || queue.length === 0) return [];
      const drained = queue.splice(0, queue.length);
      return drained.map(e => e.content ?? '');
    };

    if (!event.sendInterimMessage) {
      event.sendInterimMessage = async (text: string) => {
        const sendFn = this.channels.get(event.channel);
        if (sendFn) {
          try {
            await sendFn(event.identityId, {
              channel: event.channel,
              identityId: event.identityId,
              type: 'message',
              content: text,
              metadata: event.metadata,
            });
          } catch { /* best effort */ }
        }
      };
    }

    event.waitForReply = (timeoutMs: number): Promise<IncomingEvent | null> => {
      return new Promise<IncomingEvent | null>((resolve) => {
        const timer = setTimeout(() => {
          this.replyWaiters.delete(key);
          resolve(null);
        }, timeoutMs);
        this.replyWaiters.set(key, (replyEvent: IncomingEvent) => {
          clearTimeout(timer);
          resolve(replyEvent);
        });
      });
    };

    this.processing.set(key, true);
    try {
      await this.processEvent(event);
    } finally {
      this.processing.set(key, false);
      this.pendingMessages.delete(key);
    }
  }

  private async processEvent(event: IncomingEvent): Promise<void> {
    logger.debug(SCOPE, `Incoming ${event.type} from ${event.channel}:${event.identityId}`);

    const typingFn = this.typingFns.get(event.channel);
    let typingInterval: ReturnType<typeof setInterval> | null = null;

    if (!event.setTyping) {
      event.setTyping = (active: boolean) => {
        if (active && typingFn && !typingInterval) {
          typingFn(event.identityId).catch(() => {});
          typingInterval = setInterval(() => {
            typingFn(event.identityId).catch(() => {});
          }, 4000);
        } else if (!active && typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }
      };
    } else {
      const channelSetTyping = event.setTyping;
      const wrapped = (active: boolean) => {
        if (active && !typingInterval) {
          channelSetTyping(true);
          typingInterval = setInterval(() => channelSetTyping(true), 4000);
        } else if (!active && typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
          channelSetTyping(false);
        }
      };
      event.setTyping = wrapped;
    }

    try {
      if (event.setTyping) {
        event.setTyping(true);
      }

      const outgoing = await this.dispatcher.handleIncomingEvent(event);

      if (typingInterval) clearInterval(typingInterval);

      if (!outgoing.content) {
        logger.debug(SCOPE, `Skipping empty response for ${outgoing.channel}:${outgoing.identityId} (likely sent via notify)`);
        return;
      }

      const sendFn = this.channels.get(outgoing.channel);
      if (!sendFn) {
        logger.warn(SCOPE, `No send function registered for channel "${outgoing.channel}"`);
        return;
      }

      await sendFn(outgoing.identityId, outgoing);
    } catch (err) {
      if (typingInterval) clearInterval(typingInterval);
      const message = err instanceof Error ? err.message : String(err);
      logger.error(SCOPE, `Failed to handle event: ${message}`);

      const sendFn = this.channels.get(event.channel);
      if (sendFn) {
        try {
          await sendFn(event.identityId, {
            channel: event.channel,
            identityId: event.identityId,
            type: 'message',
            content: 'Something went wrong processing your request. Try again.',
            metadata: event.metadata,
          });
        } catch { /* best effort */ }
      }
    }
  }
}
