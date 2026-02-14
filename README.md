# Real-Time Notification Engine

A notification system built from scratch in Node.js/TypeScript to demonstrate core distributed systems concepts. Every component — queues, retry logic, dead letter queues, pub/sub, caching, and real-time delivery — is implemented from first principles with no abstraction libraries.

Built as a learning project and technical showcase for system design interviews.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Client / Dashboard (React)                                         │
│  http://localhost:5174                                              │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────┐   │
│  │ Send     │  │ Feed     │  │ DLQ      │  │ Polling Comparison │   │
│  │ Form     │  │ Panel    │  │ Manager  │  │ Short│Long│SSE│WS  │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬───────────┘   │
└───────┼──────────────┼─────────────┼─────────────────┼─────────────-┘
        │              │             │                 │
        ▼              ▼             ▼                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Express API Server (http://localhost:4000)                         │
│                                                                     │
│  POST /notify ──────────┐                                           │
│  POST /notify/multi     │   GET /feed/:userId                       │
│                         │   GET /unread/:userId                     │
│                         │   GET /analytics                          │
│                         │   GET /dlq                                │
│                         │   GET /polling/short|long|stream          │
│                         │                                           │
│                         ▼                                           │
│              ┌──────────────────┐                                   │
│              │  Redis Queue     │◄── LPUSH (add job)                │
│              │  (List)          │                                   │
│              └────────┬─────────┘                                   │
└───────────────────────┼────────────────────────────────────────────-┘
                        │
                        │ BRPOP (take job)
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Worker Process (separate container)                                │
│                                                                     │
│  while(true):                                                       │
│    job = queue.dequeue()          ◄── Point-to-Point                │
│    │                                  ONE worker gets each job      │
│    ├── sendEmail/SMS/Push()                                         │
│    │   ├── ✅ Success                                               │
│    │   └── ❌ Failure                                               │
│    │       ├── Retry 1: wait 10s                                    │
│    │       ├── Retry 2: wait 60s                                    │
│    │       ├── Retry 3: wait 300s                                   │
│    │       └── DLQ (Dead Letter Queue)                              │
│    │                                                                │
│    └── eventBus.publish()         ◄── Pub/Sub                       │
│        "notification:delivered"       ALL subscribers get event     │
│            │                                                        │
│            ├── Subscriber 1: Update feed (Sorted Set)               │
│            ├── Subscriber 2: Increment unread (Hash)                │
│            └── Subscriber 3: Log analytics (Hash)                   │
└─────────────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Redis (port 6379)                                                  │
│                                                                     │
│  LIST        notifications          Job queue (LPUSH/BRPOP)         │
│  LIST        notifications:dlq      Dead letter queue               │
│  SORTED SET  feed:user:{id}         Notification feed (by time)     │
│  HASH        unread_counts           Per-user unread counts         │
│  HASH        analytics:{date}        Daily metrics by channel       │
│  STRING      cache:user_prefs:{id}   Cached preferences (TTL)       │
│  LIST        longpoll:user:{id}      Long-polling buffer            │
└─────────────────────────────────────────────────────────────────────┘
```

## Concepts Covered

| Concept | What It Does | Where in Code | Interview Relevance |
|---------|-------------|---------------|-------------------|
| **Message Queue** | Decouples API from slow work | `src/queue.ts` | Every system design question |
| **Dead Letter Queue** | Captures permanently failed jobs | `src/queue.ts` | Fault tolerance, reliability |
| **Exponential Backoff** | 10s → 60s → 300s retry delays | `src/queue.ts` | Retry strategies, thundering herd |
| **Pub/Sub** | One event triggers multiple reactions | `src/pubsub.ts` | Event-driven architecture |
| **Point-to-Point** | One job → one worker | `src/worker.ts` | Queue vs topic distinction |
| **Redis Sorted Set** | Time-ordered notification feed | `src/store.ts` | Feed design, real-time ranking |
| **Redis Hash** | Atomic unread counters | `src/store.ts` | Counters at scale |
| **Cache-Aside** | Check cache → miss → DB → cache | `src/store.ts` | Caching patterns |
| **Short Polling** | Client asks every N seconds | `src/polling.ts` | Real-time delivery trade-offs |
| **Long Polling** | Server holds until data arrives | `src/polling.ts` | How Messenger worked |
| **Server-Sent Events** | Server pushes over persistent connection | `src/polling.ts` | How ChatGPT streams |
| **WebSocket** | Full duplex communication | `src/polling.ts` | Chat, gaming, collaboration |

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **API:** Express
- **Queue/Cache/Pub-Sub:** Redis 7 (ioredis client)
- **Frontend:** React 18 (CDN, no build step)
- **Infrastructure:** Docker Compose

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/notification-engine.git
cd notification-engine

# Start all services (API + Worker + Redis + Dashboard)
docker compose up --build

# API:       http://localhost:4000
# Dashboard: http://localhost:5174
```

## Project Structure

```
notification-engine/
├── src/
│   ├── index.ts          API server (all endpoints)
│   ├── queue.ts          Queue + DLQ (Redis LPUSH/BRPOP)
│   ├── worker.ts         Background job processor
│   ├── channels.ts       Email/SMS/Push simulators (30% failure rate)
│   ├── store.ts          Redis data structures (feed, counters, cache)
│   ├── pubsub.ts         Event bus (Redis PUBLISH/SUBSCRIBE)
│   ├── polling.ts        4 polling strategies
│   └── subscribers.ts    3 independent event subscribers
├── frontend/
│   └── public/
│       └── index.html    React dashboard (single file)
├── docker-compose.yml    App + Worker + Redis + Dashboard
├── Dockerfile
├── package.json
└── tsconfig.json
```

## API Reference

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/notify` | Queue a notification (returns 202) |
| `POST` | `/notify/multi` | Queue to multiple channels |
| `POST` | `/notify/sync` | Send synchronously (Layer 1 comparison) |

### Feed & Unread

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/feed/:userId` | Notification feed (Redis Sorted Set) |
| `GET` | `/unread/:userId` | Unread count (Redis Hash) |
| `POST` | `/unread/:userId/read` | Mark all as read |
| `GET` | `/unread` | All users' unread counts |

### Polling Strategies

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/polling/short?userId=1` | Short polling (returns immediately) |
| `GET` | `/polling/long?userId=1&timeout=30` | Long polling (holds connection) |
| `GET` | `/polling/stream?userId=1` | SSE (persistent stream) |
| `GET` | `/polling/websocket` | WebSocket info |
| `GET` | `/polling/compare` | Side-by-side comparison |

### Dead Letter Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/dlq` | List dead letter jobs |
| `POST` | `/dlq/:jobId/retry` | Retry one dead letter |
| `POST` | `/dlq/retry-all` | Retry all dead letters |

### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/analytics` | Today's send metrics by channel |
| `GET` | `/prefs/:userId` | User preferences (cached) |
| `PUT` | `/prefs/:userId` | Update preferences (invalidates cache) |
| `GET` | `/queue/stats` | Queue + DLQ sizes |
| `GET` | `/health` | System info |

## How It Was Built (6 Layers)

Each layer adds one concept on top of the previous:

### Layer 1: Synchronous API — "The Problem"
The API sends notifications synchronously. Each request blocks for 2-3 seconds while waiting for the external service. At 10 concurrent requests, the server chokes.

### Layer 2: Queue + Workers — "The Fix"
API pushes jobs to a Redis list (`LPUSH`) and responds in 5ms. A separate worker process pulls jobs (`BRPOP`) and sends notifications in the background. This is how every queue system works internally.

### Layer 3: Retry + Dead Letter Queue — "Handle Failures"
Channels randomly fail at 30% rate. Failed jobs retry with exponential backoff (10s → 60s → 300s) with jitter. After 3 failures, jobs move to the DLQ where they can be inspected and retried via API.

### Layer 4: Redis Deep Dive — "Beyond Just a Queue"
Added three more Redis data structures: Sorted Sets for the notification feed, Hashes for unread counters, and Strings with TTL for caching. Implemented cache-aside pattern with invalidation.

### Layer 5: Pub/Sub vs Point-to-Point — "Event Architecture"
Worker publishes events after successful delivery. Three independent subscribers react: feed updater, unread counter, analytics logger. Adding a new subscriber requires zero changes to existing code.

### Layer 6: Polling Strategies — "Real-Time Delivery"
Implemented all four strategies for delivering data to the browser. The dashboard shows them running side-by-side so you can compare request counts, latency, and efficiency.

## Scaling Considerations

```
10K users:   Single server, Redis on same box (~240 MB)
30K users:   ECS + ASG, Redis on ElastiCache, scale API and workers independently
100K users:  Redis Streams for consumer groups, RDS read replicas
500K+ users: Kafka for guaranteed delivery, Redis Cluster, Aurora
```

**Scaling rules for ECS/ASG:**
- API containers: scale on CPU > 70%
- Worker containers: scale on queue depth > 100
- API and workers scale independently — this is the core benefit of queue architecture

## Testing

```bash
# Send a notification
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

# Check DLQ
curl http://localhost:4000/dlq | python3 -m json.tool

# Test SSE (Terminal 1: start stream)
curl -N "http://localhost:4000/polling/stream?userId=1"

# (Terminal 2: send notification and watch it appear in Terminal 1)
curl -s -X POST http://localhost:4000/notify \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"channel":"push","title":"SSE test!"}'

# Compare sync vs async
time curl -X POST http://localhost:4000/notify/sync \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"channel":"email","subject":"Slow","body":"test"}'
# ~2-3 seconds

time curl -X POST http://localhost:4000/notify \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"channel":"email","subject":"Fast","body":"test"}'
# ~5ms
```

## Related Projects

This is Project 1 of a 3-project distributed systems portfolio:

1. **Notification Engine** (this project) — Queues, DLQ, Redis, Pub/Sub, Polling
2. **API Gateway from Scratch** — Rate Limiting (5 algorithms), Load Balancing (5 algorithms), Consistent Hashing, Circuit Breaker
3. **Distributed Task Scheduler** — Consistency, Leader Election, Sharding

## License

MIT