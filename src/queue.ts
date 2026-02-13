import Redis from "ioredis";

// =================================================================
// JOB — now tracks attempts and errors
// =================================================================

export interface Job {
    id: string;
    type: string; // 'notification'
    channel: string; // 'email', 'sms', 'push'
    userId: number;
    payload: Record<string, any>; // e.g. { subject, body } for email
    createdAt: string;
    attempt: number;
    maxAttempts: number;
    lastError?: string;
    failedAt?: string;
}

// =================================================================
// QUEUE — now with retry support and Dead Letter Queue
// =================================================================

export class Queue {
    private redis: Redis;
    private queueName: string;
    private dlqName: string;

    constructor(redisUrl: string, queueName: string ='notifications') {
        this.redis = new Redis(redisUrl);
        this.queueName = queueName;
        this.dlqName = `${queueName}:dlq`; // Dead Letter Queue is just another list
    }

    /**
     * Add a job to the queue.
     * 
     * This is what the API calls — it's instant (~1ms).
     * The job sits in Redis until a worker picks it up.
     * 
     * Redis command: LPUSH notifications '{"id":"abc","channel":"email",...}'
     */
    async enqueue(job: Job): Promise<void> {
        const serialized = JSON.stringify(job);
        await this.redis.lpush(this.queueName, serialized);
        console.log(`Enqueued job ${job.id} (${job.channel}) attempt ${job.attempt}/${job.maxAttempts}`);
    }

    /**
     * Take the next job from the queue.
     * 
     * BRPOP blocks for up to `timeoutSec` seconds waiting for a job.
     * If a job arrives, it returns immediately.
     * If timeout expires with no job, it returns null.
     * 
     * This is what the worker calls in a loop.
     * 
     * Redis command: BRPOP notifications 5
     */
    async dequeue(timeoutSec: number = 5): Promise<Job | null> {
        // BRPOP returns [queueName, value] or null on timeout
        const result = await this.redis.brpop(this.queueName, timeoutSec);
        if (!result) {
            return null; // Queue was empty for `timeoutSec` seconds
        }
        const [_, serialized] = result;
        return JSON.parse(serialized) as Job;
    }

    /**
     * Check how many jobs are waiting in the queue.
     * 
     * Redis command: LLEN notifications
     */
    async size(): Promise<number> {
        return this.redis.llen(this.queueName);
    }

    /**
     * Peek at jobs without removing them (for debugging).
     * 
     * Redis command: LRANGE notifications 0 9
     */
    async peek(count: number = 10): Promise<Job[]> {
        const items = await this.redis.lrange(this.queueName, 0, count - 1);
        return items.map(item => JSON.parse(item) as Job);
    }

    async disconnect(): Promise<void> {
        await this.redis.quit();
    }


    // ── Retry Logic ─────────────────────────────────────────────
    //
    // EXPONENTIAL BACKOFF:
    //   Attempt 1 fails → wait 10 seconds → retry
    //   Attempt 2 fails → wait 60 seconds → retry
    //   Attempt 3 fails → wait 300 seconds → retry → DLQ
    //
    // We implement this with a "delayed" approach:
    //   Instead of actually waiting, we push the job back to the
    //   queue with metadata about WHEN it should be processed.
    //   The worker checks this and skips jobs that aren't ready.
    //
    // In production, you'd use Redis sorted sets (ZADD with score = timestamp)
    // for proper delayed queues. We keep it simple here for learning.

    private backOffDelays = [10_000, 60_000, 300_000]; // 10s, 1m, 5m

    getBackOffDelay(attempt: number): number {
        const index = Math.min(attempt - 1, this.backOffDelays.length - 1);
        const baseDelay = this.backOffDelays[index];

        // Add jitter: ±20% randomness to prevent thundering herd
        const jitter = baseDelay * 0.2;
        return baseDelay + Math.floor(Math.random() * jitter * 2 - jitter);
    }

    /**
     * Re-queue a failed job for retry.
     * Increments attempt count and records the error.
     */

    async requestForRetry(job: Job, error: string): Promise<void> {
        job.attempt += 1;
        job.lastError = error;

        if(job.attempt > job.maxAttempts) {
            await this.moveToDLQ(job);
            return;
        }

        const delay = this.getBackOffDelay(job.attempt);
        console.log(
            `Retry ${job.attempt}/${job.maxAttempts} for job ${job.id} ` +
            `in ${(delay / 1000).toFixed(0)}s (error: ${error})`
        );

        // Simple approach: wait, then re-enqueue
        // In production, use Redis sorted sets for proper scheduling
        setTimeout(async () => {
            await this.enqueue(job);
        }, delay);
    }

    // ── Dead Letter Queue ───────────────────────────────────────
    //
    // Jobs that fail ALL retries end up here.
    // They're NOT deleted — they're preserved for:
    //   1. Debugging: WHY did it fail?
    //   2. Retry: fix the issue, then retry from DLQ
    //   3. Monitoring: spike in DLQ = something is wrong

    async moveToDLQ(job: Job): Promise<void> {
        job.failedAt = new Date().toISOString();
        const serialized = JSON.stringify(job);
        await this.redis.lpush(this.dlqName, serialized);
        console.error(`Job ${job.id} moved to DLQ after ${job.attempt} attempts. Last error: ${job.lastError}`);
    }


    /** List all dead letter jobs */
    async getDLQ(): Promise<Job[]> {
        const items = await this.redis.lrange(this.dlqName, 0, -1);
        return items.map(item => JSON.parse(item));
    }

    /** How many jobs are in the DLQ */
    async dlqSize(): Promise<number> {
        return this.redis.llen(this.dlqName);
    }

    /**
     * Retry a specific dead letter job.
     * Removes it from DLQ, resets attempts, puts it back in main queue.
     */

    async retryFromDLQ(jobId: string): Promise<boolean> {
        const dlqJobs = await this.getDLQ();
        const job = dlqJobs.find(j => j.id === jobId);
        if(!job) {
            console.error(`No job with ID ${jobId} found in DLQ`);
            return false;
        }

        // Remove from DLQ
        await this.redis.lrem(this.dlqName, 1, JSON.stringify(job));

        // Reset and re-enqueue
        job.attempt = 0;
        job.lastError = undefined;
        job.failedAt = undefined;
        await this.enqueue(job);

        console.log(`DLQ job ${job.id} moved back to main queue`);

        return true;
    }

    /** Retry ALL dead letter jobs */
    async retryAllDLQ(): Promise<number> {
        const dlqJobs = await this.getDLQ();
        let retried = 0;

        for(const job of dlqJobs) {
            await this.redis.lrem(this.dlqName, this.queueName, JSON.stringify(job));
            job.attempt = 0;
            job.lastError = undefined;
            job.failedAt = undefined;
            await this.enqueue(job);
            retried++;
        }

        console.log(`Retried ${retried} jobs from DLQ`);
        return retried;
    }

}