// WezTerm connector.
//   wezterm cli list --format json     -> pane_id, tab_id, window_id, tty_name ("/dev/ttysNNN")
//   wezterm cli send-text --pane-id N --no-paste <text>   (Enter = "\r" at the end of the text)
// `tty_name` IS present in the JSON (build 20240203 verified), so panes map by tty. If a build omits it,
// the pane's tty is unknown and the session falls back to the TTY message.
//
// IMPORTANT: run from outside WezTerm, `wezterm cli` finds no GUI and quietly spawns a wezterm-mux-server,
// which lists panes that are not on screen. So this connector ALWAYS pins WEZTERM_UNIX_SOCKET to a live
// GUI socket (~/.local/share/wezterm/gui-sock-<pid>, pid alive) and reports unavailable when there is none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as defaultRun } from '../proc.js';
import { normTty } from '../tty.js';
import { SHELLS } from '../config.js';
import { which } from './which.js';

const bin = (env) => env.AGENT_SNOOZE_WEZTERM || which('wezterm', ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/WezTerm.app/Contents/MacOS'], env);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** GUI sockets of running WezTerm windows, newest first. */
export function weztermSockets(env = process.env, dir = path.join(os.homedir(), '.local/share/wezterm')) {
  const out = [];
  if (env.WEZTERM_UNIX_SOCKET) out.push(env.WEZTERM_UNIX_SOCKET);
  try {
    const found = fs.readdirSync(dir).map((f) => /^gui-sock-(\d+)$/.exec(f)).filter(Boolean)
      .filter((m) => alive(Number(m[1])))
      .map((m) => ({ p: path.join(dir, m[0]), t: fs.statSync(path.join(dir, m[0])).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const f of found) if (!out.includes(f.p)) out.push(f.p);
  } catch { /* no wezterm dir */ }
  return out;
}

const penv = (env, sock) => ({ ...env, WEZTERM_UNIX_SOCKET: sock });

export function parseWeztermList(json, sock) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  return (j || []).map((p) => ({
    connector: 'wezterm', id: String(p.pane_id), sock,
    tty: normTty(p.tty_name), shellPid: null, foregroundPid: null, current: null,
    cwd: p.cwd || null,
    label: p.title || p.tab_title || `pane ${p.pane_id}`,
    busy: null,
  }));
}

export default {
  name: 'wezterm',
  canType: true,

  available({ run = defaultRun, env = process.env } = {}) {
    if (!bin(env)) return false;
    if (!run('pgrep', ['-x', 'wezterm-gui'], { env }).ok) return false;
    return weztermSockets(env).length > 0;
  },

  listPanes({ run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    if (!b) return [];
    const panes = [];
    for (const sock of weztermSockets(env)) {
      const r = run(b, ['cli', 'list', '--format', 'json'], { env: penv(env, sock), timeout: 20_000 });
      if (r.ok) panes.push(...parseWeztermList(r.stdout, sock));
    }
    return panes;
  },

  atShell(pane, { run = defaultRun, env = process.env } = {}) {
    // Same rule as the AppleScript terminals: every foreground process on the tty is a shell.
    if (!pane.tty) return false;
    const r = run('ps', ['-t', pane.tty.replace('/dev/', ''), '-o', 'stat=,comm='], { env });
    if (!r.ok) return false;
    const fg = r.stdout.split('\n').map((l) => /^\s*(\S+)\s+(.+)$/.exec(l)).filter((m) => m && m[1].includes('+'))
      .map((m) => m[2].trim().split('/').pop().replace(/^-/, ''));
    return fg.length > 0 && fg.every((n) => SHELLS.includes(n));
  },

  typeLine(pane, text, { run = defaultRun, env = process.env } = {}) {
    const r = run(bin(env), ['cli', 'send-text', '--pane-id', pane.id, '--no-paste', text + '\r'], { env: penv(env, pane.sock), timeout: 20_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
  },
};
