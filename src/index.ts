import express from "express";
import { Queue, Job } from "./queue";
import { sendEmail, sendPush, sendSMS } from "./channels";
import { randomUUID } from "crypto";
import { NotificationStore } from "./store";


const app = express();
app.use(express.json());

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(REDIS_URL);
const store = new NotificationStore(REDIS_URL);


// =================================================================
// LAYER 4: REDIS DEEP DIVE
//
// New endpoints:
//   GET  /feed/:userId → notification feed (Sorted Set)
//   GET  /unread/:userId → unread count (Hash)
//   POST /unread/:userId/read → mark all read (Hash)
//   GET  /prefs/:userId → cached preferences (String + TTL)
//   PUT  /prefs/:userId → update prefs + invalidate cache
// =================================================================

// ── Simulate External Services ──────────────────────────────────
// Real services have real latency:
//   Email (SMTP/SES):  2-3 seconds
//   SMS (Twilio):      1-1.5 seconds
//   Push (FCM):        0.5-1 second


// API Endpoint

// POST /notify - send ONE notification synchronously (wait for it to complete before responding)
app.post('/notify', async (req, res) => {
    const startTime = Date.now();
    const { userId, channel, subject, body, message, title } = req.body;

    if(!userId || !channel) {
        res.status(400).json({ error: 'Missing userId or channel' });
        return;
    }

    const job: Job = {
        id: randomUUID(),
        type: 'notification',
        channel,
        userId,
        payload: { subject, body, message, title },
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
    };

    await queue.enqueue(job);

    const elapsed = Date.now() - startTime;

    res.status(202).json({
        status: 'queued',
        jobId: job.id,
        elapsed: `${elapsed}ms`, // Time would be ~5ms for enqueue, vs 2000ms+ if we sent directly
        note: 'ASYNC — job queued, worker will process it in the background',
    });
});

// POST /notify/multi — Multiple channels (delays stack up!)
app.post('/notify/multi', async (req, res) => {
    const startTime = Date.now();
    const { userId, channels, subject, body, message, title } = req.body;

    if(!userId || !channels || !Array.isArray(channels)) {
        return res.status(400).json({ error: 'Missing userId or channels (array)' });
    }

    const jobs: Job[] = [];

    const results: Array<{channel: string, elapsed: string}> = [];

    for(const channel of channels) {
      const job: Job = {
        id: randomUUID(),
        type: 'notification',
        channel,
        userId,
        payload: { subject, body, message, title },
        createdAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 3,
      };

      await queue.enqueue(job);
      jobs.push(job);
    }

    const totalElapsed = Date.now() - startTime;

    res.status(202).json({
        status: 'queued',
        jobCount: jobs.length,
        totalElapsedTime: `${totalElapsed} ms`,   // ~10ms for ALL channels (vs ~4500ms)
        note: 'All channels queued instantly — worker handles them in background',
    });
});

// GET /queue/stats — See what's in the queue
app.get('/queue/stats', async (req, res) => {
    const size = await queue.size();
    const dlqSize = await queue.dlqSize();

    res.json({ 
        queueSize: size,
        dlqSize: dlqSize
    });
});

// ── Dead Letter Queue API ───────────────────────────────────────

// GET /dlq — View all dead letter jobs
app.get('/dlq', async (req, res) => {
    const deadJobs = await queue.getDLQ();
    const dlqSize = await queue.dlqSize();

    res.json({ 
        dlqSize,
        deadJobs
    });
});

// POST /dlq/:jobId/retry — Retry a specific dead letter job
app.post('/dlq/:jobId/retry', async (req, res) => {
    const { jobId } = req.params;
    const success = await queue.retryFromDLQ(jobId);

    if(!success) {
        res.status(404).json({ error: `Job ${jobId} not found in DLQ` });
        return;
    }

    res.json({
        status: 'retrying',
        jobId,
        note: 'Job moved from DLQ back to main queue',
    });
});

// POST /dlq/retry-all — Retry ALL dead letter jobs
app.post('/dlq/retry-all', async (req, res) => {
  const count = await queue.retryAllDLQ();

  res.json({
    status: 'retrying',
    count,
    note: `${count} jobs moved from DLQ back to main queue`,
  });
});

// ── Notification Feed (Sorted Set) ─────────────────────────────

app.get('/feed/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    const count = parseInt(req.query.count as string, 10) || 20;

    const feed = await store.getFeed(userId, count);
    const feedSize = await store.getFeedSize(userId);
    const unread = await store.getUnreadCount(userId);

    res.json({
        userId,
        unreadCount: unread,
        totalInFeed: feedSize,
        notifications: feed,
        redisStructure: 'Sorted Set (ZADD/ZREVRANGE)',
    });
});

// ── Unread Counts (Hash) ────────────────────────────────────────


app.get('/unread/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId);
  const count = await store.getUnreadCount(userId);

  res.json({
    userId,
    unreadCount: count,
    redisStructure: 'Hash (HINCRBY/HGET)',
  });
});

app.post('/unread/:userId/read', async (req, res) => {
  const userId = parseInt(req.params.userId);
  await store.markAllRead(userId);

  res.json({
    userId,
    unreadCount: 0,
    note: 'All notifications marked as read',
  });
});

app.get('/unread', async (req, res) => {
  const allCounts = await store.getAllUnreadCounts();

  res.json({
    counts: allCounts,
    redisStructure: 'Hash (HGETALL)',
    note: 'All users unread counts in ONE Redis command',
  });
});

// ── Cached Preferences (String with TTL) ────────────────────────
// Simulate a "database" of user preferences
const userPrefsDB: Record<number, any> = {
  1: { email: true, sms: false, push: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' },
  2: { email: true, sms: true, push: true, quietHoursStart: '23:00', quietHoursEnd: '07:00' },
  3: { email: false, sms: false, push: true, quietHoursStart: '21:00', quietHoursEnd: '09:00' },
};

app.get('/prefs/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    // Cache-aside pattern: check cache first, fallback to "DB"
    const prefs = await store.cacheThrough(
        `user_prefs:${userId}`,
        3600, // Cache for 1 hour
        async () => {
            // This simulates a slow database query
            console.log(`🐌 DB query for user ${userId} preferences (slow!)`);
            await new Promise(r => setTimeout(r, 200)); // Simulate 200ms DB query
            return userPrefsDB[userId] || { email: true, sms: true, push: true };
    });

    res.json({
        userId,
        preferences: prefs,
        redisStructure: 'String with TTL (GET/SET EX)',
        note: 'First request hits "DB", subsequent requests hit cache',
    });
});


app.put('/prefs/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId);
  const newPrefs = req.body;

  // Update "database"
  userPrefsDB[userId] = { ...userPrefsDB[userId], ...newPrefs };

  // Invalidate cache — next GET will fetch fresh data
  await store.cacheDelete(`user_prefs:${userId}`);

  res.json({
    userId,
    preferences: userPrefsDB[userId],
    note: 'Preferences updated, cache invalidated',
  });
});



// ── Layer 1 endpoint still here for comparison ──────────────────

app.post('/notify/sync', async (req, res) => {
  const startTime = Date.now();
  const { userId, channel, subject, body, message, title } = req.body;

  switch (channel) {
    case 'email':
      await sendEmail(userId, subject || '', body || '');
      break;
    case 'sms':
      await sendSMS(userId, message || '');
      break;
    case 'push':
      await sendPush(userId, title || '', message || '');
      break;
  }

  const elapsed = Date.now() - startTime;
  res.json({ status: 'sent', elapsed: `${elapsed}ms`, note: 'SYNCHRONOUS — old way' });
});


app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', layer: 'Layer 1: synchronous' });
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}\n`);
});