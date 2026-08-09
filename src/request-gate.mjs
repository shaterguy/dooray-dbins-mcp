export class RequestGate {
  constructor({ limit = 60, windowMs = 60_000, maxConcurrent = 2, maxClients = 10_000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxConcurrent = maxConcurrent;
    this.maxClients = maxClients;
    this.now = now;
    this.clients = new Map();
    this.active = 0;
    this.lastSweep = 0;
  }

  prune(currentTime) {
    for (const [key, client] of this.clients) {
      if (currentTime - client.windowStart >= this.windowMs) this.clients.delete(key);
    }
    while (this.clients.size >= this.maxClients) {
      const oldestKey = this.clients.keys().next().value;
      if (oldestKey === undefined) break;
      this.clients.delete(oldestKey);
    }
    this.lastSweep = currentTime;
  }

  enter(clientKey) {
    const currentTime = this.now();
    const key = clientKey || "unknown";
    let client = this.clients.get(key);
    if (!client || currentTime - client.windowStart >= this.windowMs) {
      if (!client && (this.clients.size >= this.maxClients || currentTime - this.lastSweep >= this.windowMs)) {
        this.prune(currentTime);
      }
      if (client) this.clients.delete(key);
      client = { windowStart: currentTime, count: 0 };
      this.clients.set(key, client);
    }

    if (client.count >= this.limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((client.windowStart + this.windowMs - currentTime) / 1000)) };
    }
    if (this.active >= this.maxConcurrent) {
      return { ok: false, retryAfterSeconds: 1 };
    }

    client.count += 1;
    this.active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}

export function requestClientKey(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || "").split(",")[0];
  return firstForwarded.trim().slice(0, 128) || String(req.socket?.remoteAddress || "unknown").slice(0, 128);
}

