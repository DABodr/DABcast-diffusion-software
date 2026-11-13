import os from 'node:os';

const LEVEL_PRIORITY = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const TELEGRAM_MAX_TEXT_LENGTH = 4096;

function normalizeLevel(level) {
  const normalized = String(level || 'ERROR').toUpperCase();
  return Object.hasOwn(LEVEL_PRIORITY, normalized) ? normalized : 'ERROR';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class TelegramLogNotifier {
  constructor({
    token,
    chatId,
    minLevel = 'ERROR',
    hostname = os.hostname(),
    fetchImpl = globalThis.fetch,
    minIntervalMs = 1000,
    maxQueueSize = 100,
    requestTimeoutMs = 10000,
    silent = false,
    recovery = {},
    onError = (message) => console.error(message)
  } = {}) {
    if (!token) throw new Error('Telegram bot token is required');
    if (!chatId) throw new Error('Telegram chat ID is required');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

    this.token = token;
    this.chatId = String(chatId);
    this.minLevel = normalizeLevel(minLevel);
    this.hostname = hostname;
    this.fetchImpl = fetchImpl;
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.maxQueueSize = Math.max(1, Number(maxQueueSize) || 100);
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || 10000);
    this.silent = Boolean(silent);
    // recovery messages ("back on air") sent whatever minLevel, one option per kind: { outputs, services }
    this.recovery = { outputs: recovery?.outputs === true, services: recovery?.services === true };
    this.onError = onError;
    this._queue = [];
    this._draining = null;
    this._lastSendMs = 0;
  }

  accepts(level) {
    return LEVEL_PRIORITY[normalizeLevel(level)] >= LEVEL_PRIORITY[this.minLevel];
  }

  notify({ timestamp = new Date().toISOString(), level = 'INFO', scope = 'app', message = '' } = {}) {
    const normalizedLevel = normalizeLevel(level);
    if (!this.accepts(normalizedLevel)) return false;

    this._enqueue(this._format({ timestamp, level: normalizedLevel, scope, message }));
    return true;
  }

  // "✅ RESOLVED" message (transmitter output back: SDR transmitting / modulator reconnected; service back
  // on air / on its main stream):
  // false = its option is off (the caller then logs it as an ordinary INFO line)
  notifyRecovery(kind, { timestamp = new Date().toISOString(), scope = 'app', message = '' } = {}) {
    if (!this.recovery[kind]) return false;
    this._enqueue(this._format({ timestamp, level: '✅ RESOLVED', scope, message }));
    return true;
  }

  _enqueue(text) {
    if (this._queue.length >= this.maxQueueSize) this._queue.shift();
    this._queue.push(text);
    this._startDrain();
  }

  async flush() {
    while (this._draining || this._queue.length > 0) {
      if (!this._draining) this._startDrain();
      await this._draining;
    }
  }

  async sendTest() {
    const timestamp = new Date().toISOString();
    const text = this._format({
      timestamp,
      level: 'INFO',
      scope: 'telegram',
      message: 'Telegram connection is working.'
    });
    await this._send(text);
  }

  _format({ timestamp, level, scope, message }) {
    const prefix = `DABcast @ ${this.hostname}\n${level} [${scope}]\n${timestamp}\n`;
    const available = TELEGRAM_MAX_TEXT_LENGTH - prefix.length;
    return prefix + String(message).slice(0, Math.max(0, available));
  }

  _startDrain() {
    if (this._draining) return;
    this._draining = this._drain().finally(() => {
      this._draining = null;
      if (this._queue.length > 0) this._startDrain();
    });
  }

  async _drain() {
    while (this._queue.length > 0) {
      const remainingDelay = this.minIntervalMs - (Date.now() - this._lastSendMs);
      if (remainingDelay > 0) await sleep(remainingDelay);

      const text = this._queue.shift();
      try {
        await this._send(text);
      } catch (err) {
        try {
          this.onError(`Telegram log notification failed: ${err?.message || err}`);
        } catch { /* notification errors must never affect DABcast */ }
      }
      this._lastSendMs = Date.now();
    }
  }

  async _send(text) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            disable_notification: this.silent
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        let detail = '';
        try {
          const payload = await response.json();
          detail = payload?.description ? `: ${payload.description}` : '';
        } catch { /* response body is optional */ }
        throw new Error(`Telegram API HTTP ${response.status}${detail}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createTelegramNotifierFromEnv(env = process.env, options = {}) {
  const token = env.DABCAST_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.DABCAST_TELEGRAM_CHAT_ID?.trim();
  if (!token && !chatId) return null;
  if (!token || !chatId) {
    options.onError?.('Telegram notifications disabled: both DABCAST_TELEGRAM_BOT_TOKEN and DABCAST_TELEGRAM_CHAT_ID are required');
    return null;
  }

  return new TelegramLogNotifier({
    ...options,
    token,
    chatId,
    minLevel: env.DABCAST_TELEGRAM_MIN_LEVEL || 'ERROR',
    silent: /^(1|true|yes)$/i.test(env.DABCAST_TELEGRAM_SILENT || '')
  });
}
