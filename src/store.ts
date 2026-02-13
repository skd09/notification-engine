import Redis from "ioredis";
import { read } from "node:fs";
import { parse } from "node:path";

// =================================================================
// NOTIFICATION STORE — Redis Data Structures in Action
// =================================================================
//
// This file demonstrates 3 Redis data structures beyond Lists:
//
//   SORTED SET → notification feed (ordered by time)
//   HASH unread counters (per-user counts)
//   STRING → cache (key-value with TTL expiry)
//
// Each one is chosen because it's the BEST fit for the problem.
// Using the wrong structure works but performs poorly at scale.
// =================================================================

export class NotificationStore {
    private redis: Redis;

    constructor(redisUrl: string) {
        this.redis = new Redis(redisUrl);
    }

    // =============================================================
    // SORTED SET — Notification Feed
    // =============================================================
    //
    // WHY SORTED SET?
    //   We need notifications ordered by time, with fast:
    //     - Insert: O(log N)
    //     - "Get latest 20": O(log N + 20)
    //     - Auto-trim old ones
    //
    // HOW IT WORKS:
    //   Each entry has a SCORE (we use timestamp) and a VALUE.
    //   Redis keeps them sorted by score automatically.
    //
    //   ZADD feed:user:1 1707000000 '{"id":"abc","title":"New msg"}'
    //   ZADD feed:user:1 1707000001 '{"id":"def","title":"Order shipped"}'
    //
    //   ZREVRANGE feed:user:1 0 19  → latest 20, newest first
    //
    // WHY NOT A REGULAR LIST?
    //   Lists don't sort. If notifications arrive out of order
    //   (which happens with retries), the feed would be wrong.
    //   Sorted sets keep everything ordered by timestamp.
    //
    // REAL-WORLD: Instagram notifications, Twitter activity feed
    // =============================================================


    async addToFeed(userId: number, notification: {
        id: string;
        channel: string;
        type: string;
        title: string;
        body?: string;
    }): Promise<void> {
        const key = `feed:user:${userId}`;
        const score = Date.now(); // Timestamp as score
        const value = JSON.stringify({
            ...notification,
            createdAt: new Date().toISOString(),
            read: false,
        });

        // ZADD — add to sorted set with timestamp score
        await this.redis.zadd(key, score, value);

        // Keep only latest 100 notifications (trim oldest)
        // ZREMRANGEBYRANK 0 to -101 removes everything except the top 100
        await this.redis.zremrangebyrank(key, 0, -101);

        // Auto-expire after 30 days of inactivity
        await this.redis.expire(key, 86400 * 30);
    }

    /**
     * Get the latest notifications for a user.
     *
     * ZREVRANGE returns highest scores first (newest timestamps).
     * This is O(log N + count) — very fast even with millions of entries.
     */
    async getFeed(userId: number, count: number = 20): Promise<any[]> {
        const key = `feed:user:${userId}`;

        // ZREVRANGE — reverse range (highest score first = newest first)
        const items = await this.redis.zrevrange(key, 0, count - 1);
        
        // Parse JSON values back into objects
        return items.map(item => JSON.parse(item));
    }

    /** How many notifications does a user have in their feed? */
    async getFeedSize(userId: number): Promise<number> {
        const key = `feed:user:${userId}`;
        return this.redis.zcard(key); // ZCARD = count of items in sorted set
    }

    // =============================================================
    // HASH — Unread Counters
    // =============================================================
    //
    // WHY HASH?
    //   We need per-user unread counts. Options:
    //
    //   Separate keys: SET unread:user:1 "5", SET unread:user:2 "3"
    //     → Works but wasteful. Each key has overhead (~50 bytes).
    //     → 1M users = 50MB just for key overhead.
    //
    //   Single hash:  HSET unread_counts user:1 5
    //                 HSET unread_counts user:2 3
    //     → ONE key stores ALL users. Very memory efficient.
    //     → HGETALL gives ALL counts in one command.
    //
    // HINCRBY is ATOMIC — safe even with concurrent requests.
    //   Two workers both doing HINCRBY user:1 1 at the same time
    //   will correctly result in +2, not +1.
    //
    // REAL-WORLD: Instagram unread badge, Slack unread counts
    // =============================================================


    async incrementUnread(userId: number): Promise<number> {
        // HINCRBY — atomic increment, returns new value
        return this.redis.hincrby('unread_counts', `user:${userId}`, 1);
    }

    async getUnreadCount(userId: number): Promise<number> {
        const count = await this.redis.hget('unread_counts', `user:${userId}`);
        return parseInt(count || '0', 10); 
    }

    async markAllRead(userId: number): Promise<void> {
        await this.redis.hset('unread_counts', `user:${userId}`, 0);
    }


  /** Get unread counts for ALL users (for admin dashboard) */
    async getAllUnreadCounts(): Promise<Record<string, number>> {
        const all = await this.redis.hgetall('unread_counts');
        const result: Record<string, number> = {};
        for(const [key, value] of Object.entries(all)) {
            result[key] = parseInt(value, 10);
        }
        return result;
    }

    // =============================================================
    // STRING with TTL — Cache
    // =============================================================
    //
    // CACHE-ASIDE PATTERN (most common caching pattern):
    //
    //   1. Check cache: GET user_prefs:1
    //   2. Cache HIT  → return cached data
    //   3. Cache MISS → get from source, then SET with TTL
    //   4. On update  → DELETE cache key (invalidate)
    //
    //   ┌─────────┐     ┌───────┐     ┌──────────┐
    //   │ Request │────▶│ Cache │────▶│ Response │  (cache HIT)
    //   └─────────┘     └───┬───┘     └──────────┘
    //                    MISS│
    //                       ▼
    //                   ┌────────┐
    //                   │ Source │ → store in cache → Response
    //                   └────────┘
    //
    // WHY TTL?
    //   Without expiry, cached data gets stale forever.
    //   TTL (Time To Live) auto-deletes after N seconds.
    //   SET user_prefs:1 '{"email":true}' EX 3600  ← expires in 1 hour
    //
    // REAL-WORLD: User profiles, product details, API responses
    // =============================================================

    async cacheGet(key: string): Promise<any | null> {
        const value = await this.redis.get(key);
        if(value) {
            console.log(`Cache HIT for key ${key}`);
            return JSON.parse(value);
        }

        console.log(`Cache MISS for key ${key}`);
        return null;
    }

    async cacheSet(key: string, value: any, ttlSeconds: number = 3600): Promise<void> {
        await this.redis.set(`cache:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
        console.log(`Cache SET for key ${key} with TTL ${ttlSeconds}s`);
    }

    async cacheDelete(key: string): Promise<void> {
        await this.redis.del(`cache:${key}`);
        console.log(`📦 Cache invalidated: ${key}`);
    }

    /**
     * Cache-aside helper: get from cache, or compute and cache.
     *
     * Usage:
     *   const prefs = await store.cacheThrough('user_prefs:1', 3600, async () => {
     *     return await fetchFromDatabase(userId);
     *   });
     */

    async cacheThrough<T>(key: string, ttlSeconds: number, computeFn: () => Promise<T>): Promise<T> {
        // 1. Check cache
        const cached = await this.cacheGet(key);
        if (cached) return cached as T;

        // 2. Cache miss — compute the value
        const value = await computeFn();

        // 3. Store in cache for next time
        await this.cacheSet(key, value, ttlSeconds);

        return value;
    }

    async disconnect(): Promise<void> {
        await this.redis.quit();
    }
}