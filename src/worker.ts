import { Queue, Job } from "./queue";
import { sendEmail, sendSMS, sendPush } from "./channels";

// =================================================================
// WORKER — Pulls jobs from the queue and processes them
// =================================================================
//
// This runs as a SEPARATE PROCESS from the API server.
// 
// It does one thing in a loop:
//   1. BRPOP — wait for a job from Redis (blocks if empty)
//   2. Process the job (send email/SMS/push)
//   3. Go back to step 1
//
// The API server and worker NEVER talk directly.
// They communicate ONLY through Redis:
//   API → LPUSH job into Redis
//   Worker → BRPOP job out of Redis
//
// This is the DECOUPLING that makes queues powerful:
//   - API can be on server A, worker on server B
//   - You can run 1 worker or 20 workers (just start more)
//   - If the worker crashes, jobs stay safe in Redis
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
    console.log('='.repeat(50));
    console.log('');

    // The infinite loop — this is how ALL queue workers work
    while (true) {
        try {
            // BRPOP — blocks until a job arrives (up to 5 second timeout)
            // If no job after 5 seconds, returns null, loop continues
            const job = await queue.dequeue(5);

            if(job){
                await processJob(job);
            }
             // If null, just loop again — BRPOP will wait for the next job
        } catch (err) {
            console.error('❌ Worker error:', err);
            // Don't crash — wait a bit and try again
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

startWorker();