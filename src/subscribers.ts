import { EventBus, NotificationEvent } from './pubsub';
import { NotificationStore } from './store';

// =================================================================
// SUBSCRIBERS — Three independent reactions to the same event
// =================================================================
//
// Each subscriber:
//   - Receives the SAME event
//   - Does its OWN thing independently
//   - If one crashes, the others keep working
//
// This is the DECOUPLING benefit of Pub/Sub:
//   - Worker doesn't know about feeds, counters, or analytics
//   - Adding a new subscriber requires ZERO changes to existing code
//   - Each subscriber can be scaled independently
//
// In a microservices architecture, each subscriber could be a
// separate service running on separate servers.
// =================================================================

export function registerSubscribers(eventBus: EventBus, store: NotificationStore): void {

  // ── Subscriber 1: Update Notification Feed ──────────────────
  //
  // Adds the delivered notification to the user's feed (Sorted Set).
  // This is INDEPENDENT of the email sending — it reacts to the event.

  eventBus.subscribe('notification:delivered', async (event: NotificationEvent) => {
    await store.addToFeed(event.userId, {
      id: event.jobId,
      channel: event.channel,
      type: event.notificationType,
      title: event.title,
      body: event.body,
    });
    console.log(`    [Subscriber 1] Feed updated for user ${event.userId}`);
  });


  // ── Subscriber 2: Update Unread Count ───────────────────────
  //
  // Increments the unread counter (Hash).
  // If this subscriber crashes, the feed still gets updated.

  eventBus.subscribe('notification:delivered', async (event: NotificationEvent) => {
    const newCount = await store.incrementUnread(event.userId);
    console.log(`  [Subscriber 2] Unread count for user ${event.userId}: ${newCount}`);
  });


  // ── Subscriber 3: Log Analytics ─────────────────────────────
  //
  // Tracks metrics: how many notifications sent per channel per day.
  // If analytics is down, email sending and feed updates still work.
  //
  // This uses Redis Hashes — same as unread counts, but for analytics.

  eventBus.subscribe('notification:delivered', async (event: NotificationEvent) => {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // We talk to Redis directly here for simplicity
    // In production, the store would have analytics methods
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

    await redis.hincrby(`analytics:${today}`, 'total', 1);
    await redis.hincrby(`analytics:${today}`, `channel:${event.channel}`, 1);
    await redis.expire(`analytics:${today}`, 86400 * 90); // Keep 90 days

    console.log(`Subscriber 3] Analytics logged: ${event.channel} on ${today}`);
    await redis.quit();
  });


  console.log('Registered 3 subscribers:');
  console.log('   1. Update notification feed (Sorted Set)');
  console.log('   2. Update unread count (Hash)');
  console.log('   3. Log analytics (Hash)');
}