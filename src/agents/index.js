// Agent adapter registry.
//
// An adapter is a plain object:
//   name, label
//   listSessions({ procs, env }) -> [{ agent, pid, sessionId, cwd, status, tty, ... }]
//   lastActivity(session)        -> { ms, source } | null   (newest message time)
//   busyReason(session)          -> string | null           (agent-specific busy signal)
//   recheck(session)             -> string | null           (re-validate right before closing)
//   resumeCommand(session)       -> { argv: [...], cwd }
//
// Optional: session.pids = every pid that --only may match (e.g. codex node wrapper + native binary).
// Gemini drops in here as gemini.js with the same shape.
import claude from './claude.js';
import codex from './codex.js';

export const AGENTS = [claude, codex];
export const getAgent = (name) => AGENTS.find((a) => a.name === name);
