import express from 'express';
import { Queue, Job } from './queue';
import { NotificationStore } from './store';
import { PollingHandlers } from './polling';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

const app = express();
app.use(express.json());

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(REDIS_URL);
const store = new NotificationStore(REDIS_URL);
const polling = new PollingHandlers(REDIS_URL, store);
const redis = new Redis(REDIS_URL);


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


// ── Feed + Unread ───────────────────────────────────────────────

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


// ── Cached Preferences ─────────────────────────────────────────

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


// ── Analytics ───────────────────────────────────────────────────

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
  });
});


// ── 4 Polling Strategies ────────────────────────────────────────

app.get('/polling/short', (req, res) => polling.shortPoll(req, res));
app.get('/polling/long', (req, res) => polling.longPoll(req, res));
app.get('/polling/stream', (req, res) => polling.sseStream(req, res));
app.get('/polling/websocket', (req, res) => polling.websocketInfo(req, res));
app.get('/polling/compare', (req, res) => polling.comparison(req, res));


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


// ── Health + Info ───────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    layer: 'Layer 6: Complete Notification Engine',
    endpoints: {
      notify: 'POST /notify, POST /notify/multi',
      feed: 'GET /feed/:userId',
      unread: 'GET /unread/:userId, POST /unread/:userId/read',
      cache: 'GET /prefs/:userId, PUT /prefs/:userId',
      analytics: 'GET /analytics',
      polling: 'GET /polling/short, /polling/long, /polling/stream, /polling/websocket',
      comparison: 'GET /polling/compare',
      queue: 'GET /queue/stats',
      dlq: 'GET /dlq, POST /dlq/:id/retry, POST /dlq/retry-all',
    },
  });
});


const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Notification Engine — All 6 Layers Complete!');
  console.log('='.repeat(60));
  console.log('');
  console.log('  Endpoints:');
  console.log(`  POST /notify              Queue notification`);
  console.log(`  GET  /feed/:userId         Notification feed`);
  console.log(`  GET  /unread/:userId       Unread count`);
  console.log(`  GET  /analytics            Daily analytics`);
  console.log('');
  console.log('  Polling Strategies:');
  console.log(`  GET  /polling/short        Short polling`);
  console.log(`  GET  /polling/long         Long polling (holds connection)`);
  console.log(`  GET  /polling/stream       SSE (server pushes events)`);
  console.log(`  GET  /polling/websocket    WebSocket info`);
  console.log(`  GET  /polling/compare      Compare all strategies`);
  console.log('');
  console.log(`  Running on http://localhost:${PORT}`);
  console.log('='.repeat(60));
  console.log('');
});