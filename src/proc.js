// Process table helpers. All parsing is pure so it can be unit tested with fixtures.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { normTty } from './tty.js';

export function run(cmd, args, { timeout = 15_000, env = process.env } = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8', timeout, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() || String(e.message) };
  }
}

const PS_RE = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/;

/** Parse `ps -axo pid=,ppid=,pcpu=,rss=,tty=,comm=` into Map<pid, row>. */
export function parsePs(stdout) {
  const rows = new Map();
  for (const line of stdout.split('\n')) {
    const m = PS_RE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    rows.set(pid, {
      pid,
      ppid: Number(m[2]),
      cpu: Number(m[3].replace(',', '.')),
      rssKb: Number(m[4]),
      tty: normTty(m[5]),
      comm: m[6].trim(),
      name: path.basename(m[6].trim()).replace(/^-/, ''),
    });
  }
  return rows;
}

export function readProcs(runFn = run) {
  const r = runFn('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,tty=,comm=']);
  return parsePs(r.stdout || '');
}

/** pid itself plus every parent up to init. */
export function ancestors(procs, pid) {
  const out = new Set();
  let p = pid;
  while (p > 1 && !out.has(p)) {
    out.add(p);
    const row = procs.get(p);
    if (!row) break;
    p = row.ppid;
  }
  return out;
}

export function descendants(procs, pid) {
  const kids = new Map();
  for (const row of procs.values()) {
    if (!kids.has(row.ppid)) kids.set(row.ppid, []);
    kids.get(row.ppid).push(row.pid);
  }
  const out = new Set();
  const stack = [...(kids.get(pid) || [])];
  while (stack.length) {
    const c = stack.pop();
    if (out.has(c)) continue;
    out.add(c);
    stack.push(...(kids.get(c) || []));
  }
  return out;
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function waitFor(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    sleepMs(stepMs);
  }
  return fn();
}
