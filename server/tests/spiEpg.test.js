// SPI programme guide (spiEpg.js): weekly grid, XMLTV and SPI XML sources, PI documents per day, carousel.
process.env.TZ = 'Europe/Paris';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { expandGrid, parseXmltv, parseXmltvTime, parseSpiXml, parseIsoDuration, fetchEpg, normalizeEpgEntry, epgSchedules, saveEpgEntry, refreshEpgCache, epgProgrammes } from '../src/spiEpg.js';
import { buildSpiCarousel } from '../src/spi.js';

const NOW = Date.parse('2026-11-23T09:30:00+01:00');   // Monday
const XMLTV = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="x"><channel id="gold.fr"><display-name>Fréquence 3 Gold</display-name></channel>
<channel id="other"><display-name>Other</display-name></channel>
<programme start="20261123060000 +0100" stop="20261123090000 +0100" channel="gold.fr"><title lang="fr">Le R&#233;veil &amp; Co</title><desc>Les tubes</desc></programme>
<programme start="20261123090000 +0100" channel="gold.fr"><title><![CDATA[Gold Hits]]></title></programme>
<programme start="20261123120000 +0100" stop="20261123130000 +0100" channel="gold.fr"><title>Midi</title></programme>
<programme start="20261123060000 +0100" stop="20261123070000 +0100" channel="other"><title>X</title></programme></tv>`;
const SPIXML = (day) => `<?xml version="1.0"?><epg xmlns="http://www.worlddab.org/schemas/spi" xml:lang="fr"><schedule><programme shortId="1" id="crid://x/1">
<shortName>Matin</shortName><mediumName>La matinale</mediumName><longName>La matinale ${day}</longName><location><time time="${day}T06:00:00+01:00" duration="PT3H"/></location>
<mediaDescription><shortDescription>Infos et musique</shortDescription></mediaDescription></programme></schedule></epg>`;
const fakeFetch = (map) => async (url) => {
  const body = map(url);
  if (body === null) return { ok: false, status: 404, headers: new Map() };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { ok: true, status: 200, headers: new Map([['content-length', String(buf.length)]]), arrayBuffer: async () => buf };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dabcast-epg-'));

describe('programme guide (EPG)', () => {
  it('weekly grid: days, local time, a show over midnight ends the next day', () => {
    const grid = normalizeEpgEntry({ source: 'grid', grid: [
      { days: [1, 2, 3, 4, 5], start: '06:00', end: '09:00', title: 'Le Réveil' },
      { days: [7], start: '22:00', end: '02:00', title: 'Nuit' },
      { days: [], start: '10:00', end: '11:00', title: 'dropped: no day' }] }).grid;
    assert.equal(grid.length, 2);
    const list = expandGrid(grid, NOW, 7);
    assert.equal(list.filter((p) => p.title === 'Le Réveil').length, 5, 'Monday to Friday');
    assert.equal(new Date(list[0].start).toISOString(), '2026-11-23T05:00:00.000Z', '06:00 Paris');
    const nuit = list.find((p) => p.title === 'Nuit');
    assert.equal(new Date(nuit.start).toISOString(), '2026-11-29T21:00:00.000Z');
    assert.equal(nuit.end - nuit.start, 4 * 3600000);
  });

  it('a show of the evening before (22:00–02:00) is still in the guide after midnight', () => {
    const entry = { source: 'grid', grid: [{ days: [1], start: '22:00', end: '02:00', title: 'Nuit du lundi' }] };
    const tue0030 = Date.parse('2026-11-24T00:30:00+01:00');
    const list = epgProgrammes(tmp(), 'f9a3', entry, tue0030);
    assert.equal(list[0]?.title, 'Nuit du lundi', 'still on air at 00:30');
    const today = epgSchedules('f9a3', list, tue0030)[0];
    assert.equal(new Date(today.start).toISOString(), '2026-11-23T23:00:00.000Z', "Tuesday's document");
    assert.equal(today.programmes[0].title, 'Nuit du lundi', "carried by today's document");
    const wed = Date.parse('2026-11-25T00:30:00+01:00');
    assert.equal(epgProgrammes(tmp(), 'f9a3', entry, wed).filter((p) => p.start < Date.parse('2026-11-25T00:00:00+01:00')).length, 0, 'the next day: gone (no show on Tuesday evening)');
  });

  it('XMLTV: times with offset, entities, CDATA, channels', () => {
    assert.equal(parseXmltvTime('20261123060000 +0100'), Date.parse('2026-11-23T05:00:00Z'));
    assert.equal(parseXmltvTime('20261123060000'), Date.parse('2026-11-23T06:00:00Z'), 'no offset = UTC');
    const { channels, programmes } = parseXmltv(XMLTV);
    assert.deepEqual(channels.map((c) => c.name), ['Fréquence 3 Gold', 'Other']);
    assert.equal(programmes[0].title, 'Le Réveil & Co');
    assert.equal(programmes[1].title, 'Gold Hits');
  });

  it('SPI XML: name, ISO duration, description', () => {
    assert.equal(parseIsoDuration('PT1H30M'), 5400000);
    const [p] = parseSpiXml(SPIXML('2026-11-23'));
    assert.equal(p.title, 'La matinale 2026-11-23');
    assert.equal(p.end - p.start, 3 * 3600000);
    assert.equal(p.description, 'Infos et musique');
    assert.equal(p.short, 'Matin', 'the station short names are kept');
    assert.equal(p.medium, 'La matinale');
    const [l] = parseSpiXml('<epg><schedule><programme><longName>X</longName><location><time time="2026-11-23T06:00:00Z"/></location><mediaDescription><longDescription>Long text</longDescription></mediaDescription></programme></schedule></epg>');
    assert.equal(l.description, 'Long text', 'longDescription when there is no shortDescription');
  });

  it('fetch: XMLTV gzipped (one channel, missing stop filled), SPI XML one file per day', async () => {
    const gz = zlib.gzipSync(XMLTV);
    const x = await fetchEpg({ source: 'xmltv', url: 'https://e/x.xml.gz', channel: 'gold.fr' }, { now: NOW, fetchImpl: fakeFetch(() => gz) });
    assert.deepEqual(x.programmes.map((p) => p.title), ['Le Réveil & Co', 'Gold Hits', 'Midi']);
    assert.equal(x.programmes[1].end, Date.parse('2026-11-23T11:00:00Z'), 'until the next programme');
    const urls = [];
    const s = await fetchEpg({ source: 'spixml', url: 'https://e/{date}_PI.xml' }, { now: NOW, fetchImpl: fakeFetch((u) => {
      urls.push(u); const d = /(\d{4})(\d\d)(\d\d)_PI/.exec(u); return d[3] === '25' ? null : SPIXML(`${d[1]}-${d[2]}-${d[3]}`);
    }) });
    assert.equal(urls.length, 7);
    assert.equal(urls[0], 'https://e/20261123_PI.xml');
    assert.equal(s.programmes.length, 6, 'one day missing (404) does not fail the others');
    await assert.rejects(fetchEpg({ source: 'xmltv', url: 'https://e/x', channel: 'nope' }, { now: NOW, fetchImpl: fakeFetch(() => XMLTV) }), /no programme for channel/);
  });

  it('cache: the last good guide is kept when a fetch fails', async () => {
    const dir = tmp();
    const entry = { source: 'xmltv', url: 'https://e/x', channel: 'gold.fr' };
    const ok = await refreshEpgCache(dir, 'f9a3', entry, { now: NOW, fetchImpl: fakeFetch(() => XMLTV) });
    assert.ok(ok.ok);
    const ko = await refreshEpgCache(dir, 'f9a3', entry, { now: NOW, fetchImpl: fakeFetch(() => null) });
    assert.equal(ko.ok, false);
    assert.equal(ko.programmes.length, 3);
    assert.equal(epgProgrammes(dir, 'f9a3', entry, NOW).length, 3);
    assert.equal(epgProgrammes(dir, 'f9a3', { ...entry, channel: 'other' }, NOW).length, 0, 'another channel: not the cached guide');
  });

  it('PI documents: one per local day, stable CRIDs, at most today + 6 days', () => {
    const list = expandGrid(normalizeEpgEntry({ source: 'grid', grid: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '06:00', end: '09:00', title: 'A' }] }).grid, NOW, 9);
    const sc = epgSchedules('f9a3', list, NOW);
    assert.equal(sc.length, 7);
    assert.equal(new Date(sc[0].start).toISOString(), '2026-11-22T23:00:00.000Z', 'local midnight');
    assert.equal(sc[0].sid, 0xf9a3);
    assert.equal(sc[0].programmes[0].crid, 'crid://dabcast/f9a3/202611230500');
    assert.deepEqual(epgSchedules('f9a3', list, NOW)[0].programmes[0].shortId, sc[0].programmes[0].shortId);
  });

  it('carousel: built with the guide only (no logo), services OFF left out', () => {
    const dir = tmp();
    saveEpgEntry(dir, 'F9A3', { source: 'grid', grid: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '06:00', end: '09:00', title: 'Le Réveil' }] });
    saveEpgEntry(dir, '42F1', { source: 'grid', grid: [{ days: [1], start: '06:00', end: '09:00', title: 'Off' }] });
    const services = [{ id: 'F9A3', identity: { pi: '0xF9A3', ps8: 'F3 Gold' } }, { id: '42F1', enabled: false, identity: { pi: '0x42F1', ps8: 'SwissPop' } }];
    const r = buildSpiCarousel({ dataDir: dir, settings: { spi: { enabled: true, bitrate: 16 }, ensemble: { eccHex: '0xE1', idHex: '0xFFFF' } }, services, now: NOW });
    assert.ok(r.ok, r.error);
    assert.equal(r.stats.epgDocs, 7);
    assert.equal(r.stats.epgServices, 1);
    assert.equal(fs.statSync(r.file).size % (48 * 4), 0, 'packets × 4 for the loop');
  });

  it('carousel built at the bit rate of the running mux (bitrate override), not the saved one', () => {
    const dir = tmp();
    saveEpgEntry(dir, 'F9A3', { source: 'grid', grid: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '06:00', end: '09:00', title: 'Matin' }] });
    const services = [{ id: 'F9A3', identity: { pi: '0xF9A3', ps8: 'F3 Gold' } }];
    const settings = { spi: { enabled: true, bitrate: 32 }, ensemble: { eccHex: '0xE1', idHex: '0xFFFF' } };
    const read = () => fs.readFileSync(path.join(dir, 'spi', 'spi.dat'));
    buildSpiCarousel({ dataDir: dir, settings, services, now: NOW, bitrate: 8 });
    assert.equal(((read()[0] >> 6) + 1) * 24, 24, 'packets of the 8 kbps sub-channel on air');
    buildSpiCarousel({ dataDir: dir, settings, services, now: NOW });
    assert.equal(((read()[0] >> 6) + 1) * 24, 96, 'saved bit rate otherwise');
  });
});
