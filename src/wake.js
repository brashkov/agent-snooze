// `agent-snooze wake`: find this terminal's parked session and resume it.
import fs from 'node:fs';
import readline from 'node:readline';
import { spawnSync, execFileSync } from 'node:child_process';
import { readProcs } from './proc.js';
import { normTty, ttyKey } from './tty.js';
import { readParked, removeParked, q, fishQ, wakeTypedLine } from './park.js';

/** This process's controlling terminal. */
export function currentTty(procs = readProcs()) {
  const own = procs.get(process.pid)?.tty;
  if (own) return own;
  try { return normTty(execFileSync('tty', { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' }).trim()); } catch { return null; }
}

function ask(prompt, output) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(true);
    const rl = readline.createInterface({ input: process.stdin, output });
    let done = false;
    const finish = (v) => { if (!done) { done = true; rl.close(); resolve(v); } };
    rl.on('SIGINT', () => finish(false));
    rl.on('close', () => finish(false));
    rl.question(prompt, () => finish(true));
  });
}

/** Shell line that resumes a parked record (cwd + argv, single-quoted). */
export const resumeLine = (rec, shell = 'posix') => {
  const qq = shell === 'fish' ? fishQ : q;
  return `cd ${qq(rec.resume.cwd)} && ${rec.resume.argv.map(qq).join(' ')}`;
};

/**
 * emit=true: talk to the user on stderr and print only the resume line on stdout, for `eval "$(... wake --emit)"`.
 * The agent then runs as the shell's own child, with no Node process left in between.
 */
export async function wake({ tty = null, now = false, emit = false, lazy = false, shell = 'posix', env = process.env, log }) {
  const say = (m) => (emit ? process.stderr : process.stdout).write(m + '\n');
  const dev = normTty(tty) || currentTty();
  const key = ttyKey(dev);
  const rec = key && readParked(key, env);
  if (!rec) { say(`Nothing is snoozed on this terminal${dev ? ` (${dev})` : ''}.`); return 1; }
  const line = resumeLine(rec, shell);

  // --lazy: print the shell-only waiting line (printf + read, then wake --now) without touching the record.
  // Used by the shell hook, so even there Node exits at once and the shell waits.
  if (lazy) { process.stdout.write(wakeTypedLine(rec, shell === 'fish' ? 'fish' : 'posix') + '\n'); return 0; }

  if (!now) {
    const out = emit ? process.stderr : process.stdout;
    if (out.isTTY) out.write('\x1b[H\x1b[2J\x1b[3J');
    const yes = await ask(`💤 ${rec.label} is asleep (idle ${rec.idleDays}d). Press Enter to resume, Ctrl-C to dismiss. `, out);
    if (!yes) {
      removeParked(key, env);
      log(`DISMISS ${rec.agent} ${rec.sessionId} on ${dev}`);
      say(`\nDismissed. Resume later with:\n  ${line}`);
      return 130;
    }
  }
  if (!fs.existsSync(rec.resume.cwd)) {
    say(`The session's folder is gone: ${rec.resume.cwd}\nResume by hand with: ${line}`);
    return 1;
  }
  removeParked(key, env);
  log(`WAKE ${rec.agent} ${rec.sessionId} on ${dev}${emit ? ' (shell eval)' : ''}`);
  if (emit) { process.stdout.write(line + '\n'); return 0; }
  process.on('SIGINT', () => {}); // Ctrl-C belongs to the agent now
  const r = spawnSync(rec.resume.argv[0], rec.resume.argv.slice(1), { cwd: rec.resume.cwd, stdio: 'inherit', env });
  if (r.error) { say(`Could not start ${rec.resume.argv[0]}: ${r.error.message}\nResume by hand with: ${line}`); return 1; }
  return r.status ?? 0;
}
