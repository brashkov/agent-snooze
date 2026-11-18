// Discovery + decision: which live agent sessions may be snoozed, and why the others are skipped.
// `evaluate` is pure (everything injected) so the safety rules are unit tested.
import { ancestors, descendants } from './proc.js';
import { findPane } from './terminals/index.js';
import { idleDays } from './idle.js';
import { BUSY_CPU_PERCENT, SHELLS } from './config.js';

/** Every pid the tool must never touch: itself and all its parents (the agent session that ran it). */
export function protectedPids(procs, selfPid = process.pid) {
  return ancestors(procs, selfPid);
}

/** --only accepts a pid, a pane id (tmux %3, herdr t5) or a session id prefix. */
export function matchesOnly(only, session, pane) {
  if (!only) return true;
  const o = String(only);
  return String(session.pid) === o || (session.pids || []).some((p) => String(p) === o) || (pane && pane.id === o) || (o.length >= 6 && session.sessionId.startsWith(o));
}

/**
 * @returns {Array<{session, pane, adapter, idle, memMb, ok: boolean, reason: string}>}
 */
export function evaluate({ sessions, panes, procs, adapters, protect, selfTty = null, days, only = null, now = Date.now() }) {
  const out = [];
  for (const session of sessions) {
    const pane = findPane(session, panes);
    if (!matchesOnly(only, session, pane)) continue;
    const adapter = adapters[session.agent];
    const kids = descendants(procs, session.pid);
    const memKb = [session.pid, ...kids].reduce((a, p) => a + (procs.get(p)?.rssKb || 0), 0);
    const r = { session, pane, adapter, idle: null, memMb: Math.round(memKb / 1024), ok: false, reason: '' };
    out.push(r);
    const skip = (why) => { r.reason = why; };

    // Safety first: never the session running this tool.
    if (protect.has(session.pid) || (selfTty && session.tty === selfTty)) { skip('this is the session running agent-snooze'); continue; }
    if (!session.tty) { skip('no terminal attached'); continue; }

    const la = adapter.lastActivity(session);
    if (!la) { skip('no transcript'); continue; }
    r.idle = idleDays(la.ms, now);
    if (r.idle < days) { skip(`active (idle ${r.idle.toFixed(1)}d < ${days}d)`); continue; }

    const agentBusy = adapter.busyReason(session);
    if (agentBusy) { skip(`busy (${agentBusy})`); continue; }
    if (pane?.busy) { skip(`busy (${pane.busy})`); continue; }
    const shells = [...kids].filter((k) => SHELLS.includes(procs.get(k)?.name));
    if (shells.length) { skip(`busy (shell child running: ${shells.join(',')})`); continue; }
    const cpu = [session.pid, ...kids].reduce((a, p) => a + (procs.get(p)?.cpu || 0), 0);
    if (cpu > BUSY_CPU_PERCENT) { skip(`busy (cpu ${cpu.toFixed(1)}%)`); continue; }

    r.ok = true;
    r.reason = 'idle';
  }
  return out;
}
