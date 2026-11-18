// OpenAI Codex CLI adapter (checked against codex-cli 0.154).
// Processes:   npm installs run `node .../bin/codex` (a thin wrapper that forwards SIGINT/SIGTERM/SIGHUP)
//              with the native Rust binary `.../vendor/<triple>/bin/codex` as its child. Other installs
//              (brew, cargo) run the native binary directly. The session pid is the outermost one.
// Transcripts: <home>/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl, held open by the native binary
//              while the session lives (closed ones may later be compressed to .jsonl.zst). There is no
//              pidfile, so pid -> session comes from `lsof` (one call for all codex pids).
//              First line is `session_meta` (id, cwd, source: cli | exec | vscode ...).
// Busy:        a turn is running when the newest task_started has no later task_complete/turn_aborted.
// Resume:      codex resume <uuid>, run in the session's cwd. Same thread id, same rollout file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastActivity } from '../idle.js';
import { run as defaultRun } from '../proc.js';

export const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_RE = new RegExp(`/sessions/.*rollout-[^/]*?(${UUID})\\.jsonl$`, 'i');
const TAIL_BYTES = 256 * 1024;

/** Is this ps row the native codex binary? (npm vendor path, or a plain `codex` executable) */
export function isCodexBinary(row) {
  if (!row) return false;
  return row.name === 'codex' || /@openai\/codex.*\/bin\/codex$/.test(row.comm);
}

/**
 * Codex sessions in the process table: native binaries on a tty whose parent is not another codex.
 * pid = the node wrapper when there is one (it forwards SIGTERM), else the binary itself.
 */
export function findCodexProcs(procs) {
  const out = [];
  for (const row of procs.values()) {
    if (!isCodexBinary(row) || !row.tty) continue;
    const parent = procs.get(row.ppid);
    if (isCodexBinary(parent)) continue; // nested codex, counted via its parent
    const wrapped = parent && parent.name === 'node' && parent.tty === row.tty;
    out.push({ pid: wrapped ? parent.pid : row.pid, binPid: row.pid, tty: row.tty });
  }
  return out;
}

/** Parse `lsof -F pn` output into Map<pid, rolloutPath> (first live .jsonl rollout per pid). */
export function parseLsofRollouts(stdout) {
  const map = new Map();
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid && !map.has(pid) && ROLLOUT_RE.test(line.slice(1))) map.set(pid, line.slice(1));
  }
  return map;
}

export function openRollouts(pids, runFn = defaultRun) {
  if (!pids.length) return new Map();
  // lsof exits 1 when any pid is gone; the output is still good.
  const r = runFn('lsof', ['-nP', '-a', '-p', pids.join(','), '-d', '^txt', '-F', 'pn']);
  return parseLsofRollouts(r.stdout || '');
}

/** session_meta from the first line of a rollout. */
export function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    const j = JSON.parse(first);
    if (j?.type !== 'session_meta') return null;
    const p = j.payload || {};
    return { id: p.id || p.session_id || null, cwd: p.cwd || null, source: p.source || null };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Busy reason from rollout text: newest turn event decides. */
export function turnState(text) {
  let state = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"event_msg"')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const t = j?.payload?.type;
    if (t === 'task_started') state = 'running';
    else if (t === 'task_complete' || t === 'turn_aborted') state = 'done';
  }
  return state;
}

function tail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Thread name from session_index.jsonl (newest entry wins), or null. */
export function threadName(home, id) {
  let text;
  try { text = fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8'); } catch { return null; }
  let name = null;
  for (const line of text.split('\n')) {
    if (!line.includes(id)) continue;
    try { const j = JSON.parse(line); if (j.id === id && j.thread_name) name = j.thread_name; } catch { /* skip */ }
  }
  return name;
}

function busyFromRollout(file) {
  const text = tail(file);
  if (text === null) return 'rollout unreadable';
  return turnState(text) === 'running' ? 'turn in progress' : null;
}

export default {
  name: 'codex',
  label: 'Codex CLI',

  /** Live interactive codex sessions, each mapped to the rollout its native binary holds open. */
  listSessions({ procs, env = process.env, run = defaultRun }) {
    const home = codexHome(env);
    const found = findCodexProcs(procs);
    if (!found.length) return [];
    const rollouts = openRollouts(found.map((f) => f.binPid), run);
    const out = [];
    for (const f of found) {
      const file = rollouts.get(f.binPid);
      if (!file) continue; // no prompt sent yet: nothing to resume
      const meta = readMeta(file) || {};
      if (meta.source === 'exec') continue; // `codex exec` is non-interactive
      const sessionId = meta.id || ROLLOUT_RE.exec(file)?.[1];
      if (!sessionId) continue;
      out.push({
        agent: 'codex', pid: f.pid, pids: [f.pid, f.binPid], binPid: f.binPid, sessionId, tty: f.tty,
        cwd: meta.cwd || null, status: null, name: threadName(home, sessionId), rollout: file, home,
      });
    }
    return out;
  },

  lastActivity(session) {
    return session.rollout ? lastActivity(session.rollout) : null;
  },

  busyReason(session) {
    return busyFromRollout(session.rollout);
  },

  /** Right before closing: the binary still holds the same rollout, and no turn started meanwhile. */
  recheck(session, runFn = defaultRun) {
    const now = openRollouts([session.binPid], runFn).get(session.binPid);
    if (!now) return 'rollout no longer open';
    if (now !== session.rollout) return 'session changed';
    return busyFromRollout(session.rollout);
  },

  resumeCommand(session) {
    return { argv: ['codex', 'resume', session.sessionId], cwd: session.cwd || os.homedir() };
  },
};
