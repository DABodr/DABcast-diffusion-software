// Tests for the 'Detect keys' heuristic of the JSON metadata mode
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectJsonKeys } from '../src/utils/jsonKeys.js';
import { resolveFirst } from '../src/appState.js';

describe('detectJsonKeys', () => {
  it('flat now-playing object (artist / title / slide)', () => {
    const d = { artist: 'The Vices', title: 'Strange Again', slide: 'https://x.io/a/music.jpg', slides: { show: 'https://x.io/a/show.jpg' } };
    const r = detectJsonKeys(d);
    assert.equal(r.artistKey, 'artist');
    assert.equal(r.titleKey, 'title');
    assert.equal(r.slsKey, 'slide');
  });

  it('current item preferred over next / history (AzuraCast-like)', () => {
    const song = (a, t) => ({ artist: a, title: t, art: `https://x.io/art/${t.replace(/ /g, '_')}.jpg` });
    const d = {
      station: { name: 'Demo FM', logo: 'https://x.io/logo.png' },
      now_playing: { song: song('Now Artist', 'Now Title') },
      playing_next: { song: song('Next Artist', 'Next Title') },
      song_history: [{ song: song('Old Artist', 'Old Title') }],
    };
    const r = detectJsonKeys(d);
    assert.equal(r.artistKey, 'now_playing.song.artist');
    assert.equal(r.titleKey, 'now_playing.song.title');
    assert.equal(r.slsKey, 'now_playing.song.art');
    assert.equal(resolveFirst(d, r.titleKey), 'Now Title', 'keys work with resolveFirst');
  });

  it('artist.name and a numeric-looking title', () => {
    const r = detectJsonKeys({ title: '1999', artist: { name: 'Prince', id: 42 }, started_at: '2026-01-01T10:00:00Z' });
    assert.equal(r.artistKey, 'artist.name');
    assert.equal(r.titleKey, 'title');
  });

  it('array root: first item, and the station logo is not taken as the cover', () => {
    const d = [
      { track: { name: 'Song A', artist: 'Artist A', cover: { large: 'https://x.io/a-600.jpg', small: 'https://x.io/a-60.jpg' } }, channel: { logo: 'https://x.io/logo.jpg' } },
      { track: { name: 'Song B', artist: 'Artist B' } },
    ];
    const r = detectJsonKeys(d);
    assert.equal(r.titleKey, '0.track.name');
    assert.equal(r.artistKey, '0.track.artist');
    assert.equal(r.slsKey, '0.track.cover.large');
  });

  it('nothing usable: empty keys, no throw', () => {
    const r = detectJsonKeys({ status: 'ok', count: 3, items: [] });
    assert.deepEqual([r.artistKey, r.titleKey, r.slsKey], ['', '', '']);
    assert.deepEqual(detectJsonKeys(null).titleKey, '');
  });
});

describe('_fetchText — Server-Sent Events feed (never-ending response)', () => {
  it('returns the data of the first event, before the timeout', async () => {
    const http = await import('node:http');
    const { AppState } = await import('../src/appState.js');
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': keep-alive\n\n');   // comment event without data: skipped
      res.write('data: {"artist":"TEMPER CITY","title":"SELF AWARE","type":"song"}\r\n\r\n');
      // never ends, like lorfm.com/ws/metas
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    try {
      const text = await AppState.prototype._fetchText.call({}, `http://127.0.0.1:${srv.address().port}/ws`, 2500);
      assert.deepEqual(JSON.parse(text), { artist: 'TEMPER CITY', title: 'SELF AWARE', type: 'song' });
      assert.ok(Date.now() - t0 < 2000, 'answered without waiting for the timeout');
      assert.equal(detectJsonKeys(JSON.parse(text)).titleKey, 'title');
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });
});
