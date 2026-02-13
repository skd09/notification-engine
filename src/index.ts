import express from "express";
import { Queue, Job } from "./queue";
import { sendEmail, sendPush, sendSMS } from "./channels";
import { randomUUID } from "crypto";


const app = express();
app.use(express.json());

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(REDIS_URL);


// =================================================================
// LAYER 3: RETRY + DEAD LETTER QUEUE
//
// New in this layer:
//   - Jobs have attempt tracking (attempt/maxAttempts)
//   - Failed jobs are retried with exponential backoff
//   - After max retries, jobs move to Dead Letter Queue
//   - DLQ API: view, retry one, retry all
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
        return res.status(400).json({ error: 'Missing userId or channel' });
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

    res.json({
        status: 'queued',
        jobId: job.id,
        channel,
        userId,
        maxAttempts: job.maxAttempts,
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
    console.log(`POST /notify → queues job (fast, ~5ms)`);
    console.log(`POST /notify/sync → sends directly (slow, Layer 1 comparison)`);
    console.log(`GET  /queue/stats → see pending jobs\n`);
    console.log(`GET  /dlq → view dead letter jobs`);
    console.log(`POST /dlq/:id/retry → retry one dead letter`);
    console.log(`POST /dlq/retry-all → retry all dead letters\n`);
});