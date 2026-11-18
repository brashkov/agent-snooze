// Shared AppleScript plumbing for the macOS GUI terminals (iTerm2, Terminal.app).
import { run as defaultRun } from '../proc.js';
import { normTty } from '../tty.js';
import { SHELLS } from '../config.js';
import { makeLogger } from '../log.js';

export const US = '\u001f';

/** Is the process running? Plain pgrep: never launches the app and needs no Automation permission. */
export function appRunning(procName, { run = defaultRun, env = process.env } = {}) {
  if (process.platform !== 'darwin' && !env.AGENT_SNOOZE_FORCE_OSA) return false;
  return run('pgrep', ['-x', procName], { env }).ok;
}

/** Run an AppleScript with argv. Script text is passed whole; user text only ever travels as argv, never inside the script. */
export function osa(script, args = [], { run = defaultRun, env = process.env } = {}) {
  return run('osascript', ['-e', script, ...args], { env, timeout: 20_000 });
}

/** macOS says -1743 / "Not authorized to send Apple events" when Automation permission is denied. */
export const isDenied = (stderr) => /-1743|not authori[sz]ed to send apple events/i.test(stderr || '');

export const DENIED_MSG = (app) => `macOS Automation permission denied for ${app} (System Settings > Privacy & Security > Automation)`;

const warned = new Set();
export function warnDenied(app, env) {
  if (warned.has(app)) return;
  warned.add(app);
  makeLogger({ mode: 'WARN', env })(`${DENIED_MSG(app)}; falling back to tty message`);
}

/** Parse the listing both scripts print: one line per tab/session, fields split by US: winId US tty US busy US title. */
export function parseOsaPanes(stdout, connector) {
  const panes = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [win, ttyRaw, busy, title] = line.split(US);
    const tty = normTty(ttyRaw);
    if (!tty) continue;
    panes.push({
      connector, id: tty, tty, winId: win || null, shellPid: null, current: null,
      label: (title || '').trim() || tty,
      busy: busy === 'true' ? 'terminal reports a running command' : null,
    });
  }
  return panes;
}

/** Back at a shell prompt = every process in the tty's foreground group (stat has '+') is a shell. */
export function ttyAtShell(tty, { run = defaultRun, env = process.env } = {}) {
  const t = normTty(tty);
  if (!t) return false;
  const r = run('ps', ['-t', t.replace('/dev/', ''), '-o', 'stat=,comm='], { env });
  return r.ok && atShellFromPs(r.stdout);
}
export function atShellFromPs(stdout) {
  const fg = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\S+)\s+(.+)$/.exec(line);
    if (m && m[1].includes('+')) fg.push(m[2].trim().split('/').pop().replace(/^-/, ''));
  }
  return fg.length > 0 && fg.every((n) => SHELLS.includes(n));
}

/** Shared typeLine: run `script` with argv [tty, text]; it prints "ok" or "notfound". */
export function typeViaOsa(app, script, pane, text, { run, env }) {
  const r = osa(script, [pane.tty, text], { run, env });
  if (!r.ok) {
    if (isDenied(r.stderr)) { warnDenied(app, env); return { ok: false, error: DENIED_MSG(app) }; }
    return { ok: false, error: r.stderr.trim() };
  }
  return r.stdout.trim() === 'ok' ? { ok: true } : { ok: false, error: `no ${app} tab with tty ${pane.tty}` };
}

export function listViaOsa(app, connector, script, { run, env }) {
  const r = osa(script, [], { run, env });
  if (!r.ok) {
    if (isDenied(r.stderr)) warnDenied(app, env);
    return [];
  }
  return parseOsaPanes(r.stdout, connector);
}
