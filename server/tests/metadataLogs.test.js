import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Test the metadata log filtering logic used by /api/logs/metadata.
 * We replicate the inline filter from index.js here to validate behavior.
 */
function filterMetaLines(content, svcFilter, limit) {
  const pattern = svcFilter ? `svc:${svcFilter}:meta` : 'svc:';
  return content.split('\n')
    .filter((l) => l.includes(pattern) && (!svcFilter || l.includes(`svc:${svcFilter}:meta`)))
    .slice(-limit);
}

const SAMPLE_LOG = [
  '[2026-02-14 10:00:01] [svc:F124:meta] [json] fetch https://api.example.com/np',
  '[2026-02-14 10:00:01] [svc:F124:meta] [json] parse OK',
  '[2026-02-14 10:00:01] [svc:F124:meta] [json] artist="Daft Punk" title="Around" cover=yes',
  '[2026-02-14 10:00:01] [svc:F124:meta] [sls] download https://example.com/cover.jpg',
  '[2026-02-14 10:00:02] [svc:F124:meta] [img] resize OK -> /data/mot/F124/slide/cover.jpg',
  '[2026-02-14 10:00:02] [svc:F124:meta] [dls] "Daft Punk - Around"',
  '[2026-02-14 10:00:03] [mux] odr-dabmux started',
  '[2026-02-14 10:00:03] [svc:ABCD:meta] [json] fetch https://api.other.com/np',
  '[2026-02-14 10:00:03] [svc:ABCD:meta] [err] empty response from https://api.other.com/np',
  '[2026-02-14 10:00:04] [watchdog] check',
  '[2026-02-14 10:00:04] [svc:F124:meta] [cleanup] removed cover.jpg (mode=STREAM)',
].join('\n');

describe('filterMetaLines', () => {
  it('returns all meta lines when no svc filter', () => {
    const lines = filterMetaLines(SAMPLE_LOG, '', 2000);
    assert.equal(lines.length, 9);
    assert.ok(lines.every((l) => l.includes('svc:')));
  });

  it('filters by specific service', () => {
    const lines = filterMetaLines(SAMPLE_LOG, 'F124', 2000);
    assert.equal(lines.length, 7);
    assert.ok(lines.every((l) => l.includes('svc:F124:meta')));
  });

  it('filters another service', () => {
    const lines = filterMetaLines(SAMPLE_LOG, 'ABCD', 2000);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.includes('svc:ABCD:meta')));
  });

  it('excludes non-meta lines', () => {
    const lines = filterMetaLines(SAMPLE_LOG, '', 2000);
    assert.ok(!lines.some((l) => l.includes('[watchdog]')));
    assert.ok(!lines.some((l) => l.includes('[mux]')));
  });

  it('respects limit (returns last N)', () => {
    const lines = filterMetaLines(SAMPLE_LOG, 'F124', 3);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].includes('[cleanup]'));
  });

  it('returns empty for unknown service', () => {
    const lines = filterMetaLines(SAMPLE_LOG, 'ZZZZ', 2000);
    assert.equal(lines.length, 0);
  });

  it('handles empty content', () => {
    const lines = filterMetaLines('', '', 100);
    assert.equal(lines.length, 0);
  });
});
