// Automatic updates (autoUpdate.js): settings, time / day / once a day, version choice (delay, skip list), health check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAutoUpdate, isDue, dayKey, pickVersion, healthAfterUpdate, compareVersions } from '../src/autoUpdate.js';

const cfg = (o = {}) => normalizeAutoUpdate({ enabled: true, time: '02:00', days: [1, 2, 3, 4, 5, 6, 7], delayDays: 3, ...o });

describe('automatic updates', () => {
  it('off by default, safe values only', () => {
    assert.deepEqual(normalizeAutoUpdate(), { enabled: false, time: '02:00', days: [1, 2, 3, 4, 5, 6, 7], delayDays: 3, skip: [] });
    assert.deepEqual(normalizeAutoUpdate({ enabled: 'yes', time: '25:00', days: [0, 8, 3, 3], delayDays: 5, skip: ['1.2.3', '../x'] }),
      { enabled: false, time: '02:00', days: [3], delayDays: 3, skip: ['1.2.3'] });
  });

  it('due at HH:MM on a day ticked, once a day', () => {
    const mon2 = new Date(2026, 10, 23, 2, 0, 30);   // Monday 02:00
    assert.ok(isDue(cfg(), mon2));
    assert.ok(!isDue(cfg(), new Date(2026, 10, 23, 2, 1)), 'another minute');
    assert.ok(!isDue(cfg({ days: [2] }), mon2), 'Monday not ticked');
    assert.ok(!isDue(cfg(), mon2, dayKey(mon2)), 'already tried today');
    assert.ok(!isDue(cfg({ enabled: false }), mon2));
  });

  it('version: newer, published long enough ago, never a rolled-back one', () => {
    const now = Date.parse('2026-11-23T01:00:00Z');
    const old = '2026-11-18T10:00:00Z', fresh = '2026-11-22T10:00:00Z';
    assert.deepEqual(pickVersion({ cfg: cfg(), current: '1.11.0', latest: '1.12.0', publishedAt: old, now }), { version: '1.12.0' });
    assert.match(pickVersion({ cfg: cfg(), current: '1.11.0', latest: '1.12.0', publishedAt: fresh, now }).none, /less than 3 day/);
    assert.deepEqual(pickVersion({ cfg: cfg({ delayDays: 0 }), current: '1.11.0', latest: '1.12.0', publishedAt: fresh, now }), { version: '1.12.0' });
    assert.match(pickVersion({ cfg: cfg(), current: '1.12.0', latest: '1.12.0', publishedAt: old, now }).none, /up to date/);
    assert.match(pickVersion({ cfg: cfg(), current: '1.12.0', latest: '1.11.9', publishedAt: old, now }).none, /up to date/, 'never an older one');
    assert.match(pickVersion({ cfg: cfg({ skip: ['1.12.0'] }), current: '1.11.0', latest: '1.12.0', publishedAt: old, now }).none, /rolled back/);
    assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  });

  it('health after the restart: back on air with as many services running', () => {
    assert.ok(healthAfterUpdate({ wasOnAir: false, before: {}, after: { muxRunning: false, running: 0 } }).ok);
    assert.ok(healthAfterUpdate({ wasOnAir: true, before: { running: 10 }, after: { muxRunning: true, running: 10 } }).ok);
    assert.ok(!healthAfterUpdate({ wasOnAir: true, before: { running: 10 }, after: { muxRunning: false, running: 0 } }).ok);
    assert.match(healthAfterUpdate({ wasOnAir: true, before: { running: 10 }, after: { muxRunning: true, running: 8 } }).reason, /8 service/);
  });
});
