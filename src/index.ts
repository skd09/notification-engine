import express from 'express';
import { Queue, Job } from './queue';
import { NotificationStore } from './store';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

const app = express();
app.use(express.json());

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(REDIS_URL);
const store = new NotificationStore(REDIS_URL);
const redis = new Redis(REDIS_URL);

// =================================================================
// LAYER 5: PUB/SUB + POINT-TO-POINT
//
// New: Analytics endpoint (powered by Subscriber 3)
// The API doesn't compute analytics — it just reads what the
// analytics subscriber has been writing to Redis.
// =================================================================


// ── Notification Endpoints ──────────────────────────────────────

app.post('/notify', async (req, res) => {
  const startTime = Date.now();
  const { userId, channel, subject, body, message, title } = req.body;

  if (!userId || !channel) {
    res.status(400).json({ error: 'userId and channel are required' });
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
  res.status(202).json({ status: 'queued', jobId: job.id, elapsed: `${elapsed}ms` });
});

app.post('/notify/multi', async (req, res) => {
  const startTime = Date.now();
  const { userId, channels, subject, body, message, title } = req.body;

  if (!userId || !channels || !Array.isArray(channels)) {
    res.status(400).json({ error: 'userId and channels[] are required' });
    return;
  }

  const jobs: Job[] = [];
  for (const channel of channels) {
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

  const elapsed = Date.now() - startTime;
  res.status(202).json({ status: 'queued', jobCount: jobs.length, elapsed: `${elapsed}ms` });
});


// ── Feed + Unread (same as Layer 4) ─────────────────────────────

app.get('/feed/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId);
  const count = parseInt(req.query.count as string) || 20;
  const feed = await store.getFeed(userId, count);
  const unread = await store.getUnreadCount(userId);

  res.json({ userId, unreadCount: unread, notifications: feed });
});

app.get('/unread/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId);
  const count = await store.getUnreadCount(userId);
  res.json({ userId, unreadCount: count });
});

app.post('/unread/:userId/read', async (req, res) => {
  const userId = parseInt(req.params.userId);
  await store.markAllRead(userId);
  res.json({ userId, unreadCount: 0 });
});

app.get('/unread', async (req, res) => {
  const allCounts = await store.getAllUnreadCounts();
  res.json({ counts: allCounts });
});


// ── Cached Preferences (same as Layer 4) ────────────────────────

const userPrefsDB: Record<number, any> = {
  1: { email: true, sms: false, push: true },
  2: { email: true, sms: true, push: true },
  3: { email: false, sms: false, push: true },
};

app.get('/prefs/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId);
  const prefs = await store.cacheThrough(`user_prefs:${userId}`, 3600, async () => {
    await new Promise(r => setTimeout(r, 200));
    return userPrefsDB[userId] || { email: true, sms: true, push: true };
  });
  res.json({ userId, preferences: prefs });
});

app.put('/prefs/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId);
  userPrefsDB[userId] = { ...userPrefsDB[userId], ...req.body };
  await store.cacheDelete(`user_prefs:${userId}`);
  res.json({ userId, preferences: userPrefsDB[userId] });
});


// ── Analytics (NEW — powered by Subscriber 3) ──────────────────

app.get('/analytics', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const data = await redis.hgetall(`analytics:${today}`);

  res.json({
    date: today,
    total: parseInt(data.total || '0', 10),
    byChannel: {
      email: parseInt(data['channel:email'] || '0', 10),
      sms: parseInt(data['channel:sms'] || '0', 10),
      push: parseInt(data['channel:push'] || '0', 10),
    },
    note: 'Powered by Pub/Sub Subscriber 3 — analytics are updated independently of notification sending',
  });
});


// ── Queue + DLQ ─────────────────────────────────────────────────

app.get('/queue/stats', async (req, res) => {
  const size = await queue.size();
  const dlqSize = await queue.dlqSize();
  res.json({ queueSize: size, dlqSize: dlqSize });
});

app.get('/dlq', async (req, res) => {
  const deadJobs = await queue.getDLQ();
  res.json({ count: await queue.dlqSize(), jobs: deadJobs });
});

app.post('/dlq/:jobId/retry', async (req, res) => {
  const success = await queue.retryFromDLQ(req.params.jobId);
  if (!success) {
    res.status(404).json({ error: 'Job not found in DLQ' });
    return;
  }
  res.json({ status: 'retrying', jobId: req.params.jobId });
});

app.post('/dlq/retry-all', async (req, res) => {
  const count = await queue.retryAllDLQ();
  res.json({ status: 'retrying', count });
});


// ── Architecture Info ───────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    layer: 'Layer 5: Pub/Sub + Point-to-Point',
    architecture: {
      'Point-to-Point': 'API → Redis Queue → ONE worker sends notification',
      'Pub/Sub': 'Worker → PUBLISH event → ALL subscribers react independently',
      subscribers: [
        'Subscriber 1: Update feed (Sorted Set)',
        'Subscriber 2: Update unread count (Hash)',
        'Subscriber 3: Log analytics (Hash)',
      ],
    },
  });
});


const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`\n API is running on http://localhost:${PORT}`);
});