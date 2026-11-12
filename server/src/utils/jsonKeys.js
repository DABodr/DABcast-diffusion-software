// 'Detect keys' (Metadata tab, JSON mode): suggest the artist / title / cover keys of a now-playing
// JSON, in the dot-path syntax of resolveFirst() ("now.artist", "data.0.track.title").
// Read-only and heuristic: key names, values, and context (current item preferred over history /
// next, artist and title preferably in the same object, cover close to them).

const MAX_NODES = 20000;
const MAX_DEPTH = 10;

const RE = {
  title: /^(title|song|songtitle|song_title|songname|song_name|track|tracktitle|track_title|trackname|track_name|titel|titre|name)$/i,
  artist: /^(artist|artists|artistname|artist_name|artist_names|interpret|interpreter|interprete|performer|performers|singer|band|author|artiste)$/i,
  coverKey: /(^art$|^art_?url$|cover|image|img|artwork|picture|thumb|albumart|album_art|visual|photo|pochette|bild)/i,
  imageUrl: /^https?:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i,
  anyUrl: /^https?:\/\//i,
  now: /^(now|current|nowplaying|now_playing|nowplay|playing|onair|on_air|live|present|currenttrack|current_track|currentsong|current_song|song|track)$/i,
  past: /^(history|previous|prev|last|lastplayed|last_played|recent|recently|played|past|before|playhistory|playhistories)$/i,
  next: /^(next|upcoming|nextsong|next_song|nexttrack|next_track|following|coming|later|queue)$/i,
  big: /(large|big|xl|full|original|hires|hi_res|600|640|800|1000|1200)/i,
  small: /(small|thumb|tiny|mini|xs|icon|50|60|64|75|100)/i,
  logo: /(logo|station|channel|brand)/i,
};

// All scalar leaves: { path: ['a', 0, 'b'], key, parentKey, value }
function leaves(data) {
  const out = [];
  let count = 0;
  const walk = (val, path, depth) => {
    if (count++ > MAX_NODES || depth > MAX_DEPTH || val == null) return;
    if (Array.isArray(val)) { val.forEach((v, i) => walk(v, [...path, i], depth + 1)); return; }
    if (typeof val === 'object') { for (const [k, v] of Object.entries(val)) walk(v, [...path, k], depth + 1); return; }
    const key = path.length ? String(path[path.length - 1]) : '';
    const named = path.filter((p) => typeof p === 'string');
    out.push({ path, key, parentKey: named.length > 1 ? named[named.length - 2] : '', value: String(val).trim() });
  };
  walk(data, [], 0);
  return out;
}

// Context score of a path: current item preferred, history / next penalised, first array item preferred
function contextScore(path) {
  let s = 0;
  for (const p of path) {
    if (typeof p === 'number') { s += p === 0 ? 0 : -3 - Math.min(p, 5); continue; }
    if (RE.now.test(p)) s += 4;
    if (RE.past.test(p)) s -= 6;
    if (RE.next.test(p)) s -= 8;
  }
  return s - path.length * 0.2;   // shorter paths slightly preferred
}

const parentOf = (path) => path.slice(0, -1).join('.');
const isText = (v) => v.length >= 1 && v.length <= 200 && !RE.anyUrl.test(v) && v !== 'true' && v !== 'false';
// Numbers are allowed (a title can be "1999" or "02.2023") but count less: ids, counters
const isNumber = (v) => /^-?\d+(\.\d+)?$/.test(v);

function textCandidates(all, kind) {
  const other = kind === 'title' ? 'artist' : 'title';
  return all.filter((l) => isText(l.value)).map((l) => {
    let s = -100;
    const k = l.key;
    if (k.toLowerCase() === 'name') {
      // "name" counts when its object says what it is: artist.name, track.name, song.name
      if (RE[kind].test(l.parentKey) && l.parentKey.toLowerCase() !== 'name') s = 8;
    } else if (RE[kind].test(k)) {
      s = 10;
    } else if (RE[kind].test(l.parentKey) && !RE[other].test(k) && /^(text|value|label|display|displayname|display_name)$/i.test(k)) {
      s = 6;
    }
    if (s < 0) return null;
    if (RE.logo.test(l.path.join('.'))) s -= 4;     // station.name is not the artist
    if (isNumber(l.value)) s -= 6;
    return { ...l, score: s + contextScore(l.path) };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

function coverCandidates(all, near) {
  return all.filter((l) => RE.anyUrl.test(l.value) && !/\s/.test(l.value)).map((l) => {
    let s = -100;
    if (RE.imageUrl.test(l.value)) s = 6;
    if (RE.coverKey.test(l.key) || RE.coverKey.test(l.parentKey)) s = Math.max(s, 0) + 6;
    if (s < 0) return null;
    const p = l.path.join('.');
    if (RE.logo.test(p) && !/cover|album|track|song/i.test(p)) s -= 8;   // station logo, not the track cover
    if (RE.big.test(p)) s += 2;
    if (RE.small.test(l.key)) s -= 2;
    if (near) {
      const np = parentOf(near.path);
      const lp = parentOf(l.path);
      if (lp === np || lp.startsWith(`${np}.`)) s += 6;          // inside the current item
      else if (np.startsWith(lp)) s += 2;                          // in an object above it
    }
    return { ...l, score: s + contextScore(l.path) };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

const keyOf = (l) => (l ? l.path.join('.') : '');

// → { artistKey, titleKey, slsKey, artist, title, coverUrl, alternatives: { artist, title, cover } }
export function detectJsonKeys(data) {
  const all = leaves(data);
  const titles = textCandidates(all, 'title');
  const artists = textCandidates(all, 'artist');
  // best (title, artist) pair: same object (or artist one level away) wins
  let best = { t: titles[0] || null, a: artists[0] || null, score: -Infinity };
  for (const t of titles.slice(0, 15)) {
    for (const a of [null, ...artists.slice(0, 15)]) {
      if (a && a.path.join('.') === t.path.join('.')) continue;
      let s = t.score + (a ? a.score : -4);
      if (a) {
        const tp = parentOf(t.path), ap = parentOf(a.path);
        if (tp === ap) s += 8;
        else if (ap.startsWith(tp) || tp.startsWith(ap)) s += 4;
        else s -= 4;
      }
      if (s > best.score) best = { t, a, score: s };
    }
  }
  const covers = coverCandidates(all, best.t || best.a);
  const alt = (list) => [...new Set(list.map(keyOf))].slice(0, 5);
  return {
    artistKey: keyOf(best.a),
    titleKey: keyOf(best.t),
    slsKey: keyOf(covers[0]),
    artist: best.a?.value || '',
    title: best.t?.value || '',
    coverUrl: covers[0]?.value || '',
    alternatives: { artist: alt(artists), title: alt(titles), cover: alt(covers) },
  };
}
