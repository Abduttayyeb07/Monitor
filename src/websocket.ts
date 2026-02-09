import WebSocket from "ws";

export interface ZigWebSocketClientOptions {
  url: string;
  onMessage: (raw: string) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
}

export class ZigWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private intentionalClose = false;
  private readonly subscriptionQueries = [
    "tm.event='Tx'"
  ];
  private subscriptionIndex = 0;
  private subscriptionId = 1;
  private subscriptionConfirmed = false;

  constructor(private readonly options: ZigWebSocketClientOptions) {}

  connect(): void {
    this.intentionalClose = false;
    this.clearReconnectTimer();

    console.log(`[ws] Connecting to ${this.options.url}`);
    this.ws = new WebSocket(this.options.url);

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.lastPongAt = Date.now();
      this.subscriptionIndex = 0;
      this.subscriptionConfirmed = false;
      console.log("[ws] Connected");
      this.subscribeCurrentQuery();
      this.startHeartbeat();
      this.options.onOpen?.();
    });

    this.ws.on("message", (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf-8");
      this.handleSubscriptionResponse(raw);
      this.options.onMessage(raw);
    });

    this.ws.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer.toString("utf-8");
      console.warn(`[ws] Disconnected (code=${code}, reason=${reason || "n/a"})`);
      this.stopHeartbeat();
      this.options.onClose?.(code, reason);
      this.ws = null;

      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      console.error("[ws] Error:", err.message);
      this.options.onError?.(err);
    });

    this.ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });
  }

  close(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private subscribeCurrentQuery(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const query = this.subscriptionQueries[this.subscriptionIndex];
    this.subscriptionId += 1;
    const payload = {
      jsonrpc: "2.0",
      id: this.subscriptionId,
      method: "subscribe",
      params: {
        query
      }
    };

    this.ws.send(JSON.stringify(payload));
    console.log(`[ws] Subscription sent: ${query}`);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delayMs = this.calculateBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;

    console.log(`[ws] Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  private calculateBackoffMs(attempt: number): number {
    const base = 1_000;
    const max = 30_000;
    const backoff = Math.min(max, base * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    return backoff + jitter;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const staleForMs = Date.now() - this.lastPongAt;
      if (staleForMs > 60_000) {
        console.warn("[ws] Heartbeat timeout, restarting socket");
        this.ws.terminate();
        return;
      }

      this.ws.ping();
    }, 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleSubscriptionResponse(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj.id !== "number" || obj.id !== this.subscriptionId) {
      return;
    }

    if (obj.error && this.subscriptionIndex < this.subscriptionQueries.length - 1) {
      const failedQuery = this.subscriptionQueries[this.subscriptionIndex];
      this.subscriptionIndex += 1;
      this.subscriptionConfirmed = false;
      const nextQuery = this.subscriptionQueries[this.subscriptionIndex];
      console.warn(`[ws] Subscription rejected for "${failedQuery}", trying "${nextQuery}"`);
      this.subscribeCurrentQuery();
      return;
    }

    if (obj.result && !this.subscriptionConfirmed) {
      this.subscriptionConfirmed = true;
      const activeQuery = this.subscriptionQueries[this.subscriptionIndex];
      console.log(`[ws] Subscription active: ${activeQuery}`);
    }
  }
}
