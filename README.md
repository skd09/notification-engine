# 🔔 Real-Time Notification Engine

**Distributed notification system built from scratch in Node.js/TypeScript — queues, retry logic, dead letter queues, pub/sub, Redis data structures, and 4 real-time polling strategies. Every component implemented from first principles.**

<p align="center">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs" alt="Node.js"></a>
  <a href="https://redis.io/"><img src="https://img.shields.io/badge/Redis-7-DC382D?logo=redis" alt="Redis"></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker" alt="Docker"></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-18-61DAFB?logo=react" alt="React"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
</p>

---

## What Is This?

A learning-focused notification engine that demonstrates core distributed systems concepts used in production at companies like Netflix, Discord, and Stripe. Built layer by layer — from a slow synchronous API to a fully async, event-driven system with real-time delivery.

Designed as a technical showcase for system design interviews.

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│     Client      │────▶│   Express API   │────▶│        Redis Queue          │
│  Dashboard /    │ 202 │   (5ms response) │     │  LPUSH (add job)            │
│  curl / app     │◀────│   POST /notify  │     └────────────┬────────────────┘
└─────────────────┘     └─────────────────┘                  │
                                                              │ BRPOP (take job)
                                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Worker Process (separate container)                                        │
│                                                                             │
│  Queue Job (Point-to-Point)          Event (Pub/Sub)                       │
│  ┌─────────────────────────┐         ┌─────────────────────────────────┐   │
│  │ sendEmail/SMS/Push()    │         │ PUBLISH "notification:delivered"│   │
│  │                         │────────▶│                                 │   │
│  │ ✅ Success              │         │ Subscriber 1 → Update feed     │   │
│  │ ❌ Fail → Retry 3x     │         │ Subscriber 2 → Increment count │   │
│  │ 💀 Fail → DLQ           │         │ Subscriber 3 → Log analytics   │   │
│  └─────────────────────────┘         └─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Redis (6 data structures in use)                                           │
│                                                                             │
│  LIST         notifications            Job queue (LPUSH/BRPOP)             │
│  LIST         notifications:dlq        Dead letter queue                   │
│  SORTED SET   feed:user:{id}           Notification feed (ordered by time) │
│  HASH         unread_counts            Per-user unread counts (atomic)     │
│  HASH         analytics:{date}         Daily metrics by channel            │
│  STRING+TTL   cache:user_prefs:{id}    Cached preferences (1hr expiry)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Features

- **Queue from scratch** — Redis LPUSH/BRPOP, no Bull/BullMQ, no abstraction libraries
- **Dead Letter Queue** — failed jobs preserved with full error context, retry via API
- **Exponential backoff** — 10s → 60s → 300s with jitter to prevent thundering herd
- **Pub/Sub event architecture** — 3 independent subscribers react to one event
- **4 Redis data structures** — List, Sorted Set, Hash, String+TTL (each chosen for a reason)
- **Cache-aside pattern** — check cache → miss → DB → store in cache → invalidate on write
- **4 polling strategies** — Short, Long, SSE, WebSocket (side-by-side comparison in dashboard)
- **React dashboard** — live visualization of all concepts running together
- **30% simulated failure rate** — watch retries and DLQ in action

---

## Concepts Covered

| Concept | Implementation | File | Interview Relevance |
|---------|---------------|------|-------------------|
| Message Queue | Redis LPUSH/BRPOP | `src/queue.ts` | Every system design question |
| Dead Letter Queue | Separate Redis List + retry API | `src/queue.ts` | Fault tolerance, reliability |
| Exponential Backoff + Jitter | Configurable delays with ±20% randomness | `src/queue.ts` | Retry strategies |
| Pub/Sub | Redis PUBLISH/SUBSCRIBE | `src/pubsub.ts` | Event-driven microservices |
| Point-to-Point | One job → one worker via BRPOP | `src/worker.ts` | Queue vs topic distinction |
| Sorted Set | Time-ordered notification feed | `src/store.ts` | Feed design, ranking |
| Hash | Atomic unread counters (HINCRBY) | `src/store.ts` | Counters at scale |
| Cache-Aside | GET → miss → compute → SET EX | `src/store.ts` | Caching patterns |
| Short Polling | Client polls every 3s | `src/polling.ts` | Simplest real-time approach |
| Long Polling | Server holds connection via BRPOP | `src/polling.ts` | How Facebook Messenger worked |
| Server-Sent Events | Persistent stream, server pushes | `src/polling.ts` | How ChatGPT streams tokens |
| WebSocket | Full duplex (architecture only) | `src/polling.ts` | Chat, gaming, collaboration |

---

## Prerequisites

| Tool | Version | Install (macOS) |
|------|---------|-----------------|
| [Docker](https://www.docker.com/) | >= 24 | `brew install --cask docker` |
| [Node.js](https://nodejs.org/) | >= 20 (optional, for local dev) | `brew install node` |

Docker is the only hard requirement. Everything runs in containers.

---

## Quick Start

### 1. Clone and Run

```bash
git clone https://github.com/YOUR_USERNAME/notification-engine.git
cd notification-engine
docker compose up --build
```

### 2. Access

| Service | URL |
|---------|-----|
| API Server | http://localhost:4000 |
| Dashboard | http://localhost:5174 |
| Redis | localhost:6379 |

### 3. Test

```bash
# Send a notification (returns in ~5ms)
curl -X POST http://localhost:4000/notify \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"channel":"email","subject":"Hello!","body":"Welcome"}'

# Burst 10 notifications
for i in $(seq 1 10); do
  curl -s -X POST http://localhost:4000/notify \
    -H "Content-Type: application/json" \
    -d '{"userId":1,"channel":"email","subject":"Test '$i'","body":"msg"}' &
done; wait

# Check feed
curl http://localhost:4000/feed/1 | python3 -m json.tool

# Check dead letter queue
curl http://localhost:4000/dlq | python3 -m json.tool
```

### 4. Test SSE (Real-Time Streaming)

```bash
# Terminal 1 — open stream
curl -N "http://localhost:4000/polling/stream?userId=1"

# Terminal 2 — send notification (watch it appear in Terminal 1)
curl -s -X POST http://localhost:4000/notify \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"channel":"push","title":"SSE test!"}'
```

---

## Project Structure

```
notification-engine/
├── src/                            # Backend (TypeScript)
│   ├── index.ts                   # Express API (all endpoints)
│   ├── queue.ts                   # Queue + DLQ (Redis LPUSH/BRPOP)
│   ├── worker.ts                  # Background job processor
│   ├── channels.ts                # Email/SMS/Push simulators (30% failure rate)
│   ├── store.ts                   # Redis data structures (feed, counters, cache)
│   ├── pubsub.ts                  # Event bus (Redis PUBLISH/SUBSCRIBE)
│   ├── polling.ts                 # 4 polling strategies
│   └── subscribers.ts             # 3 independent event subscribers
│
├── frontend/                       # Dashboard (React)
│   └── public/
│       └── index.html             # Single-file React app (CDN, no build step)
│
├── docker-compose.yml             # App + Worker + Redis + Dashboard
├── Dockerfile                     # Node.js 20 Alpine
├── package.json
├── tsconfig.json
└── README.md
```

---

## How It Works

### Request Flow

1. **Client sends** `POST /notify` with userId, channel, and message
2. **API** creates a job, pushes to Redis queue (`LPUSH`), returns `202 Accepted` in ~5ms
3. **Worker** pulls job (`BRPOP`), sends via email/SMS/push
4. **On success** — worker publishes `notification:delivered` event via Redis Pub/Sub
5. **Subscribers react** independently:
   - Subscriber 1 updates the notification feed (Sorted Set)
   - Subscriber 2 increments unread count (Hash)
   - Subscriber 3 logs analytics (Hash)
6. **On failure** — worker retries with exponential backoff (10s → 60s → 300s)
7. **After 3 failures** — job moves to Dead Letter Queue for manual inspection

### Failure Handling

```
Job fails
  │
  ├── Attempt 1 → wait 10s  (± jitter) → retry
  ├── Attempt 2 → wait 60s  (± jitter) → retry
  ├── Attempt 3 → wait 300s (± jitter) → retry
  │
  └── All retries exhausted
       └── Move to DLQ with full error context
           └── Admin: GET /dlq → inspect → POST /dlq/:id/retry
```

---

## API Reference

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/notify` | Queue a notification (returns 202) |
| `POST` | `/notify/multi` | Queue to multiple channels at once |
| `POST` | `/notify/sync` | Send synchronously (Layer 1 comparison) |

### Feed & Unread

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/feed/:userId` | Notification feed (Redis Sorted Set) |
| `GET` | `/unread/:userId` | Unread count (Redis Hash) |
| `POST` | `/unread/:userId/read` | Mark all as read |
| `GET` | `/unread` | All users' unread counts (HGETALL) |

### Polling Strategies

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/polling/short?userId=1` | Short polling (returns immediately) |
| `GET` | `/polling/long?userId=1&timeout=30` | Long polling (holds connection) |
| `GET` | `/polling/stream?userId=1` | SSE (persistent event stream) |
| `GET` | `/polling/websocket` | WebSocket info |
| `GET` | `/polling/compare` | Side-by-side strategy comparison |

### Dead Letter Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/dlq` | List all dead letter jobs |
| `POST` | `/dlq/:jobId/retry` | Retry a specific dead letter |
| `POST` | `/dlq/retry-all` | Retry all dead letters |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/analytics` | Today's send metrics by channel |
| `GET` | `/prefs/:userId` | User preferences (cache-aside) |
| `PUT` | `/prefs/:userId` | Update prefs + invalidate cache |
| `GET` | `/queue/stats` | Queue + DLQ sizes |
| `GET` | `/health` | System info + architecture overview |

---

## How It Was Built (6 Layers)

Each layer adds one concept on top of the previous. The codebase evolved incrementally, not all at once.

| Layer | Concept | What Changed |
|-------|---------|-------------|
| **1** | Synchronous API | Express endpoint that blocks 2-3s per request. "The problem." |
| **2** | Queue + Workers | API pushes to Redis, responds in 5ms. Worker sends in background. |
| **3** | Retry + DLQ | 30% failure rate. Exponential backoff. Dead letters preserved. |
| **4** | Redis Deep Dive | Sorted Set (feed), Hash (counters), String+TTL (cache-aside). |
| **5** | Pub/Sub | Worker publishes events. 3 subscribers react independently. |
| **6** | Polling Strategies | Short, Long, SSE, WebSocket. Dashboard shows them side-by-side. |

---

## Scaling Considerations

| Users | Infrastructure | Redis Memory | Monthly Cost |
|-------|---------------|-------------|-------------|
| 10K | Single server, Redis on same box | ~240 MB | ~$50 |
| 30K | ECS + ASG, ElastiCache (Redis) | ~720 MB | ~$200-300 |
| 100K | Redis Streams, RDS read replicas | ~2.5 GB | ~$500-800 |
| 500K+ | Kafka, Redis Cluster, Aurora | ~8 GB | $2000+ |

**ASG scaling rules:**
- API containers → scale on CPU > 70%
- Worker containers → scale on Redis queue depth > 100
- API and workers scale independently (core benefit of queue architecture)

---

## Dashboard

The React dashboard provides live visualization of all concepts:

- **System stats** — queue size, DLQ count, unread count, daily sends
- **Send form** — queue individual or burst notifications
- **Polling comparison** — 4 strategies running side-by-side with request counts
- **Notification feed** — real-time feed with mark-as-read
- **Analytics** — bar chart of sends by channel
- **DLQ manager** — inspect errors, retry individual or all dead letters

---

## Related Projects

This is **Project 1** of a 3-project distributed systems portfolio:

| # | Project | Concepts |
|---|---------|----------|
| **1** | **Notification Engine** (this repo) | Queues, DLQ, Redis, Pub/Sub, Polling |
| 2 | API Gateway from Scratch | Rate Limiting (5 algorithms), Load Balancing (5 algorithms), Consistent Hashing, Circuit Breaker |
| 3 | Distributed Task Scheduler | Consistency, Leader Election, Sharding |

---

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.