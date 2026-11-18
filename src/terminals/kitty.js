// Kitty connector: remote control over a listen socket.
//   kitty @ --to <socket> ls            -> windows with pid (shell) and foreground_processes
//   kitty @ --to <socket> send-text --match id:N -- <text>
// Needs, in kitty.conf (kitty must be restarted):
//   allow_remote_control yes
//   listen_on unix:/tmp/kitty-snooze.sock     (any name starting with "kitty" in /tmp also works)
// Socket lookup: AGENT_SNOOZE_KITTY_SOCKET, then KITTY_LISTEN_ON, then sockets named kitty* in /tmp.
// Kitty gives no tty; it comes from the shell pid via ps. The pane id is the kitty window id, and the
// socket travels with the pane so typeLine talks to the right kitty instance.
import fs from 'node:fs';
import { run as defaultRun } from '../proc.js';
import { SHELLS } from '../config.js';
import { makeLogger } from '../log.js';
import { which } from './which.js';

const bin = (env) => env.AGENT_SNOOZE_KITTY || which('kitten', ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/kitty.app/Contents/MacOS'], env)
  || which('kitty', ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/kitty.app/Contents/MacOS'], env);
// `kitten @` and `kitty @` take the same arguments.
const remote = (b, sock, args) => ['@', '--to', sock, ...args];

export const HINT = 'kitty remote control is off: add "allow_remote_control yes" and "listen_on unix:/tmp/kitty-snooze.sock" to kitty.conf and restart kitty';

/** Candidate sockets, best first, as `unix:/path` strings. */
export function kittySockets(env = process.env, dir = '/tmp') {
  const out = [];
  const add = (s) => { if (s && !out.includes(s)) out.push(s); };
  add(env.AGENT_SNOOZE_KITTY_SOCKET);
  add(env.KITTY_LISTEN_ON);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^kitty/i.test(f)) continue;
      const p = `${dir}/${f}`;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isSocket()) add(`unix:${p}`);
    }
  } catch { /* no /tmp listing */ }
  return out;
}

/** Parse `kitty @ ls` JSON into panes. procs gives the tty (kitty does not report one). */
export function parseKittyLs(json, sock, procs) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const panes = [];
  for (const osw of j || []) for (const tab of osw.tabs || []) for (const w of tab.windows || []) {
    const fgs = w.foreground_processes || [];
    const nonShell = fgs.find((p) => !SHELLS.includes(String((p.cmdline || [])[0] || '').split('/').pop().replace(/^-/, '')));
    const fg = nonShell || fgs[0] || null;
    const tty = (w.pid && procs?.get(w.pid)?.tty) || (fg?.pid && procs?.get(fg.pid)?.tty) || null;
    panes.push({
      connector: 'kitty', id: String(w.id), sock, tty,
      shellPid: w.pid ?? null, foregroundPid: fg?.pid ?? null,
      current: fg ? String((fg.cmdline || [])[0] || '').split('/').pop().replace(/^-/, '') : null,
      label: w.title || tab.title || `window ${w.id}`,
      busy: null,
    });
  }
  return panes;
}

function lsSock(b, env, run) {
  for (const sock of kittySockets(env)) {
    const r = run(b, remote(b, sock, ['ls']), { env, timeout: 20_000 });
    if (r.ok) return { sock, stdout: r.stdout };
  }
  return null;
}

let hinted = false;

export default {
  name: 'kitty',
  canType: true,

  /** True only when a kitty instance answers on a socket. Never launches kitty. */
  available({ run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    if (!b) return false;
    const running = run('pgrep', ['-x', 'kitty'], { env }).ok;
    if (!running) return false;
    if (lsSock(b, env, run)) return true;
    if (!hinted) { hinted = true; makeLogger({ mode: 'WARN', env })(HINT); }
    return false;
  },

  listPanes({ run = defaultRun, env = process.env, procs } = {}) {
    const b = bin(env);
    const hit = b && lsSock(b, env, run);
    return hit ? parseKittyLs(hit.stdout, hit.sock, procs) : [];
  },

  atShell(pane, { run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    const r = run(b, remote(b, pane.sock, ['ls']), { env, timeout: 20_000 });
    if (!r.ok) return false;
    const w = parseKittyLs(r.stdout, pane.sock, null).find((p) => p.id === pane.id);
    return !!w && (!w.current || SHELLS.includes(w.current));
  },

  typeLine(pane, text, { run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    // "--" keeps the text from being read as flags; \r is Enter.
    const r = run(b, remote(b, pane.sock, ['send-text', '--match', `id:${pane.id}`, '--', text + '\r']), { env, timeout: 20_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
  },
};
