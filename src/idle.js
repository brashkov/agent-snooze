// Last activity = newest "timestamp" inside a JSONL transcript.
// File mtime is unreliable: transcripts get touched with no new content.
import fs from 'node:fs';

const TAIL_BYTES = 512 * 1024;

/** Newest ISO timestamp (ms epoch) found in JSONL text, or null. Partial/invalid lines are skipped. */
export function newestTimestamp(text) {
  let best = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"timestamp"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj?.timestamp;
    if (typeof ts !== 'string') continue;
    const v = Date.parse(ts);
    if (Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/** Read only the tail of a big transcript. Returns { ms, source } or null if unreadable. */
export function lastActivity(file, tailBytes = TAIL_BYTES) {
  let fd;
  try {
    const { size, mtimeMs } = fs.statSync(file);
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    const ms = newestTimestamp(buf.toString('utf8'));
    return ms === null ? { ms: mtimeMs, source: 'mtime' } : { ms, source: 'transcript' };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export const idleDays = (ms, now = Date.now()) => (now - ms) / 86_400_000;
