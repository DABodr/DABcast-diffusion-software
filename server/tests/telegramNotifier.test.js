import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramLogNotifier, createTelegramNotifierFromEnv } from '../src/telegramNotifier.js';

function successfulResponse() {
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
}

describe('TelegramLogNotifier', () => {
  it('sends only messages at or above the configured level', async () => {
    const requests = [];
    const notifier = new TelegramLogNotifier({
      token: 'test-token',
      chatId: '-1234',
      minLevel: 'WARN',
      hostname: 'dab-host',
      minIntervalMs: 0,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return successfulResponse();
      }
    });

    assert.equal(notifier.notify({ level: 'INFO', scope: 'web', message: 'started' }), false);
    assert.equal(notifier.notify({ level: 'ERROR', scope: 'mux', message: 'crashed' }), true);
    await notifier.flush();

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/bottest-token\/sendMessage$/);
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.chat_id, '-1234');
    assert.match(payload.text, /DABcast @ dab-host/);
    assert.match(payload.text, /ERROR \[mux\]/);
    assert.match(payload.text, /crashed/);
  });

  it('recovery messages: sent whatever the level, only when their option is on', async () => {
    const requests = [];
    const make = (recovery) => new TelegramLogNotifier({
      token: 't', chatId: '1', minLevel: 'ERROR', minIntervalMs: 0, recovery,
      fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body).text); return successfulResponse(); },
    });
    const off = make(undefined);   // older .telegram.json: no option = off
    assert.equal(off.notifyRecovery('outputs', { scope: 'watchdog', message: 'SDR transmitting again' }), false);
    const on = make({ outputs: true, services: false });
    assert.equal(on.notifyRecovery('services', { scope: 'svc:F9A3', message: 'back on its main stream' }), false);
    assert.equal(on.notifyRecovery('outputs', { scope: 'watchdog', message: 'SDR transmitting again' }), true);
    await on.flush();
    assert.equal(requests.length, 1);
    assert.match(requests[0], /✅ RESOLVED \[watchdog\]\n.*\nSDR transmitting again/);
  });

  it('reports API errors without rejecting flush', async () => {
    const errors = [];
    const notifier = new TelegramLogNotifier({
      token: 'test-token',
      chatId: '1234',
      minIntervalMs: 0,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ description: 'Unauthorized' })
      }),
      onError: message => errors.push(message)
    });

    notifier.notify({ level: 'ERROR', message: 'failure' });
    await notifier.flush();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /HTTP 401: Unauthorized/);
  });

  it('is enabled from the environment only when both credentials exist', () => {
    assert.equal(createTelegramNotifierFromEnv({}), null);
    assert.equal(createTelegramNotifierFromEnv({ DABCAST_TELEGRAM_BOT_TOKEN: 'token' }), null);

    const notifier = createTelegramNotifierFromEnv({
      DABCAST_TELEGRAM_BOT_TOKEN: 'token',
      DABCAST_TELEGRAM_CHAT_ID: '42',
      DABCAST_TELEGRAM_MIN_LEVEL: 'warn',
      DABCAST_TELEGRAM_SILENT: 'true'
    });
    assert.ok(notifier instanceof TelegramLogNotifier);
    assert.equal(notifier.minLevel, 'WARN');
    assert.equal(notifier.silent, true);
  });
});
