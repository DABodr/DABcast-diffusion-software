// server/src/utils/dlplus.js
// Dynamic Label Plus (DL+) generation for DAB broadcasting
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Uppercase first grapheme of a string (for French proper nouns).
 * Example: "les beatles" → "Les beatles"
 */
function upperFirstGrapheme(str) {
  if (!str) return str;
  // Simple: uppercase first codepoint (sufficient for French)
  const [first, ...rest] = Array.from(str);
  return first.toLocaleUpperCase() + rest.join('');
}

/**
 * Get length in UTF-8 bytes.
 */
function utf8ByteLen(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Get length in Unicode codepoints (characters).
 */
function charLen(s) {
  return Array.from(s).length;
}

/**
 * Get length according to offset mode.
 * @param {"bytes"|"chars"} mode
 * @param {string} s
 */
function len(mode, s) {
  return mode === 'bytes' ? utf8ByteLen(s) : charLen(s);
}

/**
 * Truncate string to maxLen according to offset mode.
 * @param {"bytes"|"chars"} mode
 * @param {string} s
 * @param {number} maxLen
 */
function truncate(mode, s, maxLen) {
  if (mode === 'bytes') {
    // Truncate by UTF-8 bytes
    let buf = Buffer.from(s, 'utf8');
    if (buf.length <= maxLen) return s;
    buf = buf.subarray(0, maxLen);
    // Avoid splitting multi-byte chars: find last valid char boundary
    let result = buf.toString('utf8');
    // If last char is replacement char (�), we split a multi-byte sequence
    while (result.endsWith('\uFFFD') && buf.length > 0) {
      buf = buf.subarray(0, buf.length - 1);
      result = buf.toString('utf8');
    }
    return result;
  } else {
    // Truncate by Unicode codepoints
    const chars = Array.from(s);
    if (chars.length <= maxLen) return s;
    return chars.slice(0, maxLen).join('');
  }
}

/**
 * Build DL+ file content with parameters block and payload.
 *
 * @param {Object} options
 * @param {string} options.artist - Artist name
 * @param {string} options.title - Track title
 * @param {string} [options.url] - Optional homepage URL (PROGRAMME.HOMEPAGE tag 39)
 * @param {"bytes"|"chars"} [options.offsetMode="bytes"] - Offset calculation mode
 * @param {number} [options.maxPayloadLen=128] - Maximum payload length before tag calculation
 * @returns {string} DL+ file content with parameters block
 */
export function buildDlPlusFileContent({
  artist,
  title,
  url = '',
  offsetMode = 'bytes',
  maxPayloadLen = 128
}) {
  // Normalize artist/title
  artist = upperFirstGrapheme((artist ?? '').trim());
  title = upperFirstGrapheme((title ?? '').trim());
  url = (url ?? '').trim();

  // Build payload lines
  const payloadLines = [];
  const nowPlaying = `${artist} - ${title}`;
  payloadLines.push(nowPlaying);
  if (url) payloadLines.push(url);

  let payload = payloadLines.join('\n');

  // Apply length limit BEFORE calculating offsets
  if (len(offsetMode, payload) > maxPayloadLen) {
    // Truncate the entire payload
    payload = truncate(offsetMode, payload, maxPayloadLen);

    // Recalculate artist/title from truncated payload
    // If URL was included and we truncated, it might be cut off
    const lines = payload.split('\n');
    const truncatedNowPlaying = lines[0] || '';
    const parts = truncatedNowPlaying.split(' - ');
    artist = parts[0] || artist;
    title = parts.slice(1).join(' - ') || title;
    url = lines[1] || ''; // URL might be cut off
  }

  // Calculate offsets and lengths
  const artLen = len(offsetMode, artist);
  const sepLen = len(offsetMode, ' - ');
  const titleStart = artLen + sepLen;
  const titleLen = len(offsetMode, title);

  let urlStart = 0;
  let urlLen = 0;
  if (url) {
    const nowPlayingLine = `${artist} - ${title}`;
    urlStart = len(offsetMode, nowPlayingLine) + len(offsetMode, '\n');
    urlLen = len(offsetMode, url);
  }

  // Build DL+ parameters block
  let dlplus = '';
  dlplus += '##### parameters { #####\n';
  dlplus += 'DL_PLUS=1\n';
  dlplus += 'DL_PLUS_ITEM_TOGGLE=0\n';
  dlplus += 'DL_PLUS_ITEM_RUNNING=1\n';

  // ITEM.ARTIST (tag 4)
  dlplus += `DL_PLUS_TAG=4 0 ${artLen}\n`;

  // ITEM.TITLE (tag 1)
  dlplus += `DL_PLUS_TAG=1 ${titleStart} ${titleLen}\n`;

  if (url && urlLen > 0) {
    // PROGRAMME.HOMEPAGE (tag 39)
    dlplus += `DL_PLUS_TAG=39 ${urlStart} ${urlLen}\n`;
  }

  dlplus += '##### parameters } #####\n';
  dlplus += payload;

  return dlplus;
}

/**
 * Write text file atomically (temp file + rename) only if content changed.
 * This avoids unnecessary disk I/O and inode updates.
 *
 * @param {string} filePath - Absolute path to target file
 * @param {string} content - Content to write
 * @returns {boolean} true if file was written, false if unchanged
 */
export function writeTextFileAtomicIfChanged(filePath, content) {
  // Check if content changed
  let existingContent = '';
  try {
    existingContent = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // File doesn't exist or can't be read, we'll write it
  }

  if (existingContent === content) {
    return false; // No change, skip write
  }

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temp file
  const tempPath = `${filePath}.tmp.${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o644 });
    // Atomic rename
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    // Cleanup temp file if rename failed
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Parse "Artist - Title" string into artist and title components.
 * Handles various formats and edge cases.
 *
 * @param {string} nowPlaying - "Artist - Title" string
 * @returns {{artist: string, title: string}}
 */
export function parseNowPlaying(nowPlaying) {
  const str = (nowPlaying || '').trim();
  if (!str) return { artist: '', title: '' };

  // Split on " - " (most common separator)
  const parts = str.split(' - ');
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(' - ').trim()
    };
  }

  // Fallback: treat entire string as title
  return { artist: '', title: str };
}
