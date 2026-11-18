import { readProcs, run } from './proc.js';
import { makeLogger } from './log.js';
import { AGENTS } from './agents/index.js';
import { listAllPanes } from './terminals/index.js';
import { evaluate, protectedPids } from './discover.js';
import { snooze, listParked, parkMethod } from './park.js';
import { wake, currentTty, resumeLine } from './wake.js';
import { initSnippet } from './hook.js';
import { DEFAULT_DAYS } from './config.js';
import { selfCommandInfo } from './invoke.js';

const HELP = `agent-snooze: close idle AI coding-agent sessions and park the tab on a resume prompt

Usage:
  agent-snooze [--days N] [--only <pid|pane|session>]   dry run: show what would be snoozed
  agent-snooze --apply [--days N] [--only ...]           snooze idle sessions
  agent-snooze wake [--now] [--emit]                     resume the session parked on this terminal
                                                         (--emit: print the resume command for eval;
                                                         --shell fish: quote for fish; --lazy: print the shell-only wait line)
  agent-snooze list                                      show parked sessions
  agent-snooze init zsh|bash|fish                        print the shell hook (add to your rc file)

Options:
  --days N     idle threshold in days (default ${DEFAULT_DAYS}); idle = newest message in the transcript
  --only X     limit to one pid, pane id (tmux %3, herdr t5) or session id prefix
  --apply      actually close and park (default is a dry run)
`;

export function parseArgs(argv) {
  const o = { cmd: 'snooze', apply: false, days: DEFAULT_DAYS, only: null, tty: null, now: false, emit: false, lazy: false, wakeShell: 'posix', shell: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--days') { o.days = Number(val()); if (!Number.isFinite(o.days) || o.days < 0) throw new Error('--days must be a number >= 0'); }
    else if (a === '--only') o.only = val();
    else if (a === '--tty') o.tty = val();
    else if (a === '--now') o.now = true;
    else if (a === '--emit') o.emit = true;
    else if (a === '--lazy') o.lazy = true;
    else if (a === '--shell') { o.wakeShell = val() === 'fish' ? 'fish' : 'posix'; }
    else if (a === '-h' || a === '--help' || a === 'help') o.cmd = 'help';
    else if (['wake', 'list', 'init'].includes(a) && o.cmd === 'snooze') o.cmd = a;
    else if (o.cmd === 'init' && !o.shell) o.shell = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function snoozeCmd(o) {
  const mode = o.apply ? 'APPLY' : 'DRY';
  const log = makeLogger({ mode });
  const env = process.env;
  const self = selfCommandInfo(); // warns on stderr when run from an npx cache
  if (o.apply && self.warning) log(`WARN running from a temporary npx cache; install with: npm i -g agent-snooze`);
  const procs = readProcs();
  const ctx = { run, env, procs };
  const sessions = AGENTS.flatMap((a) => { try { return a.listSessions(ctx); } catch { return []; } });
  const panes = listAllPanes(ctx);
  const adapters = Object.fromEntries(AGENTS.map((a) => [a.name, a]));
  const results = evaluate({
    sessions, panes, procs, adapters,
    protect: protectedPids(procs), selfTty: currentTty(procs), days: o.days, only: o.only,
  });
  if (o.only && !results.length) { log(`nothing matches --only ${o.only}`); return 1; }

  for (const r of results) {
    const s = r.session;
    const where = r.pane ? `${r.pane.connector} ${r.pane.id} "${r.pane.label}"` : (s.tty || 'no tty');
    const idle = r.idle == null ? '' : ` idle ${r.idle.toFixed(1)}d`;
    if (r.ok) {
      r.method = parkMethod(s, r.pane, procs, env);
      log(`${o.apply ? 'SNOOZING' : 'WOULD-SNOOZE'} ${s.agent} pid ${s.pid} ${s.sessionId.slice(0, 8)} [${where}]${idle} mem ${r.memMb}MB park=${r.method}`);
    } else {
      log(`SKIP ${s.agent} pid ${s.pid} ${s.sessionId.slice(0, 8)} [${where}]${idle}: ${r.reason}`);
    }
  }
  const cands = results.filter((r) => r.ok);
  if (!o.apply) { log(`dry run: ${cands.length} of ${results.length} would be snoozed (add --apply)`); return 0; }

  let done = 0, freed = 0;
  for (const c of cands) {
    const res = snooze(c, { procs, env, log, run });
    if (res.ok) { done++; freed += res.freedMb || 0; }
  }
  log(`done: snoozed ${done} of ${cands.length}, freed ~${freed}MB`);
  return done === cands.length ? 0 : 1;
}

function listCmd() {
  const parked = listParked();
  if (!parked.length) { console.log('No snoozed sessions.'); return 0; }
  for (const p of parked) console.log(`${p.tty}  ${p.agent} ${p.sessionId}  "${p.label}"  parked ${p.parkedAt} via ${p.method}\n    resume: ${resumeLine(p)}`);
  return 0;
}

export async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`agent-snooze: ${e.message}\n\n${HELP}`); return 2; }
  switch (o.cmd) {
    case 'help': console.log(HELP); return 0;
    case 'list': return listCmd();
    case 'wake': return wake({ tty: o.tty, now: o.now, emit: o.emit, lazy: o.lazy, shell: o.wakeShell, log: makeLogger({ mode: 'WAKE', quiet: true }) });
    case 'init': {
      const s = initSnippet(o.shell);
      if (!s) { console.error('usage: agent-snooze init zsh|bash|fish'); return 2; }
      process.stdout.write(s);
      return 0;
    }
    default: return snoozeCmd(o);
  }
}
