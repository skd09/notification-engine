import Redis from 'ioredis';

// =================================================================
// EVENT BUS — Redis Pub/Sub
// =================================================================
//
// POINT-TO-POINT vs PUB/SUB:
//
//   Point-to-Point (LPUSH/BRPOP):
//     Producer → Queue → ONE consumer gets the message
//     Message is REMOVED from queue after consumption
//     Perfect for: tasks that should happen exactly once
//
//   Pub/Sub (PUBLISH/SUBSCRIBE):
//     Publisher → Channel → ALL subscribers get the message
//     Message is NOT stored — if nobody is listening, it's lost
//     Perfect for: events that multiple services react to
//
// IMPORTANT DIFFERENCE:
//   Queue: message is STORED until consumed (reliable)
//   Pub/Sub: message is BROADCAST and gone (fire-and-forget)
//
//   This is why we use the queue for sending emails (must not lose)
//   and pub/sub for updating feeds (can rebuild if missed)
//
// REDIS PUB/SUB COMMANDS:
//   SUBSCRIBE notifications:delivered   ← listen for events
//   PUBLISH notifications:delivered '{"userId":1,...}'  ← broadcast
//
// NOTE: Redis Pub/Sub needs TWO connections:
//   - One for subscribing (this connection is "blocked" listening)
//   - One for publishing (normal connection)
//   This is a Redis requirement, not a design choice.
// =================================================================

export interface NotificationEvent {
  type: string; // 'notification:delivered', 'notification:failed'
  jobId: string;
  userId: number;
  channel: string;
  notificationType: string;
  title: string;
  body?: string;
  timestamp: string;
}

type EventHandler = (event: NotificationEvent) => Promise<void>;

export class EventBus {
    private publisher: Redis;
    private subscriber: Redis;
    private handlers: Map<string, EventHandler[]> = new Map();

    constructor(redisUrl: string) {
        this.publisher = new Redis(redisUrl);
        this.subscriber = new Redis(redisUrl);
    }

    /**
     * Publish an event to a channel.
     * All subscribers listening on this channel will receive it.
     *
     * Redis command: PUBLISH notification:delivered '{"userId":1,...}'
     */

    async publish(channel: string, event: NotificationEvent): Promise<void> {
        const serialized = JSON.stringify(event);
        await this.publisher.publish(channel, serialized);
        console.log(`Published event to ${channel}: ${serialized}`);
    }

    /**
     * Subscribe to a channel and register a handler.
     * Multiple handlers can subscribe to the same channel.
     *
     * Redis command: SUBSCRIBE notification:delivered
     */
    async subscribe(channel: string, handler: EventHandler): Promise<void> {
        // Store handler
        if (!this.handlers.has(channel)) {
        this.handlers.set(channel, []);
        }
        this.handlers.get(channel)!.push(handler);

        // Only subscribe to Redis once per channel
        if (this.handlers.get(channel)!.length === 1) {
            await this.subscriber.subscribe(channel);
        }

        // Set up the message listener (only once)
        if (this.handlers.size === 1) {
        this.subscriber.on('message', async (ch: string, message: string) => {
            const event = JSON.parse(message) as NotificationEvent;
            const channelHandlers = this.handlers.get(ch) || [];

            // Run ALL handlers for this channel (that's the "pub" part of pub/sub)
            for (const h of channelHandlers) {
                try {
                    await h(event);
                } catch (error) {
                    // One subscriber failing doesn't affect others
                    console.error(`❌ Subscriber error on "${ch}":`, error);
                }
            }
        });
        }
    }

    async disconnect(): Promise<void> {
        await this.publisher.quit();
        await this.subscriber.quit();
    }
}