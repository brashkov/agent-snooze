// tmux connector: list panes with their tty, type into a pane by id (no focus needed).
import { run as defaultRun } from '../proc.js';
import { normTty } from '../tty.js';
import { SHELLS } from '../config.js';
import { which } from './which.js';

const SEP = '\u001f';
const FORMAT = ['#{pane_id}', '#{pane_pid}', '#{pane_tty}', '#{pane_current_command}', '#{session_name}:#{window_index}.#{pane_index}'].join(SEP);

const bin = (env) => env.AGENT_SNOOZE_TMUX || which('tmux', ['/opt/homebrew/bin', '/usr/local/bin'], env);

/** Parse `tmux list-panes -a -F FORMAT` output. */
export function parseTmuxPanes(stdout) {
  const panes = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [id, pid, tty, cmd, where] = line.split(SEP);
    if (!id?.startsWith('%')) continue;
    panes.push({ connector: 'tmux', id, shellPid: Number(pid) || null, tty: normTty(tty), current: cmd || null, label: where || id, busy: null });
  }
  return panes;
}

export default {
  name: 'tmux',
  canType: true,

  available({ env = process.env } = {}) { return !!bin(env); },

  listPanes({ run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    if (!b) return [];
    const r = run(b, ['list-panes', '-a', '-F', FORMAT], { env });
    return r.ok ? parseTmuxPanes(r.stdout) : [];
  },

  atShell(pane, { run = defaultRun, env = process.env } = {}) {
    const r = run(bin(env), ['display-message', '-p', '-t', pane.id, '#{pane_current_command}'], { env });
    return r.ok && SHELLS.includes(r.stdout.trim().replace(/^-/, ''));
  },

  typeLine(pane, text, { run = defaultRun, env = process.env } = {}) {
    const b = bin(env);
    const a = run(b, ['send-keys', '-t', pane.id, '-l', text], { env });
    if (!a.ok) return { ok: false, error: a.stderr.trim() };
    const e = run(b, ['send-keys', '-t', pane.id, 'Enter'], { env });
    return e.ok ? { ok: true } : { ok: false, error: e.stderr.trim() };
  },
};
