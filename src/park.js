// Parked state lives per TTY in <state>/parked/<ttykey>.json.
// Three ways to show the wake prompt, best first:
//   1. hook: the shell has `agent-snooze init` loaded; its next prompt runs `agent-snooze wake`
//   2. connector: type the wake command into the pane (Herdr, tmux, ...)
//   3. tty: write a 💤 message to the tty; the user runs `agent-snooze wake`
import fs from 'node:fs';
import path from 'node:path';
import { parkedDir, hooksDir, SHELL_WAIT_MS } from './config.js';
import { ttyKey, writeToTty } from './tty.js';
import { ancestors, alive, sleepMs, waitFor } from './proc.js';
import { closeProcess } from './close.js';
import { connectorFor } from './terminals/index.js';
import { selfCommand } from './invoke.js';

export { BIN, selfCommand } from './invoke.js';
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** Single-quote for fish: inside '...' only \\ and \' are special. */
export const fishQ = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, `\\'`)}'`;

/** Old Node-prompt line. Kept for reference only: tabs parked by older versions have it typed already. */
export const wakeCommandLine = () => `eval "$(${selfCommand()} wake --emit)"`;

const SHELL_NAMES = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh']);
/** 'fish' or 'posix' (zsh/bash/sh). The tab's shell: the pane's shell pid, else the agent's nearest shell ancestor, else bash. */
export function shellKind(session, pane, procs) {
  const pick = (name) => (SHELL_NAMES.has(name) ? (name === 'fish' ? 'fish' : 'posix') : null);
  const direct = pane?.shellPid && procs?.get(pane.shellPid);
  if (direct && pick(direct.name)) return pick(direct.name);
  if (procs && session?.pid) {
    for (const pid of ancestors(procs, session.pid)) {
      if (pid === session.pid) continue;
      const k = pick(procs.get(pid)?.name);
      if (k) return k;
    }
  }
  return 'posix';
}

/** The 💤 text, one line: control characters (newline, escape) become spaces. */
export function sleepText(rec) {
  const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return `💤 ${clean(rec.label)} (${clean(rec.agent)}) is asleep (idle ${clean(rec.idleDays)}d). Press Enter to resume.`;
}

/**
 * The line typed into a sleeping tab (or run by the shell hook). The shell does the waiting with builtins only
 * (printf + read), so no Node process sits in RAM; Node starts after Enter to hand back the resume command.
 * The text is computed now and embedded, quoted for the target shell.
 */
export function wakeTypedLine(rec, kind = 'posix', cmd = selfCommand()) {
  const clear = '\\033[H\\033[2J\\033[3J%s\\n';
  if (kind === 'fish') {
    return `printf '${clear}' ${fishQ(sleepText(rec))}; read -l _snooze; eval (${cmd} wake --emit --now --shell fish)`;
  }
  return `printf '${clear}' ${q(sleepText(rec))}; read -r _; eval "$(${cmd} wake --emit --now)"`;
}

export function parkedFile(key, env) { return path.join(parkedDir(env), `${key}.json`); }

export function writeParked(rec, env) {
  const f = parkedFile(rec.ttyKey, env);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(rec, null, 1));
  fs.renameSync(f + '.tmp', f);
}
export function readParked(key, env) {
  try { return JSON.parse(fs.readFileSync(parkedFile(key, env), 'utf8')); } catch { return null; }
}
export function removeParked(key, env) {
  try { fs.unlinkSync(parkedFile(key, env)); } catch { /* already gone */ }
}
export function listParked(env) {
  let files = [];
  try { files = fs.readdirSync(parkedDir(env)).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readParked(f.slice(0, -5), env)).filter(Boolean);
}

/** The hooked shell that owns this session's tty: marker pid alive, same tty, and a parent of the agent. */
export function hookShellFor(session, procs, env) {
  const key = ttyKey(session.tty);
  if (!key) return null;
  let pid;
  try { pid = Number(fs.readFileSync(path.join(hooksDir(env), key), 'utf8').trim()); } catch { return null; }
  const row = procs.get(pid);
  if (!row || row.tty !== session.tty) return null;
  return ancestors(procs, session.pid).has(pid) ? pid : null;
}

export function parkMethod(session, pane, procs, env) {
  if (hookShellFor(session, procs, env)) return 'hook';
  if (pane && connectorFor(pane)?.canType) return pane.connector;
  return 'tty';
}

function ttyMessage(rec) {
  return `\r\n\x1b[1m💤 ${rec.label} is asleep (idle ${rec.idleDays}d).\x1b[0m Run \x1b[1magent-snooze wake\x1b[0m to resume it.\r\n`;
}

/**
 * Snooze one evaluated candidate. Returns { ok, how, method, ms, freedMb } and logs every step.
 */
export function snooze(c, { procs, env = process.env, log, run, timeoutMs }) {
  const { session, pane, adapter } = c;
  const tag = `${session.agent} pid ${session.pid} ${session.sessionId.slice(0, 8)}${pane ? ` [${pane.connector} ${pane.id}]` : ''}`;

  // Re-check right before acting.
  if (!alive(session.pid)) { log(`ABORT ${tag}: process already gone`); return { ok: false }; }
  const changed = adapter.recheck?.(session);
  if (changed) { log(`ABORT ${tag}: ${changed}`); return { ok: false }; }

  const key = ttyKey(session.tty);
  const method = parkMethod(session, pane, procs, env);
  const resume = adapter.resumeCommand(session);
  const rec = {
    v: 1, ttyKey: key, tty: session.tty, agent: session.agent, sessionId: session.sessionId,
    cwd: resume.cwd, resume, label: session.name || pane?.label || session.sessionId.slice(0, 8),
    idleDays: Math.round(c.idle ?? 0), pid: session.pid, pane: pane ? { connector: pane.connector, id: pane.id } : null,
    method, parkedAt: new Date().toISOString(),
  };
  // Written before closing, so a hooked shell finds it on its very next prompt.
  writeParked(rec, env);

  const closed = closeProcess(session.pid, { timeoutMs });
  if (!closed.ok) {
    removeParked(key, env);
    log(`FAIL ${tag}: still alive ${Math.round(closed.ms / 1000)}s after SIGTERM; left alone`);
    return { ok: false };
  }
  const slow = closed.ms > 5000 ? ` (slow exit ${Math.round(closed.ms / 1000)}s)` : '';

  let shown = method;
  if (method !== 'hook' && method !== 'tty') {
    const conn = connectorFor(pane);
    const ctx = { run, env };
    if (waitFor(() => conn.atShell(pane, ctx), SHELL_WAIT_MS)) {
      sleepMs(700); // let the shell draw its prompt
      const t = conn.typeLine(pane, wakeTypedLine(rec, shellKind(session, pane, procs)), ctx);
      if (!t.ok) { log(`WARN ${tag}: typing wake command failed (${t.error}); using tty message`); shown = 'tty'; }
    } else {
      log(`WARN ${tag}: pane not back at a shell after ${SHELL_WAIT_MS / 1000}s; using tty message`);
      shown = 'tty';
    }
  }
  if (shown === 'tty' && !writeToTty(session.tty, ttyMessage(rec))) log(`WARN ${tag}: could not write to ${session.tty}`);
  if (shown !== method) writeParked({ ...rec, method: shown }, env);

  log(`SNOOZED ${tag} via SIGTERM${slow}, parked=${shown}, freed ~${c.memMb}MB, idle ${(c.idle ?? 0).toFixed(1)}d`);
  return { ok: true, method: shown, ms: closed.ms, freedMb: c.memMb };
}
