// TTY naming and the write-to-tty fallback.
import fs from 'node:fs';

/**
 * Normalise a tty as printed by ps, tty(1), tmux or a connector to a device path.
 * 'ttys055' | '/dev/ttys055' | 's055' -> '/dev/ttys055'; 'pts/3' -> '/dev/pts/3'; '??' -> null.
 */
export function normTty(s) {
  if (!s) return null;
  let t = String(s).trim();
  if (!t || t === '?' || t === '??' || t === '-' || t === 'not a tty') return null;
  if (t.startsWith('/dev/')) return t;
  if (/^s\d+$/.test(t)) t = 'tty' + t; // old macOS ps short form
  return '/dev/' + t;
}

/** File-name-safe key for a tty device: '/dev/pts/3' -> 'pts_3'. */
export function ttyKey(dev) {
  const d = normTty(dev);
  return d ? d.slice(5).replace(/\//g, '_') : null;
}

/** Write a message to another terminal's screen (output only, never input). */
export function writeToTty(dev, text) {
  let fd;
  try {
    fd = fs.openSync(dev, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, text);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
