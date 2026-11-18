// Terminal connector registry.
//
// A connector is a plain object:
//   name, canType
//   available({ env })                     -> bool   (CLI present)
//   listPanes({ run, env, procs })         -> [{ connector, id, tty, shellPid, foregroundPid?, current, label, busy }]
//   atShell(pane, { run, env })            -> bool   (the pane is back at a shell prompt)
//   typeLine(pane, text, { run, env })     -> { ok, error? }   (type text + Enter, no focus needed)
//
// iTerm2, Terminal.app, Kitty, WezTerm and cmux drop in here with the same shape.
import herdr from './herdr.js';
import tmux from './tmux.js';
import iterm2 from './iterm2.js';
import terminalApp from './terminal-app.js';
import kitty from './kitty.js';
import wezterm from './wezterm.js';
import cmux from './cmux.js';

export const TERMINALS = [herdr, tmux, iterm2, terminalApp, kitty, wezterm, cmux];

/** Pick the pane that owns a session: exact foreground pid first, then tty. */
export function findPane(session, panes) {
  return panes.find((p) => p.foregroundPid && p.foregroundPid === session.pid)
    || (session.tty ? panes.find((p) => p.tty && p.tty === session.tty) : null)
    || null;
}

export function listAllPanes(ctx) {
  const panes = [];
  for (const t of TERMINALS) {
    if (!t.available(ctx)) continue;
    try { panes.push(...t.listPanes(ctx)); } catch { /* a broken connector never blocks the others */ }
  }
  return panes;
}

export const connectorFor = (pane) => TERMINALS.find((t) => t.name === pane?.connector) || null;
