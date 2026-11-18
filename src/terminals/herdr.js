// Herdr connector (herdr-core / hc CLI).
// `ls --json` lists terminals; `get <t> --json` gives the shell pid, the foreground program and an agent status.
// The tty is not in the JSON, so it comes from the shell pid via ps.
import path from 'node:path';
import { run as defaultRun } from '../proc.js';
import { SHELLS } from '../config.js';
import { which } from './which.js';

const bin = (env) => env.AGENT_SNOOZE_HERDR || which('herdr-core', ['~/.local/bin'], env);

// Inside a Herdr terminal these make `send` wrap text in an <hc from=..> tag. Plain typing needs them gone.
function plainEnv(env) {
  const e = { ...env };
  delete e.HC_TERMINAL_ID;
  delete e.HC_SCOPE;
  return e;
}

const prog = (argv) => path.basename((argv && argv[0]) || '').replace(/^-/, '');

/** Local live terminal addresses from `ls --json` (remote ones look like "machine/t3"). */
export function parseHerdrLs(json) {
  let j;
  try { j = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  return (j?.terminals || []).filter((t) => t.state === 'live' && !String(t.address).includes('/')).map((t) => t.address);
}

/** One pane from `get <t> --json` plus the ps table (for the tty). */
export function herdrPaneFromGet(json, procs) {
  let d;
  try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!d?.address || d.state !== 'live') return null;
  const fg = d.foreground || null;
  const st = d.status?.state ?? null;
  const shellPid = d.pid ?? null;
  const tty = (shellPid && procs.get(shellPid)?.tty) || (fg?.pid && procs.get(fg.pid)?.tty) || null;
  return {
    connector: 'herdr',
    id: d.address,
    shellPid,
    foregroundPid: fg?.pid ?? null,
    current: fg ? prog(fg.argv) : null,
    tty,
    label: d.labels?.where || d.title || d.address,
    busy: st && !['idle', 'done'].includes(st) ? `herdr status "${st}"` : null,
  };
}

function get(b, t, run, env) {
  const r = run(b, ['get', t, '--json'], { env: plainEnv(env), timeout: 20_000 });
  return r.ok ? r.stdout : null;
}

export default {
  name: 'herdr',
  canType: true,

  available({ env = process.env } = {}) { return !!bin(env); },

  listPanes({ run = defaultRun, env = process.env, procs } = {}) {
    const b = bin(env);
    if (!b) return [];
    const r = run(b, ['ls', '--json'], { env: plainEnv(env), timeout: 20_000 });
    if (!r.ok) return [];
    const panes = [];
    for (const t of parseHerdrLs(r.stdout)) {
      const out = get(b, t, run, env);
      const p = out && herdrPaneFromGet(out, procs);
      if (p) panes.push(p);
    }
    return panes;
  },

  atShell(pane, { run = defaultRun, env = process.env } = {}) {
    const out = get(bin(env), pane.id, run, env);
    if (!out) return false;
    let d;
    try { d = JSON.parse(out); } catch { return false; }
    if (d.state !== 'live') return false;
    return !d.foreground || SHELLS.includes(prog(d.foreground.argv));
  },

  typeLine(pane, text, { run = defaultRun, env = process.env } = {}) {
    const r = run(bin(env), ['send', pane.id, text], { env: plainEnv(env), timeout: 20_000 });
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
  },
};
