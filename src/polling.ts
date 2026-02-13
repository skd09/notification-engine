import { Request, Response } from 'express';
import { NotificationStore } from './store';
import Redis from 'ioredis';

// =================================================================
// 4 POLLING STRATEGIES — Same data, 4 different delivery methods
// =================================================================

export class PollingHandlers {
  private store: NotificationStore;
  private redis: Redis;

  // Track SSE clients for broadcasting
  private sseClients: Map<number, Response[]> = new Map();

  constructor(redisUrl: string, store: NotificationStore) {
    this.store = store;
    this.redis = new Redis(redisUrl);
    this.setupSSEBroadcaster(redisUrl);
  }

  // =============================================================
  // STRATEGY 1: SHORT POLLING
  // =============================================================
  //
  // HOW IT WORKS:
  //   Browser calls this every N seconds on a timer.
  //   Server checks for new data and responds immediately.
  //
  //   Browser: setInterval(() => fetch('/polling/short'), 3000)
  //
  // PROS: Dead simple, works everywhere, stateless
  // CONS: Wastes bandwidth (most responses are "no new data")
  //       Higher latency (up to N seconds delay)
  //
  // REQUEST COST:
  //   If polling every 3 seconds: 20 requests/minute per user
  //   1000 users = 20,000 requests/minute (mostly empty responses)
  //
  // USED BY: Simple dashboards, email refresh, basic AJAX apps
  // =============================================================

  async shortPoll(req: Request, res: Response): Promise<void> {
    const userId = parseInt(req.query.userId as string);
    const since = req.query.since as string; // ISO timestamp

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    // Get current state
    const unread = await this.store.getUnreadCount(userId);
    const feed = await this.store.getFeed(userId, 10);

    // Filter to only new notifications if 'since' provided
    let newNotifications = feed;
    if (since) {
      const sinceDate = new Date(since).getTime();
      newNotifications = feed.filter(n => new Date(n.createdAt).getTime() > sinceDate);
    }

    res.json({
      strategy: 'short-polling',
      userId,
      unreadCount: unread,
      newNotifications,
      hasNew: newNotifications.length > 0,
      timestamp: new Date().toISOString(), // Client sends this back as 'since' next time
      note: 'Client should call this every 3-5 seconds',
    });
  }

  // =============================================================
  // STRATEGY 2: LONG POLLING
  // =============================================================
  //
  // HOW IT WORKS:
  //   Browser sends request. Server HOLDS the connection open.
  //   Server waits until new data arrives OR timeout expires.
  //   When data arrives → respond immediately.
  //   When timeout → respond with "no data", client reconnects.
  //
  //   Browser:
  //     async function longPoll() {
  //       const res = await fetch('/polling/long?userId=1&timeout=30');
  //       const data = await res.json();
  //       // process data...
  //       longPoll(); // immediately reconnect
  //     }
  //
  // PROS: Near real-time, efficient (no wasted empty responses)
  // CONS: Holds server connections open, slightly complex
  //
  // HOW WE IMPLEMENT IT:
  //   We use Redis BRPOP on a per-user list. When a notification
  //   is delivered, the subscriber pushes to this list, and BRPOP
  //   unblocks immediately.
  //
  //   This is exactly how Facebook Messenger originally worked.
  //
  // USED BY: Facebook Messenger (originally), Slack (fallback)
  // =============================================================

  async longPoll(req: Request, res: Response): Promise<void> {
    const userId = parseInt(req.query.userId as string);
    const timeout = parseInt(req.query.timeout as string) || 30;

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const listKey = `longpoll:user:${userId}`;

    // BRPOP blocks until data arrives or timeout
    // When subscriber pushes a notification, this unblocks
    const result = await this.redis.brpop(listKey, timeout);

    if (result) {
      const [, data] = result;
      const notification = JSON.parse(data);
      const unread = await this.store.getUnreadCount(userId);

      res.json({
        strategy: 'long-polling',
        userId,
        hasNew: true,
        notification,
        unreadCount: unread,
        note: 'Client should immediately reconnect after receiving this',
      });
    } else {
      // Timeout — no new data
      res.json({
        strategy: 'long-polling',
        userId,
        hasNew: false,
        note: `No new data in ${timeout}s. Client should reconnect.`,
      });
    }
  }

  // =============================================================
  // STRATEGY 3: SERVER-SENT EVENTS (SSE)
  // =============================================================
  //
  // HOW IT WORKS:
  //   Browser opens ONE persistent connection.
  //   Server pushes data whenever it wants using a simple text format:
  //
  //     data: {"title":"New message"}\n\n
  //     data: {"title":"Order shipped"}\n\n
  //
  //   Browser receives events via EventSource API:
  //     const source = new EventSource('/polling/stream?userId=1');
  //     source.onmessage = (e) => console.log(JSON.parse(e.data));
  //
  // SSE FORMAT:
  //   Each message is plain text with specific format:
  //     data: <your JSON here>\n\n     ← two newlines = end of message
  //     :heartbeat\n\n                 ← comment (keeps connection alive)
  //
  // PROS: Simple, built into browsers, auto-reconnects
  // CONS: One-way only (server→browser), limited to ~6 connections per domain
  //
  // USED BY: ChatGPT (streaming tokens!), live sports scores, stock tickers
  // =============================================================

  async sseStream(req: Request, res: Response): Promise<void> {
    const userId = parseInt(req.query.userId as string);

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',  // Required for SSE
      'Cache-Control': 'no-cache',           // Don't cache the stream
      'Connection': 'keep-alive',            // Keep connection open
    });

    // Send initial state
    const unread = await this.store.getUnreadCount(userId);
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      userId,
      unreadCount: unread,
      message: 'SSE stream connected',
    })}\n\n`);

    // Register this client
    if (!this.sseClients.has(userId)) {
      this.sseClients.set(userId, []);
    }
    this.sseClients.get(userId)!.push(res);

    console.log(`📡 SSE client connected for user ${userId} (${this.sseClients.get(userId)!.length} total)`);

    // Heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, 15000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      const clients = this.sseClients.get(userId) || [];
      this.sseClients.set(userId, clients.filter(c => c !== res));
      console.log(`📡 SSE client disconnected for user ${userId}`);
    });
  }

  /**
   * Push a notification to all connected SSE clients for a user.
   * Called by the Pub/Sub subscriber.
   */
  pushToSSEClients(userId: number, data: any): void {
    const clients = this.sseClients.get(userId) || [];
    const message = `data: ${JSON.stringify(data)}\n\n`;

    for (const client of clients) {
      client.write(message);
    }

    if (clients.length > 0) {
      console.log(`📡 Pushed to ${clients.length} SSE client(s) for user ${userId}`);
    }
  }

  // =============================================================
  // STRATEGY 4: WEBSOCKET
  // =============================================================
  //
  // HOW IT WORKS:
  //   Starts as HTTP, then UPGRADES to WebSocket protocol.
  //   Full duplex — both sides can send anytime.
  //
  //   Browser:
  //     const ws = new WebSocket('ws://localhost:4000');
  //     ws.onmessage = (e) => console.log(e.data);  // receive
  //     ws.send('hello');                             // send
  //
  // We won't implement a full WebSocket server here (needs the 'ws'
  // library), but we provide the config endpoint that a frontend
  // would use to connect.
  //
  // PROS: Full duplex, lowest latency, most powerful
  // CONS: Most complex, requires separate server/library,
  //       harder to scale (sticky sessions needed)
  //
  // USED BY: Discord, Slack, Google Docs, multiplayer games
  // =============================================================

  websocketInfo(req: Request, res: Response): void {
    res.json({
      strategy: 'websocket',
      note: 'WebSocket requires the ws library and a protocol upgrade',
      wouldConnect: 'ws://localhost:4000/ws',
      comparison: {
        sseVsWebSocket: 'SSE is one-way (server→client), WebSocket is two-way',
        whenToUseSSE: 'Notifications, live feeds, streaming (one-way is enough)',
        whenToUseWebSocket: 'Chat, gaming, collaboration (need two-way)',
        recommendation: 'For notifications, SSE is simpler and sufficient',
      },
    });
  }

  // =============================================================
  // COMPARISON — All 4 strategies side by side
  // =============================================================

  comparison(req: Request, res: Response): void {
    res.json({
      strategies: [
        {
          name: 'Short Polling',
          endpoint: 'GET /polling/short?userId=1',
          latency: '0 to N seconds (polling interval)',
          serverLoad: 'High — constant requests even when no data',
          complexity: 'Very simple',
          requestsPerMinute: '~20 (polling every 3s)',
          usedBy: 'Simple dashboards, email refresh',
        },
        {
          name: 'Long Polling',
          endpoint: 'GET /polling/long?userId=1&timeout=30',
          latency: 'Near instant (responds when data arrives)',
          serverLoad: 'Medium — holds connections open',
          complexity: 'Moderate',
          requestsPerMinute: '~2-3 (only on new data + timeout)',
          usedBy: 'Facebook Messenger (originally), Slack fallback',
        },
        {
          name: 'Server-Sent Events (SSE)',
          endpoint: 'GET /polling/stream?userId=1',
          latency: 'Instant (server pushes immediately)',
          serverLoad: 'Low — one persistent connection',
          complexity: 'Simple (built into browsers)',
          requestsPerMinute: '1 (initial connection only)',
          usedBy: 'ChatGPT, live scores, stock tickers',
        },
        {
          name: 'WebSocket',
          endpoint: 'ws://localhost:4000/ws',
          latency: 'Instant (full duplex)',
          serverLoad: 'Low — one persistent connection',
          complexity: 'Complex (protocol upgrade, sticky sessions)',
          requestsPerMinute: '1 (initial connection only)',
          usedBy: 'Discord, Slack, Google Docs, games',
        },
      ],
    });
  }

  /**
   * Setup Redis Pub/Sub listener for broadcasting to SSE and long-poll clients.
   * This bridges the gap: worker publishes event → this pushes to connected clients.
   */
  private setupSSEBroadcaster(redisUrl: string): void {
    const sub = new Redis(redisUrl);

    sub.subscribe('notification:delivered');

    sub.on('message', async (channel: string, message: string) => {
      if (channel !== 'notification:delivered') return;

      const event = JSON.parse(message);

      // Push to SSE clients
      this.pushToSSEClients(event.userId, {
        type: 'notification',
        id: event.jobId,
        channel: event.channel,
        title: event.title,
        body: event.body,
        timestamp: event.timestamp,
      });

      // Push to long-poll waiting list
      await this.redis.lpush(
        `longpoll:user:${event.userId}`,
        JSON.stringify({
          id: event.jobId,
          channel: event.channel,
          title: event.title,
          body: event.body,
          timestamp: event.timestamp,
        })
      );
      // Auto-expire so old data doesn't pile up
      await this.redis.expire(`longpoll:user:${event.userId}`, 300);
    });

    console.log('📡 SSE/Long-poll broadcaster listening for events');
  }
}