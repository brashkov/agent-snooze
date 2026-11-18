// cmux connector (manaflow-ai cmux).
//   cmux tree --json                                -> tabs/surfaces; each terminal surface carries its tty
//   cmux send --surface X <text>  +  cmux send-key --surface X enter
//
// Socket limit: cmux's socket defaults to mode "cmuxOnly": only processes spawned INSIDE a cmux terminal may
// connect. From anywhere else (launchd, cron, another terminal) every call fails with "Broken pipe". So:
//   - available() is true only when running inside cmux (CMUX_SURFACE_ID or CMUX_WORKSPACE_ID set) or when the
//     user started cmux with CMUX_SOCKET_MODE=allowAll and sets AGENT_SNOOZE_CMUX_ALLOW_ALL=1.
//   - otherwise available() is false and the log gets a one-time hint. Sessions in cmux then fall back to the
//     TTY message (run `agent-snooze wake` in the tab), which needs no socket.
// The tree JSON shape was NOT observable from outside cmux (cmuxOnly), so the parser is tolerant: it walks the
// whole tree for objects that have a `tty` string plus an id/ref, and keeps a title when one is present.
import { run as defaultRun } from '../proc.js';
import { normTty } from '../tty.js';
import { SHELLS } from '../config.js';
import { makeLogger } from '../log.js';
import { which } from './which.js';

const bin = (env) => env.AGENT_SNOOZE_CMUX || which('cmux', ['/Applications/cmux.app/Contents/Resources/bin', '/opt/homebrew/bin', '/usr/local/bin'], env);

export const HINT = 'cmux sessions found but its socket is cmuxOnly: run agent-snooze from a tab inside cmux (or start cmux with CMUX_SOCKET_MODE=allowAll and set AGENT_SNOOZE_CMUX_ALLOW_ALL=1)';

export function insideCmux(env) {
  return !!(env.CMUX_SURFACE_ID || env.CMUX_WORKSPACE_ID || env.AGENT_SNOOZE_CMUX_ALLOW_ALL);
}

/** Walk any JSON and collect terminals: objects with a tty string and an id or ref. */
export function parseCmuxTree(json) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const panes = [];
  const seen = new Set();
  const walk = (n, ctx) => {
    if (Array.isArray(n)) { n.forEach((x) => walk(x, ctx)); return; }
    if (!n || typeof n !== 'object') return;
    const next = { ...ctx };
    for (const k of ['title', 'name']) if (typeof n[k] === 'string' && n[k]) next.title = n[k];
    const tty = typeof n.tty === 'string' ? normTty(n.tty) : null;
    const id = n.ref || n.id || n.surface_id || n.surface;
    if (tty && id && !seen.has(String(id))) {
      seen.add(String(id));
      panes.push({
        connector: 'cmux', id: String(id), tty, shellPid: null, foregroundPid: null, current: null,
        label: (typeof n.title === 'string' && n.title) || next.title || String(id), busy: null,
      });
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, next);
  };
  walk(j, {});
  return panes;
}

let hinted = false;

export default {
  name: 'cmux',
  canType: true,

  /** Never launches cmux and never connects from outside it (the call would just break the pipe). */
  available({ run = defaultRun, env = process.env } = {}) {
    if (!bin(env)) return false;
    // Experimental: not yet verified live (2026-11-18). Off unless AGENT_SNOOZE_EXPERIMENTAL_CMUX=1;
    // cmux sessions still get the TTY message fallback.
    if (env.AGENT_SNOOZE_EXPERIMENTAL_CMUX !== '1') return false;
    if (insideCmux(env)) return true;
    if (!hinted && run('pgrep', ['-x', 'cmux'], { env }).ok) { hinted = true; makeLogger({ mode: 'WARN', env })(HINT); }
    return false;
  },

  listPanes({ run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    if (!b) return [];
    const r = run(b, ['tree', '--json'], { env, timeout: 20_000 });
    return r.ok ? parseCmuxTree(r.stdout) : [];
  },

  atShell(pane, { run = defaultRun, env = process.env } = {}) {
    if (!pane.tty) return false;
    const r = run('ps', ['-t', pane.tty.replace('/dev/', ''), '-o', 'stat=,comm='], { env });
    if (!r.ok) return false;
    const fg = r.stdout.split('\n').map((l) => /^\s*(\S+)\s+(.+)$/.exec(l)).filter((m) => m && m[1].includes('+'))
      .map((m) => m[2].trim().split('/').pop().replace(/^-/, ''));
    return fg.length > 0 && fg.every((n) => SHELLS.includes(n));
  },

  typeLine(pane, text, { run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    const a = run(b, ['send', '--surface', pane.id, '--', text], { env, timeout: 20_000 });
    if (!a.ok) return { ok: false, error: a.stderr.trim() };
    const e = run(b, ['send-key', '--surface', pane.id, 'enter'], { env, timeout: 20_000 });
    return e.ok ? { ok: true } : { ok: false, error: e.stderr.trim() };
  },
};
