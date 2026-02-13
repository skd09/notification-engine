import { Queue, Job } from "./queue";
import { NotificationStore } from "./store";
import { sendEmail, sendSMS, sendPush } from "./channels";

// =================================================================
// WORKER — Now updates Redis feed + unread count after success
// =================================================================

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(REDIS_URL);
const store = new NotificationStore(REDIS_URL);

async function processJob(job: Job): Promise<void> {
    // 1. Send the notification 
    switch (job.channel) {
        case 'email':
            await sendEmail(job.userId, job.payload.subject, job.payload.body);
            break;
        case 'sms':
            await sendSMS(job.userId.toString(), job.payload.message);
            break;
        case 'push':
            await sendPush(job.userId.toString(), job.payload.title, job.payload.message);
            break;
        default:
            console.error(`Unknown channel ${job.channel} for job ${job.id}`);
    }

     // 2. NEW: Store in notification feed (Sorted Set)
    await store.addToFeed(job.userId, {
        id: job.id,
        channel: job.channel,
        type: job.payload.type,
        title: job.payload.subject || job.payload.title || job.payload.message || '',
        body: job.payload.body,
    });

    // 3. NEW: Increment unread count (Hash)
    const newCount = await store.incrementUnread
    console.log(`Feed updated, unread count: ${newCount}`);
}

async function startWorker(): Promise<void> {
    console.log('');
    console.log('='.repeat(50));
    console.log('Worker started');
    console.log('Sends notifications');
    console.log('Updates feed (Redis Sorted Set)');
    console.log('Updates unread count (Redis Hash)');
    console.log('Retries failed jobs (exponential backoff)');
    console.log('Moves permanently failed jobs to DLQ');
    console.log('='.repeat(50));
    console.log('');

    // The infinite loop — this is how ALL queue workers work
    while (true) {
        try {
            // BRPOP — blocks until a job arrives (up to 5 second timeout)
            // If no job after 5 seconds, returns null, loop continues
            const job = await queue.dequeue(5);
            if(!job) continue;

            console.log(`\nProcessing job ${job.id} (${job.channel}) attempt ${job.attempt}/${job.maxAttempts}`);
            const startTime = Date.now();

            try {
                await processJob(job);
                const elapsed = Date.now() - startTime;
                console.log(`✅ Job ${job.id} completed successfully in ${elapsed}ms`);
            } catch (err) {
                // JOB FAILED — don't crash, handle it gracefully
                const errorMessage = err instanceof Error ? err.message: 'Unknown error';
                console.error(`❌ Job ${job.id} failed:`, errorMessage);

                // This will either retry or move to DLQ
                await queue.requestForRetry(job, errorMessage);
            }
        } catch (err) {
            console.error('❌ Worker error:', err);
            // Don't crash — wait a bit and try again
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

startWorker();