// A reconnecting WebSocket for Node — the worker-side sibling of the app's
// ReconnectingSocket. Node 22's global WebSocket, so no dependency.
//
// Two liveness models, because the two upstreams behave differently:
// PumpPortal answers a ping frame; the RPC log stream at ~200 frames/s simply
// never goes quiet while healthy, so silence IS the failure signal there.

import { log, sleep } from "./util.js";

export class ReconnectingWs {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.url
   * @param {() => unknown[]} opts.onOpenSend frames to send after every (re)connect — subscriptions live here
   * @param {(msg: any, at: number) => void} opts.onMessage parsed JSON frames
   * @param {number} opts.silenceMs declare the socket dead after this much silence
   * @param {(() => unknown) | undefined} [opts.ping] optional keepalive frame, sent at silenceMs/2
   */
  constructor(opts) {
    this.opts = opts;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.closed = false;
    this.lastFrameAt = 0;
    this.connects = 0;
    this.frames = 0;
    this.lastError = "";
    /** @type {ReturnType<typeof setInterval> | null} */
    this.watchdog = null;
    this.backoffMs = 1_000;
  }

  start() {
    this.closed = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkAlive(), Math.max(5_000, this.opts.silenceMs / 3));
  }

  connect() {
    if (this.closed) return;
    try {
      this.ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.lastError = String(e);
      this.scheduleReconnect();
      return;
    }
    const ws = this.ws;
    ws.onopen = () => {
      this.connects++;
      this.backoffMs = 1_000;
      this.lastFrameAt = Date.now();
      log(`[${this.opts.name}] connected (#${this.connects})`);
      for (const frame of this.opts.onOpenSend()) ws.send(JSON.stringify(frame));
    };
    ws.onmessage = (ev) => {
      this.lastFrameAt = Date.now();
      this.frames++;
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      try {
        this.opts.onMessage(msg, this.lastFrameAt);
      } catch (e) {
        // One bad frame must not kill the stream.
        this.lastError = `onMessage: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    ws.onerror = () => {
      this.lastError = "socket error";
    };
    ws.onclose = () => {
      if (!this.closed) this.scheduleReconnect();
    };
  }

  checkAlive() {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const quiet = Date.now() - this.lastFrameAt;
    if (this.opts.ping && quiet > this.opts.silenceMs / 2) {
      try {
        this.ws.send(JSON.stringify(this.opts.ping()));
      } catch {
        /* close handler owns recovery */
      }
    }
    if (quiet > this.opts.silenceMs) {
      log(`[${this.opts.name}] silent ${Math.round(quiet / 1000)}s — reconnecting`);
      this.lastError = "silence timeout";
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  async scheduleReconnect() {
    if (this.closed) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    log(`[${this.opts.name}] reconnect in ${wait}ms`);
    await sleep(wait);
    this.connect();
  }

  /** @param {unknown} frame */
  send(frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  stop() {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    try {
      this.ws?.close();
    } catch {
      /* stopping */
    }
  }

  status() {
    return {
      name: this.opts.name,
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      connects: this.connects,
      frames: this.frames,
      lastFrameAgoMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
      lastError: this.lastError || null,
    };
  }
}
