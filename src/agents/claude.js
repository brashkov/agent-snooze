// Claude Code adapter.
// Live sessions: <home>/sessions/<pid>.json  (pid, sessionId, cwd, status, kind)
// Transcripts:   <home>/projects/<slug>/<sessionId>.jsonl
// Resume:        claude --resume <sessionId>, run in the session's cwd.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastActivity } from '../idle.js';

export const claudeHome = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Parse one pidfile. Returns null when it is not a usable interactive session record. */
export function parsePidfile(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || !Number.isInteger(j.pid) || typeof j.sessionId !== 'string' || !j.sessionId) return null;
  if (j.kind && j.kind !== 'interactive') return null; // skip -p / SDK runs
  return { pid: j.pid, sessionId: j.sessionId, cwd: j.cwd || null, status: j.status ?? null, name: j.name || null };
}

/** Is this ps row a Claude Code process? Guards against pid reuse by a stale pidfile. */
export function isClaudeProcess(row) {
  if (!row) return false;
  return row.name === 'claude' || /(^|\/)claude(\.js|\.exe)?$/.test(row.comm) || /claude-code/.test(row.comm);
}

export function findTranscript(home, sessionId) {
  const root = path.join(home, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export default {
  name: 'claude',
  label: 'Claude Code',

  /** Live sessions: pidfiles whose pid is alive and really is claude. */
  listSessions({ procs, env = process.env }) {
    const home = claudeHome(env);
    const dir = path.join(home, 'sessions');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
    const out = [];
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const s = parsePidfile(text);
      if (!s) continue;
      const row = procs.get(s.pid);
      if (!isClaudeProcess(row)) continue; // dead pid or reused by something else
      out.push({ agent: 'claude', ...s, tty: row.tty, home });
    }
    return out;
  },

  /** { ms, source } of the newest transcript message, or null. */
  lastActivity(session) {
    const tr = findTranscript(session.home, session.sessionId);
    return tr ? lastActivity(tr) : null;
  },

  /** Agent-specific busy signal. Anything other than "idle" (busy, waiting, shell...) counts as busy. */
  busyReason(session) {
    if (session.status && session.status !== 'idle') return `agent status "${session.status}"`;
    return null;
  },

  /** Re-read the pidfile right before acting: same session, still idle. */
  recheck(session) {
    try {
      const s = parsePidfile(fs.readFileSync(path.join(session.home, 'sessions', `${session.pid}.json`), 'utf8'));
      if (!s || s.sessionId !== session.sessionId) return 'session changed';
      if (s.status && s.status !== 'idle') return `agent status "${s.status}"`;
      return null;
    } catch { return 'pidfile gone'; }
  },

  resumeCommand(session) {
    return { argv: ['claude', '--resume', session.sessionId], cwd: session.cwd || os.homedir() };
  },
};
