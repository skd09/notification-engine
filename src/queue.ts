import Redis from "ioredis";

// =================================================================
// QUEUE — Built from scratch using Redis Lists
// =================================================================
//
// This is what every queue system does internally:
//   enqueue() → LPUSH (add to left end of list)
//   dequeue() → RPOP  (take from right end of list)
//
// This gives us FIFO ordering:
//   LPUSH → [job3, job2, job1] → RPOP
//            newest    oldest
//
// BRPOP vs RPOP:
//   RPOP  → returns null immediately if queue is empty
//   BRPOP → BLOCKS and waits until something appears (or timeout)
//
//   We use BRPOP in the worker so it doesn't spin the CPU
//   checking an empty queue thousands of times per second.
// =================================================================

export interface Job {
    id: string;
    type: string; // 'notification'
    channel: string; // 'email', 'sms', 'push'
    userId: number;
    payload: Record<string, any>; // e.g. { subject, body } for email
    createdAt: string;
}

export class Queue {
    private redis: Redis;
    private queueName: string;

    constructor(redisUrl: string, queueName: string ='notifications') {
        this.redis = new Redis(redisUrl);
        this.queueName = queueName;
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
        console.log(`Enqueued job ${job.id} for user ${job.userId} on channel ${job.channel}`);
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
}