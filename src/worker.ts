import { Queue, Job } from "./queue";
import { sendEmail, sendSMS, sendPush } from "./channels";

// =================================================================
// WORKER — Now with retry and DLQ support
//
// When a job fails:
//   1. Catch the error
//   2. Call queue.requeueForRetry() — this either:
//      a. Puts it back in the queue with exponential backoff, OR
//      b. Moves it to the DLQ if max attempts reached
//   3. Continue processing next job
//
// The worker NEVER crashes on a failed job. It handles the error
// gracefully and moves on.
// =================================================================

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(REDIS_URL);

async function processJob(job: Job): Promise<void> {
    console.log(`Processing job ${job.id} for user ${job.userId} on channel ${job.channel}`);
    const startTime = Date.now();

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
    const elapsed = Date.now() - startTime;
    console.log(`Finished job ${job.id} in ${elapsed}ms`);
}

async function startWorker(): Promise<void> {
    console.log('');
    console.log('='.repeat(50));
    console.log('Worker started - waiting for jobs...');
    console.log('  Retry policy: 3 attempts with exponential backoff');
    console.log('  Failed jobs go to Dead Letter Queue');
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