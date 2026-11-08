import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFirst } from '../src/appState.js';

describe('resolveFirst', () => {
  const data = {
    artist: 'Daft Punk',
    title: 'Around the World',
    cover: 'https://example.com/cover.jpg',
    now: {
      playing: {
        artist: 'Inner Artist',
        title: 'Inner Title'
      }
    },
    items: [
      { name: 'First' },
      { name: 'Second' }
    ],
    empty: '',
    zero: 0
  };

  it('resolves simple top-level key', () => {
    assert.equal(resolveFirst(data, 'artist'), 'Daft Punk');
    assert.equal(resolveFirst(data, 'title'), 'Around the World');
    assert.equal(resolveFirst(data, 'cover'), 'https://example.com/cover.jpg');
  });

  it('resolves dot-path nested keys', () => {
    assert.equal(resolveFirst(data, 'now.playing.artist'), 'Inner Artist');
    assert.equal(resolveFirst(data, 'now.playing.title'), 'Inner Title');
  });

  it('resolves array index', () => {
    assert.equal(resolveFirst(data, 'items.0.name'), 'First');
    assert.equal(resolveFirst(data, 'items.1.name'), 'Second');
  });

  it('resolves pipe fallback (first match wins)', () => {
    assert.equal(resolveFirst(data, 'missing|artist'), 'Daft Punk');
    assert.equal(resolveFirst(data, 'missing|also_missing|title'), 'Around the World');
  });

  it('resolves pipe fallback with dot-path', () => {
    assert.equal(resolveFirst(data, 'missing.key|now.playing.artist'), 'Inner Artist');
  });

  it('returns empty string for missing keys', () => {
    assert.equal(resolveFirst(data, 'nonexistent'), '');
    assert.equal(resolveFirst(data, 'a.b.c'), '');
    assert.equal(resolveFirst(data, 'missing|also_missing'), '');
  });

  it('skips empty string values in fallback', () => {
    assert.equal(resolveFirst(data, 'empty|artist'), 'Daft Punk');
  });

  it('returns 0 as a valid value (not skipped)', () => {
    assert.equal(resolveFirst(data, 'zero'), '0');
  });

  it('handles null/undefined data gracefully', () => {
    assert.equal(resolveFirst(null, 'artist'), '');
    assert.equal(resolveFirst(undefined, 'artist'), '');
  });

  it('handles null/empty keySpec gracefully', () => {
    assert.equal(resolveFirst(data, ''), '');
    assert.equal(resolveFirst(data, null), '');
  });
});
