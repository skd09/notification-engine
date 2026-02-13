import { Queue, Job } from './queue';
import { EventBus, NotificationEvent } from './pubsub';
import { NotificationStore } from './store';
import { registerSubscribers } from './subscribers';
import { sendEmail, sendSMS, sendPush } from './channels';

// =================================================================
// WORKER — Now uses Pub/Sub for side effects
//
// Before (Layer 4):
//   Worker sends email → worker updates feed → worker updates count
//   Worker does EVERYTHING. Tightly coupled.
//
// After (Layer 5):
//   Worker sends email → worker PUBLISHES event → done
//   Subscribers INDEPENDENTLY react:
//     Subscriber 1 updates feed
//     Subscriber 2 updates count
//     Subscriber 3 logs analytics
//
// Why is this better?
//   - Worker only does ONE thing (send notifications)
//   - Adding a new reaction = add a subscriber (no worker changes)
//   - If analytics subscriber crashes, notifications still send
// =================================================================

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(REDIS_URL);
const eventBus = new EventBus(REDIS_URL);
const store = new NotificationStore(REDIS_URL);

// Register all subscribers BEFORE starting the worker
registerSubscribers(eventBus, store);

async function processJob(job: Job): Promise<void> {
  // 1. Send the notification (Point-to-Point — only THIS worker does it)
  switch (job.channel) {
    case 'email':
      await sendEmail(job.userId, job.payload.subject || '', job.payload.body || '');
      break;
    case 'sms':
      await sendSMS(job.userId, job.payload.message || '');
      break;
    case 'push':
      await sendPush(job.userId, job.payload.title || '', job.payload.message || '');
      break;
    default:
      throw new Error(`Unknown channel: ${job.channel}`);
  }

  // 2. Publish event (Pub/Sub — ALL subscribers react)
  const event: NotificationEvent = {
    type: 'notification:delivered',
    jobId: job.id,
    userId: job.userId,
    channel: job.channel,
    notificationType: job.type,
    title: job.payload.subject || job.payload.title || job.payload.message || '',
    body: job.payload.body,
    timestamp: new Date().toISOString(),
  };

  await eventBus.publish('notification:delivered', event);
}

async function startWorker(): Promise<void> {
  console.log('');
  console.log('='.repeat(55));
  console.log('  Worker started');
  console.log('');
  console.log('  Point-to-Point: sends notifications (one worker per job)');
  console.log('  Pub/Sub: publishes events (all subscribers react)');
  console.log('='.repeat(55));
  console.log('');

  while (true) {
    try {
      const job = await queue.dequeue(5);
      if (!job) continue;

      console.log(`\n Processing job ${job.id} (${job.channel}) attempt ${job.attempt}/${job.maxAttempts}`);
      const startTime = Date.now();

      try {
        await processJob(job);
        const elapsed = Date.now() - startTime;
        console.log(`✅ Job ${job.id} completed in ${elapsed}ms`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`❌ Job ${job.id} failed: ${errorMessage}`);
        await queue.requestForRetry(job, errorMessage);
      }

    } catch (error) {
      console.error('❌ Worker error:', error);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

startWorker();